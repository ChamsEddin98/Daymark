/**
 * The planner HTTP API (contract: docs/API.md). `createApi` wires store + plan service + sync + SSE
 * into a Fastify instance; `startApi` listens on 127.0.0.1 only.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { CalendarApiError, NotAuthorizedError, authMode, loadClient, type ReconcileOptions } from "@planner/calendar";
import { addDays, daysBetween, type ParseIssue } from "@planner/core";
import { DEFAULT_ACTIVE_HOURS } from "@planner/core";
import {
  NOTIFICATION_TYPES,
  PlanService,
  PlannerError,
  PlannerStore,
  calendarIdFromEnv,
  clockFromEnv,
  closest,
  dataDir as defaultDataDir,
  isDate,
  loadResources,
  resourcesDir as defaultResourcesDir,
  timeZoneFromEnv,
  type Clock,
} from "@planner/store";
import { EventBus } from "./sse.ts";
import { SyncManager, type ClientFactory } from "./sync.ts";
import { TaskFiles } from "./taskfiles.ts";

export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 4317;
export const WEB_ORIGINS = ["http://127.0.0.1:3417", "http://localhost:3417"];
const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

export interface ApiOptions {
  env?: Record<string, string | undefined>;
  dataDir?: string;
  resourcesDir?: string;
  clock?: Clock;
  timeZone?: string;
  horizon?: number;
  /** Google client factory; throw NotAuthorizedError when not connected. Default: a service-account key or the OAuth token in <dataDir>. */
  calendarClient?: ClientFactory;
  /** The calendar to sync into. Default: CALENDAR_ID / PLANNER_CALENDAR_ID, else the planner creates its own. */
  calendarId?: string;
  syncDebounceMs?: number;
  /** Passed to the calendar calls (tests: retry/sleep). */
  calendarOptions?: ReconcileOptions;
  /** Poll interval for rollover / changes made by the daemon / new notifications. 0 disables. Default 1000. */
  pollMs?: number;
  heartbeatMs?: number;
  logger?: boolean;
}

export interface Api {
  app: FastifyInstance;
  store: PlannerStore;
  service: PlanService;
  bus: EventBus;
  sync: SyncManager;
  /** The P9 write-back: plan and task mutations, and the one definition of "reload". */
  files: TaskFiles;
  taskFileErrors: ParseIssue[];
  close(): Promise<void>;
}

const HTTP: Record<string, number> = {
  INVALID_INPUT: 400,
  UNKNOWN_TASK: 404,
  UNKNOWN_ITEM: 404,
  NOT_FOUND: 404,
  FORBIDDEN_ORIGIN: 403,
  FORBIDDEN_HOST: 403,
  CONFLICT: 409,
  PAUSED: 409,
  TASK_FILE_ERRORS: 422,
  CALENDAR_ERROR: 502,
  CALENDAR_NOT_AUTHORIZED: 503,
  INTERNAL: 500,
};

function fail(reply: FastifyReply, code: string, message: string, hint: string, details?: unknown) {
  return reply.code(HTTP[code] ?? 500).send({ error: { code, message, hint, ...(details !== undefined ? { details } : {}) } });
}

const invalid = (message: string, hint: string) => new PlannerError("INVALID_INPUT", message, hint);

/**
 * A message from ANYTHING that was thrown. `throw null`, `throw "boom"` and objects with no `message`
 * are all legal JavaScript, and a dependency doing one of them must not be able to turn a read
 * endpoint into a 500 or an error response into something other than our envelope. Always a
 * non-empty string, so the diagnostic survives instead of reading "undefined".
 */
export function errMsg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  if (e === null) return "null was thrown";
  if (e === undefined) return "undefined was thrown";
  if (typeof e === "object") {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
    try {
      const j = JSON.stringify(e);
      if (j && j !== "{}") return j;
    } catch {
      /* circular or a throwing getter */
    }
  }
  try {
    return String(e) || `${typeof e} was thrown`;
  } catch {
    return `${typeof e} was thrown`;
  }
}

function intParam(v: unknown, name: string, def: number, min: number, max: number): number {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${name} must be an integer from ${min} to ${max}; got ${JSON.stringify(v)}`, `For example ?${name}=${def}.`);
  return n;
}

function dateParam(v: unknown, name: string, def: string): string {
  if (v === undefined || v === "") return def;
  if (!isDate(v)) throw invalid(`${name} must be a date YYYY-MM-DD; got ${JSON.stringify(v)}`, `For example ${name}=${def}.`);
  return v;
}

function body(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  if (b === undefined || b === null || b === "") return {};
  if (typeof b !== "object" || Array.isArray(b)) throw invalid("body must be a JSON object", 'Send Content-Type: application/json with an object such as { "status": "done" }.');
  return b as Record<string, unknown>;
}

/**
 * The query parameters an endpoint has, refused rather than ignored when it is anything else. A
 * silently dropped `?dryrun=true` would turn a preview into a real delete, which is the same defect
 * class as the editor accepting a field it does not have.
 */
function query(req: FastifyRequest, allow: readonly string[]): Record<string, string | undefined> {
  const q = (req.query ?? {}) as Record<string, string | undefined>;
  for (const k of Object.keys(q)) {
    if (allow.includes(k)) continue;
    const near = closest(k, allow);
    throw invalid(
      `unknown query parameter "${k}"`,
      allow.length ? `${near ? `Did you mean ?${near}=? ` : ""}This endpoint takes ${allow.map((a) => `?${a}`).join(", ")}.` : "This endpoint takes no query parameters.",
    );
  }
  return q;
}

function flag(v: unknown, name: string): boolean {
  if (v === undefined) return false;
  if (v === true || v === "true" || v === "1" || v === "") return true;
  if (v === false || v === "false" || v === "0") return false;
  throw invalid(`${name} must be true or false; got ${JSON.stringify(v)}`, `Pass ?${name}=true, or "${name}": true in the body.`);
}

/**
 * A write-back request: `dryRun` from the body or the query, and the body **without** it, because
 * the editors reject a field they do not have - the whole point of them - and `dryRun` is ours, not
 * a task field.
 */
function writeBack(req: FastifyRequest, allow: readonly string[] = []): { input: Record<string, unknown>; dryRun: boolean; q: Record<string, string | undefined> } {
  const q = query(req, ["dryRun", ...allow]);
  const { dryRun, ...input } = body(req);
  return { input, dryRun: flag(dryRun ?? q.dryRun, "dryRun"), q };
}

export async function createApi(opts: ApiOptions = {}): Promise<Api> {
  const env = opts.env ?? process.env;
  const timeZone = opts.timeZone ?? timeZoneFromEnv(env);
  const clock = opts.clock ?? clockFromEnv(env, timeZone);
  const dir = opts.dataDir ?? defaultDataDir(env);
  const resDir = opts.resourcesDir ?? defaultResourcesDir(env);
  const horizon = opts.horizon ?? (env.PLANNER_HORIZON_DAYS ? Number(env.PLANNER_HORIZON_DAYS) : 7);
  const log = (msg: string) => {
    if (opts.logger !== false) console.error(`[api] ${msg}`);
  };

  const store = new PlannerStore({ dir });
  const loaded = loadResources(resDir);
  let taskFileErrors = loaded.errors;
  for (const e of loaded.errors) log(`task file error ${e.file}:${e.line}: ${e.message}`);
  const service = new PlanService({ store, clock, timeZone, horizon, files: loaded.files });
  service.ensureCurrent();

  const bus = new EventBus(opts.heartbeatMs ?? 15_000);
  const credentials = { tokenPath: join(dir, "google-token.json"), serviceAccountPath: join(dir, "google-service-account.json") };
  const factory: ClientFactory = opts.calendarClient ?? (() => loadClient(credentials));
  const calendarId = opts.calendarId ?? calendarIdFromEnv(env);
  const sync = new SyncManager(
    store,
    service,
    bus,
    factory,
    opts.syncDebounceMs ?? Number(env.PLANNER_SYNC_DEBOUNCE_MS ?? 2000),
    log,
    opts.calendarOptions,
    calendarId,
  );
  /**
   * Which credential is in play, for `/health` and `/sync/status`. Read from disk on each call so a
   * key dropped in while the service is running shows up without a restart, and never throws: a
   * malformed key file is a diagnostic, not a reason for a health check to fail.
   */
  const credentialMode = (): string => {
    if (opts.calendarClient) return "injected";
    try {
      return authMode(credentials).mode;
    } catch (e) {
      log(`credential unusable: ${errMsg(e)}`);
      return "invalid";
    }
  };

  // ---- change tracking (own mutations vs. the daemon's writes)
  let lastRev = store.planRev();
  let lastNotif = store.lastNotificationId();
  const allDates = () => {
    const today = service.today();
    return Array.from({ length: daysBetween(today, service.horizonEnd()) + 1 }, (_, i) => addDays(today, i));
  };
  const mutated = (dates: string[], reason: string, extra?: Record<string, unknown>) => {
    lastRev = store.planRev();
    bus.publish("plan", { dates: [...new Set(dates)].sort(), reason, ...extra });
    sync.queue();
  };
  /** A pause moves nothing, so it publishes the new state without queueing a calendar sync (P8 rule 6). */
  const froze = (reason: string) => {
    lastRev = store.planRev();
    bus.publish("plan", { dates: [], reason, paused: service.paused() });
  };
  // P9 write-back. It owns every write to resources/*.md, and the reload that follows one, which is
  // why POST /reload goes through it too: there is one definition of "re-read the files and re-plan".
  const files = new TaskFiles({
    resourcesDir: resDir,
    dataDir: dir,
    store,
    service,
    setErrors: (errors) => {
      taskFileErrors = errors;
    },
    announce: (dates, reason) => mutated(dates, reason),
    log,
  });

  const poll = () => {
    try {
      const rolled = service.ensureCurrent();
      if (rolled) mutated(allDates(), "rollover");
      const rev = store.planRev();
      if (rev !== lastRev) {
        lastRev = rev;
        bus.publish("plan", { dates: allDates(), reason: "external" });
      }
      const fresh = store.listNotifications(100, lastNotif).reverse();
      for (const n of fresh) {
        lastNotif = Math.max(lastNotif, n.id);
        const { id: _id, ...rest } = n;
        bus.publish("notification", rest);
      }
    } catch (e) {
      log(`poll failed: ${(e as Error).message}`);
    }
  };
  const pollMs = opts.pollMs ?? 1000;
  const pollTimer = pollMs > 0 ? setInterval(poll, pollMs) : undefined;
  pollTimer?.unref();

  // ---- fastify
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 1000 }, forceCloseConnections: true });
  const extraOrigins = (env.PLANNER_WEB_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const origins = [...WEB_ORIGINS, ...extraOrigins];
  // CSRF / DNS-rebinding guard: a browser request from another site carries an Origin header that is
  // not the web UI's, and a rebound DNS name shows up in Host. Both are refused before any handler runs.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.includes(origin))
      return fail(reply, "FORBIDDEN_ORIGIN", `Origin ${origin} is not allowed`, `Only the web UI (${origins.join(", ")}) may call this API from a browser; scripts and curl send no Origin header.`);
    const host = (req.headers.host ?? "").toLowerCase();
    const m = /^(127\.0\.0\.1|localhost)(?::(\d+))?$/.exec(host);
    const addr = app.server.address();
    const port = addr && typeof addr === "object" ? addr.port : undefined;
    if (!m || (port !== undefined && m[2] !== undefined && Number(m[2]) !== port))
      return fail(reply, "FORBIDDEN_HOST", `Host ${host || "(none)"} is not allowed`, `Call the API as http://127.0.0.1:${port ?? DEFAULT_PORT} (or localhost).`);
  });
  await app.register(cors, { origin: origins, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] });

  // Every error leaves here as `{ error: { code, message, hint } }` (CLAUDE.md), whatever was thrown:
  // a `throw null` deep in a dependency must not reach Fastify's default serializer, which would send
  // `{ statusCode, error, message }` instead and break every client that reads our envelope.
  app.setErrorHandler((err: FastifyError | Error | unknown, _req, reply) => {
    if (err instanceof PlannerError) return fail(reply, err.code, err.message, err.hint, err.details);
    if (err instanceof NotAuthorizedError) return fail(reply, "CALENDAR_NOT_AUTHORIZED", err.message, err.hint);
    if (err instanceof CalendarApiError)
      return fail(reply, "CALENDAR_ERROR", err.message, "Google Calendar failed after retries. Local state is saved; the sync is retried on the next change or POST /sync.", {
        status: err.status,
        reason: err.reason,
      });
    const message = errMsg(err);
    // A thrown primitive has no properties to read, so the status is probed defensively.
    const status = typeof err === "object" && err !== null ? (err as FastifyError).statusCode : undefined;
    if (typeof status === "number" && status >= 400 && status < 500)
      return fail(reply, "INVALID_INPUT", message, "Send a JSON object body with Content-Type: application/json (see docs/API.md).");
    log(`internal error: ${(err instanceof Error && err.stack) || message}`);
    return fail(reply, "INTERNAL", message, "This is a bug in the planner API; the request was not applied if it failed before saving.");
  });
  app.setNotFoundHandler((req, reply) =>
    fail(reply, "NOT_FOUND", `No route ${req.method} ${req.url.split("?")[0]}`, "See docs/API.md for the list of endpoints (GET /health, /today, /plan, /tasks, ...)."),
  );

  // ---------------------------------------------------------------- read

  /**
   * `sync.authorized()` rethrows anything that is not NotAuthorizedError (a corrupt token file, a bad
   * permission). That belongs in the answer to `POST /sync`, never in a health check: the two read
   * endpoints report "not authorized" and log it instead, so /health can never fail.
   */
  const authorizedSafe = (): boolean => {
    try {
      return sync.authorized();
    } catch (e) {
      log(`calendar client unavailable: ${errMsg(e)}`);
      return false;
    }
  };

  app.get("/health", async () => {
    const s = store.getSyncState();
    return {
      ok: true,
      version: VERSION,
      now: service.nowIso(),
      timeZone,
      tasksLoaded: service.tasks.length,
      taskFileErrors: taskFileErrors.length,
      anchor: service.anchor(),
      activeHours: service.activeHours(),
      horizon: { days: service.horizon, end: service.horizonEnd() },
      clock: clock.kind,
      paused: service.paused(),
      calendar: {
        authorized: authorizedSafe(),
        credential: credentialMode(),
        calendarId: calendarId ?? store.getCalendarId() ?? null,
        owned: !calendarId,
        lastSyncAt: s.lastSyncAt,
        lastError: s.lastError,
        pending: s.pending,
      },
    };
  });

  app.get("/today", async () => service.todayView());

  app.get("/plan", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const from = dateParam(q.from, "from", service.today());
    const days = intParam(q.days, "days", 7, 1, 120);
    return { days: service.range(from, days) };
  });

  app.get("/tasks", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return { tasks: service.listTasks({ track: q.track || undefined, status: q.status || undefined, type: q.type || undefined }) };
  });

  // Wildcard so both /tasks/bcg%2FA1 and /tasks/bcg/A1 work.
  app.get("/tasks/*", async (req) => service.getTask((req.params as Record<string, string>)["*"]!));

  app.get("/tracks", async () => ({ tracks: service.tracks() }));

  app.get("/plans", async (req) => {
    query(req, []);
    return files.listPlans();
  });

  app.get("/plans/:track", async (req) => {
    query(req, []);
    return files.readPlan((req.params as Record<string, string>).track!);
  });

  /**
   * The owner's active hours, and what they actually produce. `effective` matters because the three
   * settings constrain each other: asking for 10 h of task time inside an 08:00-20:00 window gets 8 h,
   * since every 4 h of work buys an hour of long rest and the window cannot clear the next step. A UI
   * that showed only the request would be lying about the plan.
   */
  app.get("/settings", async (req) => {
    query(req, []);
    const hours = service.activeHours();
    const days = service.range(service.today(), Math.min(service.horizon, 7));
    const taskMin = (d: (typeof days)[number]) =>
      d.items.filter((i) => i.kind === "task").reduce((n, i) => n + (Date.parse(i.end) - Date.parse(i.start)) / 60_000, 0);
    const full = days.filter((d) => d.date > service.today());
    return {
      activeHours: hours,
      defaults: DEFAULT_ACTIVE_HOURS,
      timeZone,
      effective: {
        /** Task minutes the coming full days actually hold; `null` until a day is materialized. */
        dailyTaskMin: full.length ? Math.max(...full.map(taskMin)) : null,
        /** Whether the window, rather than the budget, is what limits the day. */
        boundBy: full.length && Math.max(...full.map(taskMin)) < hours.dailyTaskMin ? "window" : "budget",
        lastEnd: full.length ? (full.map((d) => d.items.at(-1)?.end ?? null).filter(Boolean).sort().at(-1) ?? null) : null,
      },
    };
  });

  app.get("/backups", async (req) => {
    const q = query(req, ["track"]);
    return files.listBackups(q.track || undefined);
  });

  app.get("/calendar/events", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const from = dateParam(q.from, "from", service.today());
    const to = dateParam(q.to, "to", service.horizonEnd());
    if (to < from) throw invalid(`to (${to}) is before from (${from})`, "Pass from <= to.");
    return sync.listEvents(from, to);
  });

  app.get("/sync/status", async () => {
    const s = store.getSyncState();
    return {
      authorized: authorizedSafe(),
      credential: credentialMode(),
      calendarId: calendarId ?? store.getCalendarId() ?? null,
      /** false: the calendar is the owner's, given by CALENDAR_ID, and is never created or replaced. */
      owned: !calendarId,
      lastSyncAt: s.lastSyncAt,
      lastResult: s.lastResult,
      pending: s.pending,
      lastError: s.lastError,
      lastAttemptAt: s.lastAttemptAt,
    };
  });

  app.get("/notifications", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = intParam(q.limit, "limit", 50, 1, 1000);
    if (q.type && !NOTIFICATION_TYPES.includes(q.type as never))
      throw invalid(`type must be one of ${NOTIFICATION_TYPES.join(", ")}`, "Omit type to list every notification.");
    return store
      .listNotifications(q.type ? 1000 : limit)
      .filter((n) => !q.type || n.type === q.type)
      .slice(0, limit)
      .map(({ id: _id, ...n }) => n);
  });

  app.get("/events", (req, reply) => {
    reply.hijack();
    const headers: Record<string, string> = {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    };
    for (const [k, v] of Object.entries(reply.getHeaders())) if (typeof v === "string") headers[k] = v;
    reply.raw.writeHead(200, headers);
    reply.raw.write(`retry: 2000\n: connected ${service.nowIso()}\n\n`);
    bus.attach(reply.raw);
  });

  // ---------------------------------------------------------------- write

  const setItemStatus = (key: string, status: unknown) => {
    const r = service.setItemStatus(key, status as never);
    bus.publish("status", r.item ? { key: r.item.key, taskUid: r.item.taskUid, date: r.item.date, status: r.item.status } : { key, status, replanned: true });
    mutated([...(r.item ? [r.item.date] : []), ...r.regenerated], "status");
    return r;
  };

  app.post("/items/*", async (req) => {
    const path = (req.params as Record<string, string>)["*"]!;
    if (!path.endsWith("/status")) throw new PlannerError("INVALID_INPUT", `No route POST /items/${path}`, "Use POST /items/:key/status with the URL-encoded item key.");
    return setItemStatus(path.slice(0, -"/status".length), body(req).status);
  });

  app.post("/tasks/*", async (req) => {
    const path = (req.params as Record<string, string>)["*"]!;
    if (!path.endsWith("/status")) throw new PlannerError("INVALID_INPUT", `No route POST /tasks/${path}`, "Use POST /tasks/:uid/status with the URL-encoded uid, e.g. /tasks/bcg%2FA1/status.");
    const uid = path.slice(0, -"/status".length);
    const b = body(req);
    if (b.date !== undefined && typeof b.date !== "string") throw invalid("date must be a string YYYY-MM-DD", `For example "${service.today()}".`);
    const r = service.setTaskStatus(uid, b.status as never, b.date as string | undefined);
    bus.publish("status", { taskUid: uid, date: b.date ?? null, status: r.task.status, keys: r.items.map((i) => i.key) });
    mutated([...r.items.map((i) => i.date).filter((d) => d >= service.today()), ...r.regenerated], "status");
    return r;
  });

  // ---- P9 write-back: the Markdown is the source of truth, so these endpoints change the file and
  // the schedule in one call. Every one takes `dryRun` and answers with the same envelope
  // (docs/API.md, "Write-back"). The editing rules live in packages/core/src/taskfile/edit.ts.

  app.post("/plans", async (req) => {
    const { input, dryRun } = writeBack(req);
    return files.createPlan(input, dryRun);
  });

  app.patch("/plans/:track", async (req) => {
    const { input, dryRun } = writeBack(req);
    return files.patchPlan((req.params as Record<string, string>).track!, input, dryRun);
  });

  app.delete("/plans/:track", async (req) => {
    const { input, dryRun, q } = writeBack(req, ["confirm"]);
    if (Object.keys(input).length) throw invalid(`DELETE /plans/:track takes no body fields; got ${Object.keys(input).join(", ")}`, "Confirm with ?confirm=<track> in the query.");
    return files.deletePlan((req.params as Record<string, string>).track!, q.confirm, dryRun);
  });

  app.post("/tasks", async (req) => {
    const { input, dryRun } = writeBack(req);
    return files.createTask(input, dryRun);
  });

  // Wildcards, so both /tasks/bcg%2FA1 and /tasks/bcg/A1 work (as for the reads).
  app.patch("/tasks/*", async (req) => {
    const { input, dryRun } = writeBack(req);
    return files.patchTask((req.params as Record<string, string>)["*"]!, input, dryRun);
  });

  app.delete("/tasks/*", async (req) => {
    const { input, dryRun } = writeBack(req);
    if (Object.keys(input).length) throw invalid(`DELETE /tasks/:uid takes no body fields; got ${Object.keys(input).join(", ")}`, "To change a task instead of removing it, use PATCH /tasks/:uid.");
    return files.deleteTask((req.params as Record<string, string>)["*"]!, dryRun);
  });

  app.post("/backups/:name/restore", async (req) => {
    const { input, dryRun } = writeBack(req);
    if (Object.keys(input).length) throw invalid(`POST /backups/:name/restore takes no body fields; got ${Object.keys(input).join(", ")}`, "The snapshot name in the path is the whole request.");
    return files.restoreBackup((req.params as Record<string, string>).name!, dryRun);
  });

  /**
   * Change the active hours and re-plan. Today is rebuilt as well as the future, because the whole
   * point of the setting is when the day runs - leaving today on yesterday's window would make the
   * change look broken until tomorrow. Past and in-progress items keep their times, as they do for
   * every other rebuild of today.
   */
  app.patch("/settings", async (req) => {
    const { input, dryRun } = writeBack(req);
    if (dryRun) {
      // Validated, nothing stored: the same check the real call makes, so a preview that passes
      // cannot be followed by a commit that fails.
      const hours = service.validateActiveHours(input as never);
      return { activeHours: hours, regenerated: service.wouldReplan(service.today()), dryRun: true, sync: "skipped" };
    }
    const { hours, changed } = service.setActiveHours(input as never);
    if (!changed) return { activeHours: hours, regenerated: [], changed: false, sync: "skipped" };
    const regenerated = service.replan(service.today());
    mutated(regenerated, "settings");
    return { activeHours: hours, regenerated, changed: true, sync: "queued" };
  });

  const shiftBody = (req: FastifyRequest) => {
    const b = body(req);
    if (b.amount === undefined || b.unit === undefined) throw invalid("amount and unit are required", 'Send { "amount": 30, "unit": "minutes" } (unit: minutes, hours or days).');
    return b;
  };

  app.post("/plan/shift", async (req) => {
    const b = shiftBody(req);
    const r = service.shift(b.amount, b.unit);
    mutated(allDates(), "shift");
    return r;
  });

  app.post("/plan/shift/preview", async (req) => {
    const b = shiftBody(req);
    return service.shift(b.amount, b.unit, { dryRun: true });
  });

  // P8: freeze the plan where it stands, then push everything still to come forward by exactly how
  // long the pause ran. The shift/preview/regenerate refusal lives in the service, so it applies
  // after the request itself is validated and however the plan is reached.
  app.post("/plan/pause", async () => {
    const r = service.pause();
    froze("pause");
    return r;
  });

  app.post("/plan/resume", async () => {
    const r = service.resume();
    mutated(allDates(), "resume", { paused: null });
    return r;
  });

  app.post("/plan/regenerate", async (req) => {
    const b = body(req);
    const from = b.from === undefined ? addDays(service.today(), 1) : b.from;
    // The one action that may clear days off; it reports the dates it cleared (docs/PLAN.md, P7).
    const { regenerated, clearedDaysOff } = service.regenerate(from as string);
    mutated([...regenerated, ...clearedDaysOff], "regenerate");
    return { regenerated, clearedDaysOff };
  });

  app.post("/reload", async () => {
    const { loaded, regenerated } = files.reload();
    return { tasks: service.tasks.length, files: loaded.files.length, skipped: loaded.skipped, errors: [], regenerated };
  });

  app.post("/sync", async (req) => {
    const b = body(req);
    const from = dateParam(b.from, "from", service.today());
    const to = dateParam(b.to, "to", service.horizonEnd());
    if (to < from) throw invalid(`to (${to}) is before from (${from})`, "Pass from <= to.");
    const r = await sync.run(from, to);
    if (r.errors.length)
      throw new PlannerError(
        "CALENDAR_ERROR" as never,
        `${r.errors.length} calendar event write(s) failed after retries`,
        "Local state is saved. POST /sync again later; GET /sync/status shows the last error.",
        r,
      );
    return r;
  });

  app.addHook("preClose", async () => {
    if (pollTimer) clearInterval(pollTimer);
    sync.close();
    bus.close();
  });

  let closed = false;
  return {
    app,
    store,
    service,
    bus,
    sync,
    files,
    get taskFileErrors() {
      return taskFileErrors;
    },
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      await sync.flush().catch(() => {});
      store.close();
    },
  };
}

/** Listen on 127.0.0.1 only (the host is not configurable). Port 0 picks a free one. */
export async function startApi(opts: ApiOptions & { port?: number } = {}): Promise<Api & { url: string }> {
  const api = await createApi(opts);
  const env = opts.env ?? process.env;
  const port = opts.port ?? (env.PLANNER_API_PORT ? Number(env.PLANNER_API_PORT) : DEFAULT_PORT);
  const url = await api.app.listen({ host: HOST, port });
  const out = api as Api & { url: string };
  out.url = url.replace("localhost", HOST);
  return out;
}
