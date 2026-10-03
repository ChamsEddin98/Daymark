/** Regression tests for the P2 critics' notes (round 2 and round 3; numbers match round 3's notes). */
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fixedClock } from "@planner/store";
import { startApi, type Api } from "../src/app.ts";
import { FIXTURES, TODAY, TOMORROW, TZ, at, checkDay, cleanup, enc, expectError, makeApi, mins, ms, notAuthorized, tasksOf, tempDir, type TestApi } from "./helpers.ts";

const open: TestApi[] = [];
async function api(o?: Parameters<typeof makeApi>[0]) {
  const t = await makeApi(o);
  open.push(t);
  return t;
}
afterEach(async () => {
  for (const t of open.splice(0)) {
    await t.close();
    cleanup(t.dir);
  }
});


async function lessonSessions(t: TestApi) {
  const days = (await t.get(`/plan?from=${TODAY}&days=40`)).body.days;
  return days.filter((d: any) => [...d.items, ...d.checked].some((i: any) => i.taskUid === "lessons/DAILY")).length;
}

describe("round 3 · 1. undo of an off-timeline checked item re-plans the task", () => {
  it("skip a later item, regenerate from today, undo -> pending again in today's remaining timeline", async () => {
    const t = await api();
    const now = (await t.get("/today")).body.now;
    const later = tasksOf((await t.get("/today")).body.day).find((i: any) => ms(i.start) > ms(now) && !i.taskUid.endsWith("/DAILY"));
    await t.post(`/items/${enc(later.key)}/status`, { status: "skipped" });
    await t.post("/plan/regenerate", { from: TODAY });
    let day = (await t.get("/today")).body.day;
    expect(day.items.some((i: any) => i.key === later.key)).toBe(false);
    expect(day.checked.map((i: any) => [i.key, i.status, i.start])).toEqual([[later.key, "skipped", later.start]]);

    const undo = await t.post(`/items/${enc(later.key)}/status`, { status: "pending" });
    expect(undo.status).toBe(200);
    expect(undo.body.replanned).toBe(true);
    expect(undo.body.item).toMatchObject({ taskUid: later.taskUid, status: "pending" });
    expect(ms(undo.body.item.start)).toBeGreaterThanOrEqual(ms(now));
    day = (await t.get("/today")).body.day;
    expect(day.checked).toEqual([]);
    expect(day.items.find((i: any) => i.taskUid === later.taskUid)?.status ?? "tomorrow").not.toBe("skipped");
    checkDay(day);
    expect((await t.get(`/tasks/${enc(later.taskUid)}`)).body.status).toBe("pending");
  });

  it("undo of a checked future item re-plans from that date", async () => {
    const t = await api();
    const tomorrow = (await t.get(`/plan?from=${TOMORROW}&days=1`)).body.days[0];
    const item = tasksOf(tomorrow).find((i: any) => !i.taskUid.endsWith("/DAILY") && !i.part);
    expect((await t.post(`/items/${enc(item.key)}/status`, { status: "done" })).status).toBe(200);
    let d = (await t.get(`/plan?from=${TOMORROW}&days=1`)).body.days[0];
    expect(d.items.some((i: any) => i.key === item.key)).toBe(false);
    expect(d.checked.map((i: any) => [i.key, i.status, i.start, i.end])).toEqual([[item.key, "done", item.start, item.end]]);
    const undo = await t.post(`/items/${enc(item.key)}/status`, { status: "pending" });
    expect(undo.status).toBe(200);
    expect(undo.body.item).toMatchObject({ taskUid: item.taskUid, status: "pending", date: TOMORROW });
    d = (await t.get(`/plan?from=${TOMORROW}&days=1`)).body.days[0];
    expect(d.checked).toEqual([]);
    checkDay(d);
  });

  it("undo through /tasks/:uid/status also re-plans", async () => {
    const t = await api();
    const key = `${TOMORROW}|portfolio/DAILY|1`;
    await t.post(`/items/${enc(key)}/status`, { status: "done" });
    expect((await t.get(`/plan?from=${TOMORROW}&days=1`)).body.days[0].checked.map((i: any) => i.key)).toEqual([key]);
    const r = await t.post("/tasks/portfolio%2FDAILY/status", { status: "pending", date: TOMORROW });
    expect(r.status).toBe(200);
    const d = (await t.get(`/plan?from=${TOMORROW}&days=1`)).body.days[0];
    expect(d.checked).toEqual([]);
    expect(d.items.find((i: any) => i.taskUid === "portfolio/DAILY")?.status).toBe("pending");
  });
});

describe("round 3 · 2. no incoherent times", () => {
  it("skip a later day's items one by one + regenerate, 3 rounds: every item stays on its own date; checked keep their original times", async () => {
    const t = await api();
    const day3 = "2026-09-30";
    const firstSeen = new Map<string, string>();
    for (let round = 0; round < 3; round++) {
      const d = (await t.get(`/plan?from=${day3}&days=1`)).body.days[0];
      const target = tasksOf(d).find((i: any) => i.taskUid.startsWith("alpha/") || i.taskUid.startsWith("beta/"));
      if (!target) break;
      firstSeen.set(target.key, target.start); // its slot at the first status change
      expect((await t.post(`/items/${enc(target.key)}/status`, { status: "skipped" })).status).toBe(200);
      expect((await t.post("/plan/regenerate", { from: TOMORROW })).status).toBe(200);
      for (const day of (await t.get(`/plan?from=${TODAY}&days=7`)).body.days) checkDay(day);
    }
    const d = (await t.get(`/plan?from=${day3}&days=1`)).body.days[0];
    expect(d.checked.length).toBe(3);
    // Each keeps the slot it had at its first status change (captured once, never overwritten).
    for (const c of d.checked) expect([c.start, c.plannedStart]).toEqual([firstSeen.get(c.key), firstSeen.get(c.key)]);
  });
});

describe("round 3 · 3. regenerate-from-now uses the core's rules", () => {
  it("A1 done, A2 in progress, two later items skipped: no fragments, past kept, 4h/1h/4h", async () => {
    const t = await api({ now: "2026-09-28T09:20:00+01:00" });
    const before = (await t.get("/today")).body;
    const [a1, a2] = tasksOf(before.day);
    await t.post(`/items/${enc(a1.key)}/status`, { status: "done" });
    const later = tasksOf(before.day).filter((i: any) => ms(i.start) > ms(before.now) && !i.taskUid.endsWith("/DAILY")).slice(0, 2);
    for (const l of later) await t.post(`/items/${enc(l.key)}/status`, { status: "skipped" });
    expect((await t.post("/plan/regenerate", { from: TODAY })).status).toBe(200);
    const day = (await t.get("/today")).body.day;
    checkDay(day);
    expect(day.items.find((i: any) => i.key === a1.key)).toMatchObject({ status: "done", start: a1.start, end: a1.end });
    expect(day.items.find((i: any) => i.key === a2.key)).toMatchObject({ status: "pending", start: a2.start, end: a2.end });
    expect(day.checked.map((i: any) => i.key).sort()).toEqual(later.map((l: any) => l.key).sort());
    for (const i of tasksOf(day)) expect(mins(i), `${i.key} is a fragment`).toBeGreaterThanOrEqual(15);
    const first = tasksOf(day).find((i: any) => ms(i.start) > ms(a2.start));
    expect(ms(first.start)).toBe(ms(a2.end) + 10 * 60_000);
    // A task that fits a whole day is not split across today and tomorrow.
    const tomorrow = (await t.get(`/plan?from=${TOMORROW}&days=1`)).body.days[0];
    // A daily task is a new session every date, so only one-off tasks count as split across days.
    const both = tasksOf(day).filter((i: any) => i.part && !i.taskUid.endsWith("/DAILY") && tasksOf(tomorrow).some((j: any) => j.taskUid === i.taskUid));
    for (const i of both) expect(i.taskUid).toBe("alpha/A3"); // 10 h: longer than a day's prep budget
    expect(tasksOf(day).some((i: any) => i.taskUid === "lessons/DAILY")).toBe(true);
  });

  it("an earlier minute/hour shift is not discarded by regenerate-from-now", async () => {
    const t = await api();
    const s = await t.post("/plan/shift", { amount: 45, unit: "minutes" });
    expect(s.status).toBe(200);
    const next = (await t.get("/today")).body.nextTask;
    await t.post("/plan/regenerate", { from: TODAY });
    const after = (await t.get("/today")).body;
    expect(ms(after.nextTask.start)).toBeGreaterThanOrEqual(ms(next.start));
    checkDay(after.day);
  });

  it("idle during a rest: work continues when the rest ends", async () => {
    const t = await api({ now: "2026-09-28T09:55:00+01:00" });
    const restEnd = (await t.get("/today")).body.current.end;
    await t.post("/plan/regenerate", { from: TODAY });
    const today = (await t.get("/today")).body;
    expect(today.nextTask.start).toBe(restEnd);
    checkDay(today.day);
  });
});

describe("round 3 · 4. lesson sessions stay at `occurrences`", () => {
  it("shift +10h (drops lessons) then regenerate from today: still 3 sessions", async () => {
    const t = await api();
    expect(await lessonSessions(t)).toBe(3);
    const s = await t.post("/plan/shift", { amount: 10, unit: "hours" });
    expect(s.status).toBe(200);
    expect(s.body.dropped).toBeGreaterThanOrEqual(1);
    expect(await lessonSessions(t)).toBe(3);
    expect((await t.post("/plan/regenerate", { from: TODAY })).status).toBe(200);
    expect(await lessonSessions(t)).toBe(3);
    for (const day of (await t.get(`/plan?from=${TODAY}&days=7`)).body.days) checkDay(day);
  });

  it("done lesson survives shifts past midnight, is held in `checked`, adds no session", async () => {
    const t = await api();
    await t.post("/tasks/lessons%2FDAILY/status", { status: "done", date: TODAY });
    for (const h of [6, 3, 5]) expect((await t.post("/plan/shift", { amount: h, unit: "hours" })).status).toBe(200);
    const today = (await t.get("/today")).body;
    const lesson = [...today.day.items, ...today.day.checked].find((i: any) => i.taskUid === "lessons/DAILY");
    expect(lesson.status).toBe("done");
    checkDay(today.day);
    expect(today.progress.done).toBeGreaterThanOrEqual(1);
    expect(await lessonSessions(t)).toBe(3);
  });
});

describe("round 3 · 5. hints never name another task; key resolution", () => {
  it("uid exists but not on that date -> names that uid and its dates; unknown uid -> closest uid", async () => {
    const t = await api();
    const a6 = (await t.get("/tasks/alpha%2FA6")).body;
    const e = expectError(await t.post(`/items/${enc(`${TODAY}|alpha/A6|1`)}/status`, { status: "done" }), 404, "UNKNOWN_ITEM");
    expect(e.hint).toContain(`alpha/A6 is not scheduled on ${TODAY}; it is on ${a6.scheduledOn[0]}`);
    expect(e.hint).not.toMatch(/alpha\/A[0-57-9]\b/);
    const e2 = expectError(await t.post(`/items/${enc(`${TODAY}|alpha/A99|1`)}/status`, { status: "done" }), 404, "UNKNOWN_ITEM");
    expect(e2.hint).toMatch(/No task alpha\/A99; did you mean alpha\/A9\?/);
    const e3 = expectError(await t.post(`/items/${enc(`${TODAY}|beta/B20|1`)}/status`, { status: "done" }), 404, "UNKNOWN_ITEM");
    expect(e3.hint).toMatch(/beta\/B20 is not (scheduled|in the stored horizon)/);
    const resolved = await t.post(`/items/${enc(`${TODAY}|lessons/DAILY|4`)}/status`, { status: "done" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.item.key).toBe(`${TODAY}|lessons/DAILY|1`);
  });
});

describe("round 3 · minors", () => {
  it("6. last part of a split daily on a future day, done: that day's prep is refilled like the unsplit case", async () => {
    const t = await api();
    const days = (await t.get("/plan?days=7")).body.days.slice(1);
    const split = days.flatMap((d: any) => tasksOf(d)).find((i: any) => i.taskUid.endsWith("/DAILY") && i.part && i.part.index === i.part.total);
    const target = split ?? tasksOf(days[0]).find((i: any) => i.taskUid === "portfolio/DAILY");
    const before = (await t.get(`/plan?from=${target.date}&days=1`)).body.days[0];
    const prepBefore = tasksOf(before).filter((i: any) => !i.taskUid.endsWith("/DAILY")).reduce((n: number, i: any) => n + mins(i), 0);
    expect((await t.post(`/items/${enc(target.key)}/status`, { status: "done" })).status).toBe(200);
    const after = (await t.get(`/plan?from=${target.date}&days=1`)).body.days[0];
    expect(after.items.some((i: any) => i.taskUid === target.taskUid)).toBe(false);
    expect(after.checked.some((i: any) => i.key === target.key)).toBe(true);
    const prepAfter = tasksOf(after).filter((i: any) => !i.taskUid.endsWith("/DAILY")).reduce((n: number, i: any) => n + mins(i), 0);
    expect(prepAfter).toBeGreaterThan(prepBefore);
    checkDay(after);
  });

  it("10. one-off task with a date it has no item on -> 409", async () => {
    const t = await api();
    const e = expectError(await t.post("/tasks/alpha%2FA1/status", { status: "done", date: "2026-10-01" }), 409, "CONFLICT");
    expect(e.hint).toMatch(/one-off task: omit "date"/);
    expect((await t.post("/tasks/alpha%2FA1/status", { status: "done", date: TODAY })).status).toBe(200);
  });

  it("11. non-finite amount -> 400 with a fixed hint", async () => {
    const t = await api();
    const res = await t.api.app.inject({ method: "POST", url: "/plan/shift", payload: '{"amount":1e999,"unit":"minutes"}', headers: { "content-type": "application/json" } });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.hint).toBe('Send a whole number, e.g. { "amount": 30, "unit": "minutes" }.');
  });

  it("8. rest keys are chronological per day and identical inputs give identical plans", async () => {
    const run = async () => {
      const t = await api();
      await t.post("/plan/shift", { amount: 30, unit: "minutes" });
      const later = tasksOf((await t.get("/today")).body.day).find((i: any) => ms(i.start) > at(TODAY, "12:00"));
      await t.post(`/items/${enc(later.key)}/status`, { status: "skipped" });
      await t.post("/plan/regenerate", { from: TODAY });
      await t.post("/plan/shift", { amount: 1, unit: "days" });
      return (await t.get("/plan?days=10")).body.days;
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    for (const d of a) checkDay(d);
  });

  it("progress counts checked items and reports checkedMin", async () => {
    const t = await api();
    const later = tasksOf((await t.get("/today")).body.day).find((i: any) => ms(i.start) > at(TODAY, "11:00") && !i.taskUid.endsWith("/DAILY"));
    await t.post(`/items/${enc(later.key)}/status`, { status: "skipped" });
    await t.post("/plan/regenerate", { from: TODAY });
    const p = (await t.get("/today")).body.progress;
    expect(p.checkedMin).toBe(mins(later));
    expect(p.done).toBeGreaterThanOrEqual(1);
    expect(p.taskMinTotal).toBeGreaterThanOrEqual(p.checkedMin);
  });
});

describe("round 2 notes (still binding)", () => {
  it("Origin/Host: foreign Origin -> 403 FORBIDDEN_ORIGIN, allowed/no Origin pass, foreign Host -> 403", async () => {
    const t = await api();
    const res = await t.api.app.inject({ method: "POST", url: "/plan/regenerate", headers: { origin: "http://evil.com" } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN_ORIGIN");
    expect((await t.api.app.inject({ method: "POST", url: "/plan/regenerate", headers: { origin: "http://localhost:3417" } })).statusCode).toBe(200);
    expect((await t.post("/plan/regenerate")).status).toBe(200);
    const h = await t.api.app.inject({ method: "GET", url: "/today", headers: { host: "attacker.example" } });
    expect(h.statusCode).toBe(403);
    expect(JSON.parse(h.body).error.code).toBe("FORBIDDEN_HOST");
  });

  it("real server: rebound Host and wrong port are refused", async () => {
    const dir = tempDir();
    const a: Api & { url: string } = await startApi({ port: 0, dataDir: dir, resourcesDir: FIXTURES, clock: fixedClock("2026-09-28T10:15:00+01:00", TZ), timeZone: TZ, pollMs: 0, heartbeatMs: 0, logger: false, env: {}, calendarClient: notAuthorized });
    try {
      const port = Number(new URL(a.url).port);
      const hit = (host: string) =>
        new Promise<number>((resolve, reject) => {
          const req = request({ host: "127.0.0.1", port, path: "/health", headers: { host } }, (res) => {
            res.resume();
            resolve(res.statusCode!);
          });
          req.on("error", reject);
          req.end();
        });
      expect(await hit(`127.0.0.1:${port}`)).toBe(200);
      expect(await hit(`localhost:${port}`)).toBe(200);
      expect(await hit(`attacker.example:${port}`)).toBe(403);
      expect(await hit(`127.0.0.1:${port + 1}`)).toBe(403);
    } finally {
      await a.close();
      cleanup(dir);
    }
  });

  it("currentTask / nextTask ignore checked and done items", async () => {
    const t = await api();
    const b = (await t.get("/today")).body;
    expect(b.currentTask?.key).toBe(b.current.key);
    await t.post(`/items/${enc(b.current.key)}/status`, { status: "done" });
    const a = (await t.get("/today")).body;
    expect(a.current.key).toBe(b.current.key);
    expect(a.currentTask).toBeNull();
    expect(a.nextTask).toMatchObject({ kind: "task", status: "pending" });
    expect(ms(a.nextTask.start)).toBeGreaterThan(ms(a.now));
  });

  it("shift bounds, /tasks filters, daily date without item", async () => {
    const t = await api();
    expect(expectError(await t.post("/plan/shift", { amount: 1441, unit: "minutes" }), 400, "INVALID_INPUT").hint).toMatch(/days/);
    expectError(await t.post("/plan/shift", { amount: 25, unit: "hours" }), 400, "INVALID_INPUT");
    expectError(await t.post("/plan/shift/preview", { amount: 366, unit: "days" }), 400, "INVALID_INPUT");
    expect((await t.post("/plan/shift/preview", { amount: 24, unit: "hours" })).status).toBe(200);
    expect(expectError(await t.get("/tasks?track=alpah"), 400, "INVALID_INPUT").hint).toMatch(/Did you mean alpha\?/);
    expect(expectError(await t.get("/tasks?type=codin"), 400, "INVALID_INPUT").hint).toMatch(/Did you mean coding\?/);
    expect(expectError(await t.post("/tasks/lessons%2FDAILY/status", { status: "done", date: "2026-10-02" }), 409, "CONFLICT").hint).toContain(TODAY);
  });
});
