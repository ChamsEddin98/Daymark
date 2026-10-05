/**
 * In-process fake of the Google OAuth + Calendar v3 endpoints this package uses.
 * Response shapes follow the real API (kind/etag/id/status, error envelope, nextPageToken).
 * Deliberately returns dateTime normalized to UTC ("...Z") like Google normalizes to the
 * calendar zone, so clients must compare instants, not strings. It also stores WHOLE SECONDS, as
 * Google does: anything finer is dropped on write. A client that sends a fractional second would
 * therefore read back a different instant than it wrote, and would re-patch that event on every
 * sync - keeping the fake faithful here is what makes that class of bug visible to tests.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

export interface FakeEvent extends Json {
  id: string;
  status: "confirmed" | "cancelled";
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
}

interface FakeCalendar {
  id: string;
  summary: string;
  timeZone: string;
  description?: string;
  deleted: boolean;
  events: Map<string, FakeEvent>;
}

export interface LoggedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  status: number;
}

interface Fault {
  remaining: number;
  status: number;
  method?: string;
  pathIncludes?: string;
  retryAfter?: string;
}

const CLIENT_ID = "fake-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "fake-secret";

const b64url = (b: Buffer) => b.toString("base64url");
const googleId = () => {
  const alphabet = "abcdefghijklmnopqrstuv0123456789";
  let s = "";
  for (const byte of randomBytes(26)) s += alphabet[byte % 32];
  return s;
};

function apiError(code: number, message: string, reason: string, domain = "global") {
  return { error: { code, message, errors: [{ domain, reason, message }] } };
}

function deepMerge(target: Json, patch: Json): Json {
  const out: Json = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] !== null && !Array.isArray(out[k]))
      out[k] = deepMerge(out[k] as Json, v as Json);
    else out[k] = v;
  }
  return out;
}

const utc = (s: string) => new Date(Math.floor(Date.parse(s) / 1000) * 1000).toISOString().replace(/\.000Z$/, "Z");

export class FakeGoogle {
  readonly clientId = CLIENT_ID;
  readonly clientSecret = CLIENT_SECRET;
  readonly calendars = new Map<string, FakeCalendar>();
  readonly requests: LoggedRequest[] = [];
  readonly accessTokens = new Set<string>();
  readonly refreshTokens = new Set<string>();
  /** Last query received by the consent endpoint. */
  lastAuthParams?: URLSearchParams;
  private codes = new Map<string, { challenge: string; method: string; redirectUri: string; scope: string }>();
  private faults: Fault[] = [];
  private server: Server;
  private seq = 0;
  origin = "";

  constructor() {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.send(res, req, 500, apiError(500, String(err), "backendError"));
      });
    });
  }

  get calendarBaseUrl() {
    return `${this.origin}/calendar/v3`;
  }
  get endpoints() {
    return { oauth2TokenUrl: `${this.origin}/token`, oauth2AuthBaseUrl: `${this.origin}/o/oauth2/v2/auth` };
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /**
   * A calendar that already exists because its owner made it in the Google Calendar UI and shared it
   * with the planner's credential - the `CALENDAR_ID` arrangement, where the planner never creates
   * one. Returns the id so a test can configure it.
   */
  addCalendar(id: string, summary = "Study plan", timeZone = "Africa/Tunis"): string {
    this.calendars.set(id, { id, summary, timeZone, deleted: false, events: new Map() });
    return id;
  }

  /** A valid bearer token (as if obtained via the OAuth flow). */
  issueAccessToken(): string {
    const t = `ya29.fake-${randomBytes(12).toString("hex")}`;
    this.accessTokens.add(t);
    return t;
  }
  issueRefreshToken(): string {
    const t = `1//fake-refresh-${randomBytes(12).toString("hex")}`;
    this.refreshTokens.add(t);
    return t;
  }

  /** The next `count` matching requests fail with `status`. */
  injectFault(f: { count: number; status: number; method?: string; pathIncludes?: string; retryAfter?: string }) {
    this.faults.push({ remaining: f.count, ...f });
  }

  /** Events (not cancelled) of a calendar. */
  liveEvents(calendarId: string): FakeEvent[] {
    return [...(this.calendars.get(calendarId)?.events.values() ?? [])].filter((e) => e.status === "confirmed");
  }

  /** What a calendar is called, for the rename tests. */
  calendarSummary(calendarId: string): string | undefined {
    return this.calendars.get(calendarId)?.summary;
  }

  /** Simulates the user deleting the calendar in the Google Calendar UI. */
  deleteCalendarExternally(calendarId: string) {
    const c = this.calendars.get(calendarId);
    if (c) c.deleted = true;
  }

  /** Adds an event not created by the planner (no plannerKey) or with arbitrary props. */
  addEvent(calendarId: string, body: Json): FakeEvent {
    const cal = this.calendars.get(calendarId)!;
    const ev = this.makeEvent(cal, body);
    cal.events.set(ev.id, ev);
    return ev;
  }

  /** Mutating requests to the events collection. */
  eventWrites(): LoggedRequest[] {
    return this.requests.filter((r) => r.method !== "GET" && r.path.includes("/events"));
  }
  resetLog() {
    this.requests.length = 0;
  }

  // ---------------------------------------------------------------------------------------

  private send(res: ServerResponse, req: IncomingMessage, status: number, body?: unknown, headers: Record<string, string> = {}) {
    const u = new URL(req.url ?? "/", "http://x");
    this.requests.push({ method: req.method ?? "GET", path: u.pathname, query: u.searchParams, status });
    if (body === undefined) {
      res.writeHead(status, headers).end();
      return;
    }
    res.writeHead(status, { "content-type": "application/json; charset=UTF-8", ...headers }).end(JSON.stringify(body));
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  private makeEvent(cal: FakeCalendar, body: Json, id = googleId()): FakeEvent {
    const now = new Date().toISOString();
    const ev = {
      kind: "calendar#event",
      etag: `"${++this.seq}"`,
      id,
      status: "confirmed",
      htmlLink: `https://www.google.com/calendar/event?eid=${Buffer.from(`${id} ${cal.id}`).toString("base64url")}`,
      created: now,
      updated: now,
      creator: { email: "me@example.com", self: true },
      organizer: { email: cal.id, displayName: cal.summary, self: true },
      iCalUID: `${id}@google.com`,
      sequence: 0,
      eventType: "default",
      reminders: { useDefault: true },
      ...body,
    } as unknown as FakeEvent;
    return this.normalize(ev);
  }

  private normalize(ev: FakeEvent): FakeEvent {
    ev.start = { ...ev.start, dateTime: utc(ev.start.dateTime) };
    ev.end = { ...ev.end, dateTime: utc(ev.end.dateTime) };
    if (ev.transparency === "opaque") delete ev.transparency; // Google omits the default
    return ev;
  }

  private validateEvent(body: Json): string | undefined {
    const s = body.start as Json | undefined;
    const e = body.end as Json | undefined;
    if (!s?.dateTime || !e?.dateTime) return "Missing time zone definition for start time.";
    if (Number.isNaN(Date.parse(String(s.dateTime))) || Number.isNaN(Date.parse(String(e.dateTime)))) return "Bad Request";
    if (Date.parse(String(e.dateTime)) < Date.parse(String(s.dateTime))) return "The specified time range is empty.";
    const src = body.source as Json | undefined;
    if (src && !/^https?:\/\//.test(String(src.url))) return "Invalid source url";
    return undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? "/", this.origin);
    const method = req.method ?? "GET";
    const path = u.pathname;

    // fault injection
    const fault = this.faults.find(
      (f) => f.remaining > 0 && (!f.method || f.method === method) && (!f.pathIncludes || path.includes(f.pathIncludes)),
    );
    if (fault) {
      fault.remaining--;
      const reason = fault.status === 429 ? "rateLimitExceeded" : "backendError";
      await this.readBody(req);
      return this.send(res, req, fault.status, apiError(fault.status, fault.status === 429 ? "Rate Limit Exceeded" : "Backend Error", reason, fault.status === 429 ? "usageLimits" : "global"), fault.retryAfter ? { "retry-after": fault.retryAfter } : {});
    }

    // ---- OAuth
    if (path === "/o/oauth2/v2/auth" && method === "GET") {
      this.lastAuthParams = u.searchParams;
      const q = u.searchParams;
      if (q.get("client_id") !== CLIENT_ID) return this.send(res, req, 400, { error: "invalid_client" });
      const code = `4/fake-code-${randomBytes(8).toString("hex")}`;
      this.codes.set(code, {
        challenge: q.get("code_challenge") ?? "",
        method: q.get("code_challenge_method") ?? "plain",
        redirectUri: q.get("redirect_uri") ?? "",
        scope: q.get("scope") ?? "",
      });
      const redirect = new URL(q.get("redirect_uri")!);
      redirect.searchParams.set("state", q.get("state") ?? "");
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("scope", q.get("scope") ?? "");
      return this.send(res, req, 302, undefined, { location: redirect.toString() });
    }
    if (path === "/token" && method === "POST") {
      const form = new URLSearchParams(await this.readBody(req));
      if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET)
        return this.send(res, req, 401, { error: "invalid_client", error_description: "The OAuth client was not found." });
      if (form.get("grant_type") === "authorization_code") {
        const entry = this.codes.get(form.get("code") ?? "");
        if (!entry) return this.send(res, req, 400, { error: "invalid_grant", error_description: "Malformed auth code." });
        this.codes.delete(form.get("code")!);
        if (entry.redirectUri !== form.get("redirect_uri"))
          return this.send(res, req, 400, { error: "redirect_uri_mismatch", error_description: "Bad Request" });
        const verifier = form.get("code_verifier") ?? "";
        const computed = b64url(createHash("sha256").update(verifier).digest());
        if (entry.method !== "S256" || computed !== entry.challenge)
          return this.send(res, req, 400, { error: "invalid_grant", error_description: "Invalid code verifier." });
        return this.send(res, req, 200, {
          access_token: this.issueAccessToken(),
          expires_in: 3599,
          refresh_token: this.issueRefreshToken(),
          scope: entry.scope,
          token_type: "Bearer",
        });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (!this.refreshTokens.has(form.get("refresh_token") ?? ""))
          return this.send(res, req, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        return this.send(res, req, 200, {
          access_token: this.issueAccessToken(),
          expires_in: 3599,
          scope: "https://www.googleapis.com/auth/calendar.app.created",
          token_type: "Bearer",
        });
      }
      return this.send(res, req, 400, { error: "unsupported_grant_type" });
    }

    // ---- Calendar v3
    if (!path.startsWith("/calendar/v3/")) return this.send(res, req, 404, apiError(404, "Not Found", "notFound"));
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ") || !this.accessTokens.has(auth.slice(7))) {
      await this.readBody(req);
      return this.send(res, req, 401, apiError(401, "Request had invalid authentication credentials.", "authError"), {
        "www-authenticate": 'Bearer realm="https://accounts.google.com/"',
      });
    }
    const parts = path.slice("/calendar/v3/".length).split("/").map(decodeURIComponent);
    const rawBody = await this.readBody(req);
    let body: Json = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody) as Json;
      } catch {
        return this.send(res, req, 400, apiError(400, "Parse Error", "parseError"));
      }
    }
    if (parts[0] !== "calendars") return this.send(res, req, 404, apiError(404, "Not Found", "notFound"));

    // POST /calendars
    if (parts.length === 1 && method === "POST") {
      if (!body.summary) return this.send(res, req, 400, apiError(400, "Missing title.", "required"));
      const id = `${randomBytes(20).toString("hex")}@group.calendar.google.com`;
      const cal: FakeCalendar = {
        id,
        summary: String(body.summary),
        timeZone: String(body.timeZone ?? "UTC"),
        description: body.description as string | undefined,
        deleted: false,
        events: new Map(),
      };
      this.calendars.set(id, cal);
      return this.send(res, req, 200, this.calendarJson(cal));
    }
    const cal = this.calendars.get(parts[1] ?? "");
    if (!cal || cal.deleted) return this.send(res, req, 404, apiError(404, "Not Found", "notFound"));

    // GET/PATCH/DELETE /calendars/{id}
    if (parts.length === 2) {
      if (method === "GET") return this.send(res, req, 200, this.calendarJson(cal));
      // PATCH: how a calendar the planner owns gets renamed when the setting changes.
      if (method === "PATCH") {
        if (body.summary !== undefined) {
          if (!body.summary) return this.send(res, req, 400, apiError(400, "Missing title.", "required"));
          cal.summary = String(body.summary);
        }
        if (body.timeZone !== undefined) cal.timeZone = String(body.timeZone);
        if (body.description !== undefined) cal.description = body.description as string | undefined;
        return this.send(res, req, 200, this.calendarJson(cal));
      }
      if (method === "DELETE") {
        cal.deleted = true;
        return this.send(res, req, 204);
      }
      return this.send(res, req, 405, apiError(405, "Method Not Allowed", "httpMethodNotAllowed"));
    }
    if (parts[2] !== "events") return this.send(res, req, 404, apiError(404, "Not Found", "notFound"));

    // /calendars/{id}/events
    if (parts.length === 3) {
      if (method === "GET") return this.listEvents(req, res, cal, u.searchParams);
      if (method === "POST") {
        const err = this.validateEvent(body);
        if (err) return this.send(res, req, 400, apiError(400, err, "badRequest"));
        const ev = this.makeEvent(cal, body);
        cal.events.set(ev.id, ev);
        return this.send(res, req, 200, ev);
      }
      return this.send(res, req, 405, apiError(405, "Method Not Allowed", "httpMethodNotAllowed"));
    }

    // /calendars/{id}/events/{eventId}
    const ev = cal.events.get(parts[3] ?? "");
    if (!ev) return this.send(res, req, 404, apiError(404, "Not Found", "notFound"));
    if (method === "GET") return this.send(res, req, 200, ev);
    if (ev.status === "cancelled") return this.send(res, req, 410, apiError(410, "Resource has been deleted", "deleted"));
    if (method === "PATCH") {
      const merged = deepMerge(ev, body) as FakeEvent;
      const err = this.validateEvent(merged);
      if (err) return this.send(res, req, 400, apiError(400, err, "badRequest"));
      merged.id = ev.id;
      merged.etag = `"${++this.seq}"`;
      merged.updated = new Date().toISOString();
      merged.sequence = Number(ev.sequence ?? 0) + 1;
      const norm = this.normalize(merged);
      cal.events.set(ev.id, norm);
      return this.send(res, req, 200, norm);
    }
    if (method === "DELETE") {
      ev.status = "cancelled";
      return this.send(res, req, 204);
    }
    return this.send(res, req, 405, apiError(405, "Method Not Allowed", "httpMethodNotAllowed"));
  }

  private calendarJson(cal: FakeCalendar) {
    return {
      kind: "calendar#calendar",
      etag: `"cal-${cal.id.slice(0, 8)}"`,
      id: cal.id,
      summary: cal.summary,
      ...(cal.description ? { description: cal.description } : {}),
      timeZone: cal.timeZone,
      conferenceProperties: { allowedConferenceSolutionTypes: ["hangoutsMeet"] },
    };
  }

  private listEvents(req: IncomingMessage, res: ServerResponse, cal: FakeCalendar, q: URLSearchParams) {
    const timeMin = q.get("timeMin");
    const timeMax = q.get("timeMax");
    for (const t of [timeMin, timeMax]) {
      if (t && !/[zZ]|[+-]\d\d:\d\d$/.test(t)) return this.send(res, req, 400, apiError(400, "Bad Request", "badRequest"));
    }
    const filters = q.getAll("privateExtendedProperty").map((f) => {
      const i = f.indexOf("=");
      return [f.slice(0, i), f.slice(i + 1)] as const;
    });
    const showDeleted = q.get("showDeleted") === "true";
    const maxResults = Math.min(2500, Math.max(1, Number(q.get("maxResults") ?? 250)));
    const offset = q.get("pageToken") ? Number(Buffer.from(q.get("pageToken")!, "base64url").toString()) : 0;
    if (!Number.isFinite(offset)) return this.send(res, req, 400, apiError(400, "Invalid page token", "invalid"));

    const all = [...cal.events.values()]
      .filter((e) => showDeleted || e.status === "confirmed")
      .filter((e) => !timeMin || Date.parse(e.end.dateTime) > Date.parse(timeMin))
      .filter((e) => !timeMax || Date.parse(e.start.dateTime) < Date.parse(timeMax))
      .filter((e) => filters.every(([k, v]) => e.extendedProperties?.private?.[k] === v))
      .sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime) || a.id.localeCompare(b.id));
    const page = all.slice(offset, offset + maxResults);
    const next = offset + maxResults < all.length ? Buffer.from(String(offset + maxResults)).toString("base64url") : undefined;
    return this.send(res, req, 200, {
      kind: "calendar#events",
      etag: `"list-${this.seq}"`,
      summary: cal.summary,
      description: cal.description ?? "",
      updated: new Date().toISOString(),
      timeZone: cal.timeZone,
      accessRole: "owner",
      defaultReminders: [],
      ...(next ? { nextPageToken: next } : { nextSyncToken: `sync-${this.seq}` }),
      items: page,
    });
  }
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  return new FakeGoogle().start();
}
