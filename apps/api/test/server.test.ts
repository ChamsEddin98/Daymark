import { get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "@planner/store";
import { startApi, type Api } from "../src/app.ts";
import { FIXTURES, NOW, TZ, cleanup, enc, makeApi, notAuthorized, tempDir } from "./helpers.ts";

const started: Api[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of started.splice(0)) await a.close();
  for (const d of dirs.splice(0)) cleanup(d);
});

async function start(env: Record<string, string> = {}) {
  const dir = tempDir();
  dirs.push(dir);
  const api = await startApi({
    port: 0,
    dataDir: dir,
    resourcesDir: FIXTURES,
    clock: fixedClock(NOW, TZ),
    timeZone: TZ,
    pollMs: 0,
    heartbeatMs: 0,
    logger: false,
    syncDebounceMs: 20,
    calendarClient: notAuthorized,
    env,
  });
  started.push(api);
  return api;
}

/** Open an SSE stream and collect parsed events with their arrival time. */
function openStream(url: string, headers: Record<string, string> = {}) {
  const events: { event: string; data: any; at: number }[] = [];
  let res: IncomingMessage | undefined;
  const ready = new Promise<IncomingMessage>((resolve, reject) => {
    const req = get(`${url}/events`, { headers }, (r) => {
      res = r;
      let buf = "";
      r.setEncoding("utf8");
      r.on("data", (chunk: string) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data), at: performance.now() });
        }
      });
      resolve(r);
    });
    req.on("error", reject);
  });
  return { events, ready, close: () => res?.destroy() };
}

const until = async (cond: () => boolean, timeoutMs = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe("real server", () => {
  it("binds to 127.0.0.1 only, even if a host is set in the environment", async () => {
    const api = await start({ PLANNER_API_HOST: "0.0.0.0", HOST: "0.0.0.0" });
    const addr = api.app.server.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
    expect(api.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await fetch(`${api.url}/health`);
    expect(r.status).toBe(200);
  });

  it("CORS allows the web UI origins only", async () => {
    const api = await start();
    for (const origin of ["http://127.0.0.1:3417", "http://localhost:3417"]) {
      const r = await fetch(`${api.url}/today`, { headers: { origin } });
      expect(r.headers.get("access-control-allow-origin")).toBe(origin);
      const pre = await fetch(`${api.url}/plan/shift`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });
      expect(pre.status).toBeLessThan(300);
      expect(pre.headers.get("access-control-allow-origin")).toBe(origin);
    }
    const evil = await fetch(`${api.url}/today`, { headers: { origin: "http://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("publishes SSE events within 100 ms of a mutation", async () => {
    const api = await start();
    const s = openStream(api.url, { origin: "http://localhost:3417" });
    const res = await s.ready;
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3417");
    await until(() => api.bus.size === 1);

    const key = (((await (await fetch(`${api.url}/today`)).json()) as any).day.items[0]).key as string;
    const t0 = performance.now();
    const post = await fetch(`${api.url}/items/${enc(key)}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    const tDone = performance.now();
    expect(post.status).toBe(200);
    await until(() => s.events.some((e) => e.event === "plan"), 1000);
    const status = s.events.find((e) => e.event === "status")!;
    const plan = s.events.find((e) => e.event === "plan")!;
    expect(status.data).toMatchObject({ key, status: "done", taskUid: "alpha/A1" });
    expect(plan.data.dates).toContain("2026-09-29");
    expect(status.at - t0).toBeLessThan(100);
    expect(plan.at - tDone).toBeLessThan(100);

    const t1 = performance.now();
    await fetch(`${api.url}/plan/shift`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount: 15, unit: "minutes" }) });
    await until(() => s.events.filter((e) => e.event === "plan").length === 2, 1000);
    expect(s.events.filter((e) => e.event === "plan")[1]!.at - t1).toBeLessThan(100);
    // The debounced sync fails (not authorized) and reports it as a `sync` event.
    await until(() => s.events.some((e) => e.event === "sync"), 2000);
    expect(s.events.find((e) => e.event === "sync")!.data).toMatchObject({ ok: false, lastError: { code: "CALENDAR_NOT_AUTHORIZED" } });
    s.close();
  });
});

describe("sync failures never fail the mutation", () => {
  it("not authorized: mutation 200, sync state records the error, POST /sync 503", async () => {
    const t = await makeApi();
    dirs.push(t.dir);
    try {
      const key = (await t.get("/today")).body.day.items[0].key;
      const r = await t.post(`/items/${enc(key)}/status`, { status: "done" });
      expect(r.status).toBe(200);
      expect((await t.get("/sync/status")).body.pending).toBe(true);
      await t.api.sync.flush();
      const s = (await t.get("/sync/status")).body;
      expect(s).toMatchObject({ authorized: false, pending: true, lastError: { code: "CALENDAR_NOT_AUTHORIZED" } });
      expect((await t.get("/health")).body.calendar.lastError.code).toBe("CALENDAR_NOT_AUTHORIZED");
      expect((await t.post("/sync")).status).toBe(503);
      expect((await t.get("/today")).body.day.items[0].status).toBe("done");
    } finally {
      await t.close();
    }
  });

  it("a calendar client that fails for any other reason never makes /health or /sync/status 500", async () => {
    // A corrupt token file, a permission problem: not NotAuthorizedError, so `authorized()` rethrows.
    const t = await makeApi({
      calendarClient: () => {
        throw new Error("EACCES: google-token.json");
      },
    });
    dirs.push(t.dir);
    try {
      const h = await t.get("/health");
      expect(h.status, "/health never fails").toBe(200);
      expect(h.body.ok).toBe(true);
      expect(h.body.calendar.authorized).toBe(false);
      const s = await t.get("/sync/status");
      expect(s.status).toBe(200);
      expect(s.body.authorized).toBe(false);
      // The real failure still surfaces where it belongs, in our envelope.
      const r = await t.post("/sync");
      expect(r.status).toBe(500);
      expect(r.body.error.message).toContain("EACCES: google-token.json");
    } finally {
      await t.close();
    }
  });

  /**
   * `throw null`, `throw "boom"` and objects without a `message` are all legal. None of them may turn
   * a read endpoint into a 500, and none may make an error response leave without our envelope
   * (CLAUDE.md: "API errors are always { error: { code, message, hint } }").
   */
  const thrown: [string, unknown, string][] = [
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
    ["a bare string", "token file is empty", "token file is empty"],
    ["a TypeError", new TypeError("bad token shape"), "bad token shape"],
    ["an object with no message", { code: "EBADF" }, "EBADF"],
  ];
  for (const [label, value, expected] of thrown) {
    it(`a calendar client throwing ${label} keeps the read endpoints at 200 and POST /sync in the envelope`, async () => {
      const logs: string[] = [];
      const t = await makeApi({
        calendarClient: () => {
          throw value;
        },
      });
      dirs.push(t.dir);
      const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
      try {
        for (const url of ["/health", "/sync/status"]) {
          const r = await t.get(url);
          expect(r.status, `${url} with ${label}`).toBe(200);
          expect(r.body.error, `${url} returned no error`).toBeUndefined();
        }
        expect((await t.get("/health")).body.calendar.authorized).toBe(false);

        const r = await t.post("/sync");
        expect(r.status, `POST /sync with ${label}`).toBe(500);
        expect(Object.keys(r.body), "the envelope, not Fastify's default body").toEqual(["error"]);
        expect(r.body.error.code).toBe("INTERNAL");
        expect(typeof r.body.error.message, "a message, never undefined").toBe("string");
        expect(r.body.error.message.length).toBeGreaterThan(0);
        expect(typeof r.body.error.hint).toBe("string");
        // The diagnostic survives instead of reading "undefined".
        expect(r.body.error.message, `${label}: diagnostic kept`).toContain(expected);
      } finally {
        spy.mockRestore();
        await t.close();
      }
    });
  }
});
