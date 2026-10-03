import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CALENDAR_SCOPE,
  NotAuthorizedError,
  authorize,
  ensureCalendar,
  jsonFileState,
  loadClient,
  reconcile,
} from "../src/index.ts";
import { startFakeGoogle, type FakeGoogle } from "./fake-google.ts";
import { TZ, WINDOW, makeItems } from "./helpers.ts";

let fake: FakeGoogle;
let dir: string;

beforeAll(async () => {
  fake = await startFakeGoogle();
  dir = mkdtempSync(join(tmpdir(), "planner-cal-"));
});
afterAll(async () => {
  await fake.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Plays the user's browser: follow the consent URL, then the redirect to the loopback server. */
async function browser(url: string) {
  const consent = await fetch(url, { redirect: "manual" });
  const location = consent.headers.get("location")!;
  const back = await fetch(location);
  expect(back.status).toBe(200);
}

describe("authorize (loopback + PKCE)", () => {
  it("runs the flow and writes the token file", async () => {
    const tokenPath = join(dir, "nested", "google-token.json");
    let printed = "";
    const token = await authorize({
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
      tokenPath,
      endpoints: fake.endpoints,
      onUrl: (u) => (printed = u),
      openBrowser: (u) => void browser(u),
    });
    const q = fake.lastAuthParams!;
    expect(printed.startsWith(fake.endpoints.oauth2AuthBaseUrl)).toBe(true);
    expect(q.get("scope")).toBe(CALENDAR_SCOPE);
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")).toBeTruthy();
    expect(q.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const onDisk = JSON.parse(readFileSync(tokenPath, "utf8"));
    expect(onDisk.refresh_token).toBe(token.refresh_token);
    expect(onDisk.access_token).toBeTruthy();
    if (process.platform !== "win32") expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("rejects a redirect with a wrong state", async () => {
    await expect(
      authorize({
        clientId: fake.clientId,
        clientSecret: fake.clientSecret,
        tokenPath: join(dir, "bad.json"),
        endpoints: fake.endpoints,
        openBrowser: async (u) => {
          const loc = new URL((await fetch(u, { redirect: "manual" })).headers.get("location")!);
          loc.searchParams.set("state", "forged");
          await fetch(loc);
        },
      }),
    ).rejects.toThrow(/state mismatch/);
  });
});

describe("loadClient", () => {
  it("throws NotAuthorizedError without a token file", () => {
    expect(() =>
      loadClient({ clientId: "x", clientSecret: "y", tokenPath: join(dir, "missing.json") }),
    ).toThrow(NotAuthorizedError);
  });

  it("refreshes an expired token automatically and persists it", async () => {
    const tokenPath = join(dir, "expired.json");
    const refresh = fake.issueRefreshToken();
    writeFileSync(
      tokenPath,
      JSON.stringify({ access_token: "ya29.expired", refresh_token: refresh, expiry_date: Date.now() - 1000, scope: CALENDAR_SCOPE }),
    );
    const client = loadClient({
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
      tokenPath,
      endpoints: fake.endpoints,
      calendarBaseUrl: fake.calendarBaseUrl,
    });
    const state = jsonFileState(join(dir, "state.json"));
    const calendarId = await ensureCalendar(client, { timeZone: TZ, ...state });
    expect(state.stateGet()).toBe(calendarId);
    const r = await reconcile(client, calendarId, makeItems(2), WINDOW, { timeZone: TZ });
    expect(r.inserted).toBe(2);
    const onDisk = JSON.parse(readFileSync(tokenPath, "utf8"));
    expect(onDisk.access_token).not.toBe("ya29.expired");
    expect(fake.accessTokens.has(onDisk.access_token)).toBe(true);
    expect(onDisk.refresh_token).toBe(refresh);
  });

  it("maps a revoked refresh token to NotAuthorizedError", async () => {
    const tokenPath = join(dir, "revoked.json");
    writeFileSync(tokenPath, JSON.stringify({ access_token: "old", refresh_token: "revoked", expiry_date: 1 }));
    const client = loadClient({
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
      tokenPath,
      endpoints: fake.endpoints,
      calendarBaseUrl: fake.calendarBaseUrl,
    });
    await expect(
      ensureCalendar(client, { timeZone: TZ, stateGet: () => undefined, stateSet: () => {} }),
    ).rejects.toBeInstanceOf(NotAuthorizedError);
  });
});
