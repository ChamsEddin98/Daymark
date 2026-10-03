/**
 * The service-account credential and the owner-supplied calendar (`CALENDAR_ID`).
 *
 * The arrangement these cover: instead of the planner creating and owning a calendar through an
 * OAuth grant on the owner's account, the owner creates a calendar, shares it with the service
 * account's email, and the planner writes into it with a credential that never expires. The two
 * failure modes worth testing are both silent ones — using the wrong credential file without saying
 * so, and creating a calendar nobody can see.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OAuth2Client } from "google-auth-library";
import {
  CALENDAR_EVENTS_SCOPE,
  CalendarNotFoundError,
  NotAuthorizedError,
  authMode,
  ensureCalendar,
  loadClient,
  loadServiceAccountClient,
  readServiceAccount,
  syncPlan,
  writeToken,
} from "../src/index.ts";
import { calendarIdFromEnv } from "../../store/src/paths.ts";
import { startFakeGoogle, type FakeGoogle } from "./fake-google.ts";
import { TZ, WINDOW, fakeClient, makeItems, noSleep } from "./helpers.ts";

let dir: string;
/** A real RSA key, because the JWT client parses the PEM when it is constructed. */
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const keyFile = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "service_account",
    project_id: "test-project",
    client_email: "planner@test-project.iam.gserviceaccount.com",
    private_key: pem,
    token_uri: "https://oauth2.googleapis.com/token",
    ...over,
  });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "planner-sa-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const path = (name: string) => join(dir, name);
const write = (name: string, body: string) => {
  writeFileSync(path(name), body, "utf8");
  return path(name);
};

describe("reading a service-account key", () => {
  it("returns undefined when there is no key, so OAuth can still be used", () => {
    expect(readServiceAccount(path("absent.json"))).toBeUndefined();
  });

  it("reads a valid key", () => {
    const key = readServiceAccount(write("good.json", keyFile()));
    expect(key?.client_email).toBe("planner@test-project.iam.gserviceaccount.com");
    expect(key?.private_key).toContain("BEGIN PRIVATE KEY");
  });

  it("refuses the OAuth client file, which is the easy mix-up", () => {
    // What you get from "Download JSON" on an OAuth client. Same folder, same shape, wrong thing.
    const p = write("client.json", JSON.stringify({ installed: { client_id: "x.apps.googleusercontent.com", client_secret: "y" } }));
    const e = (() => {
      try {
        readServiceAccount(p);
      } catch (err) {
        return err as NotAuthorizedError;
      }
    })();
    expect(e).toBeInstanceOf(NotAuthorizedError);
    expect(e!.message).toContain("not a service-account key");
    expect(e!.hint).toContain("Keys");
  });

  it("refuses a key that is present but unusable, instead of silently falling back", () => {
    // Silence here would be the worst answer: the owner installed a key and would be left wondering
    // why the planner still asks for a weekly re-auth.
    for (const [name, body] of [
      ["broken.json", "{ not json"],
      ["noemail.json", keyFile({ client_email: undefined })],
      ["nokey.json", keyFile({ private_key: undefined })],
      ["notpem.json", keyFile({ private_key: "hunter2" })],
    ] as [string, string][])
      expect(() => readServiceAccount(write(name, body)), name).toThrow(NotAuthorizedError);
  });
});

describe("which credential gets used", () => {
  beforeEach(() => {
    rmSync(path("google-token.json"), { force: true });
    rmSync(path("google-service-account.json"), { force: true });
  });

  const paths = () => ({ tokenPath: path("google-token.json"), serviceAccountPath: path("google-service-account.json") });

  it("none, when there is neither a key nor a token", () => {
    expect(authMode(paths())).toEqual({ mode: "none" });
    expect(() => loadClient(paths())).toThrow(NotAuthorizedError);
  });

  it("oauth, when only a token is there", () => {
    writeToken(path("google-token.json"), { refresh_token: "r", access_token: "a" });
    expect(authMode(paths()).mode).toBe("oauth");
    const client = loadClient({ ...paths(), clientId: "id", clientSecret: "secret" });
    expect(client.constructor.name).toBe("OAuth2Client");
  });

  it("the service account wins over a token that is also there", () => {
    writeToken(path("google-token.json"), { refresh_token: "r", access_token: "a" });
    write("google-service-account.json", keyFile());
    const mode = authMode(paths());
    expect(mode.mode).toBe("service-account");
    expect(mode.mode === "service-account" && mode.clientEmail).toBe("planner@test-project.iam.gserviceaccount.com");
    // Installing a key is a deliberate act; it means "stop using the token that expires".
    expect(loadClient({ ...paths(), clientId: "id", clientSecret: "secret" }).constructor.name).toBe("JWT");
  });

  it("allowServiceAccount: false keeps the OAuth path for the CLI that creates the token", () => {
    writeToken(path("google-token.json"), { refresh_token: "r", access_token: "a" });
    write("google-service-account.json", keyFile());
    expect(authMode({ ...paths(), allowServiceAccount: false }).mode).toBe("oauth");
    expect(loadClient({ ...paths(), clientId: "id", clientSecret: "secret", allowServiceAccount: false }).constructor.name).toBe("OAuth2Client");
  });

  it("asks only for events on calendars it can already see", () => {
    const client = loadServiceAccountClient({ keyPath: write("scoped.json", keyFile()) });
    // Not `calendar`, and not `calendar.app.created`: this scope cannot call calendars.insert, which
    // is what makes "create a calendar the owner cannot see" impossible rather than merely avoided.
    expect(client.scopes).toEqual([CALENDAR_EVENTS_SCOPE]);
    expect(CALENDAR_EVENTS_SCOPE).toBe("https://www.googleapis.com/auth/calendar.events");
    expect(client.email).toBe("planner@test-project.iam.gserviceaccount.com");
  });
});

describe("CALENDAR_ID from the environment", () => {
  it("takes either name, trims it, and treats blank as absent", () => {
    expect(calendarIdFromEnv({})).toBeUndefined();
    expect(calendarIdFromEnv({ CALENDAR_ID: "  " })).toBeUndefined();
    expect(calendarIdFromEnv({ CALENDAR_ID: " abc@group.calendar.google.com " })).toBe("abc@group.calendar.google.com");
    expect(calendarIdFromEnv({ PLANNER_CALENDAR_ID: "p" })).toBe("p");
    // The prefixed name wins, as it does for every other PLANNER_* variable.
    expect(calendarIdFromEnv({ PLANNER_CALENDAR_ID: "p", CALENDAR_ID: "c" })).toBe("p");
  });
});

describe("a calendar the planner does not own", () => {
  let fake: FakeGoogle;
  let client: OAuth2Client;

  beforeAll(async () => {
    fake = await startFakeGoogle();
  });
  afterAll(async () => {
    await fake.stop();
  });
  beforeEach(() => {
    client = fakeClient(fake);
    fake.resetLog();
  });

  /** `calendars.insert` calls: the request that must never happen for a calendar we were given. */
  const calendarInserts = (f: FakeGoogle) => f.requests.filter((r) => r.method === "POST" && /\/calendar\/v3\/calendars\/?$/.test(r.path));

  it("is used as given, and never created", async () => {
    let stored: string | undefined;
    const id = await ensureCalendar(client, {
      calendarId: "owner-made@group.calendar.google.com",
      timeZone: TZ,
      stateGet: () => stored,
      stateSet: (v) => {
        stored = v;
      },
    });
    expect(id).toBe("owner-made@group.calendar.google.com");
    // Recorded, so GET /sync/status can report the calendar actually in use...
    expect(stored).toBe("owner-made@group.calendar.google.com");
    // ...and nothing was inserted. A calendar the planner created would belong to the service
    // account, and an owned calendar does not appear in the owner's Google Calendar at all.
    expect(calendarInserts(fake)).toEqual([]);
  });

  it("a stored id from an earlier run does not override the configured one", async () => {
    let stored: string | undefined = "stale-from-before@group.calendar.google.com";
    const id = await ensureCalendar(client, {
      calendarId: "configured@group.calendar.google.com",
      timeZone: TZ,
      stateGet: () => stored,
      stateSet: (v) => {
        stored = v;
      },
    });
    expect(id).toBe("configured@group.calendar.google.com");
    expect(stored).toBe("configured@group.calendar.google.com");
  });

  it("a 404 is reported, not answered by making a replacement", async () => {
    // The owner removed the sharing, or CALENDAR_ID is a typo. Creating a new calendar here would
    // "work" for ever while the owner saw nothing appear, which is the one outcome to rule out.
    const err = await syncPlan(
      client,
      {
        calendarId: "never-shared@group.calendar.google.com",
        items: makeItems(2),
        window: WINDOW,
        timeZone: TZ,
        stateGet: () => undefined,
        stateSet: () => {},
      },
      { retry: noSleep },
    ).then(
      () => undefined,
      (e: unknown) => e as CalendarNotFoundError,
    );

    expect(err).toBeInstanceOf(CalendarNotFoundError);
    expect(err!.message).toContain("never-shared@group.calendar.google.com");
    expect(err!.message).toContain("CALENDAR_ID");
    // The message has to name the thing the owner must actually go and look at.
    expect(err!.message).toMatch(/shared|sharing/i);
    expect(calendarInserts(fake)).toEqual([]);
  });

  it("still syncs normally once it is reachable", async () => {
    let stored: string | undefined;
    const created = await ensureCalendar(client, {
      timeZone: TZ,
      stateGet: () => stored,
      stateSet: (v) => {
        stored = v;
      },
    });
    // Now pretend the owner gave us that same calendar by configuration instead.
    const r = await syncPlan(
      client,
      { calendarId: created, items: makeItems(3), window: WINDOW, timeZone: TZ, stateGet: () => undefined, stateSet: () => {} },
      { retry: noSleep },
    );
    expect(r.calendarId).toBe(created);
    expect(r.inserted).toBeGreaterThan(0);
    expect(r.errors).toEqual([]);
    const again = await syncPlan(
      client,
      { calendarId: created, items: makeItems(3), window: WINDOW, timeZone: TZ, stateGet: () => undefined, stateSet: () => {} },
      { retry: noSleep },
    );
    expect({ inserted: again.inserted, patched: again.patched, deleted: again.deleted }).toEqual({ inserted: 0, patched: 0, deleted: 0 });
  });
});
