import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TODAY, TOMORROW, cleanup, enc, expectError, makeApi, ms, shape, tasksOf, tempResources, type TestApi } from "./helpers.ts";

/**
 * Read from the same package.json the API reads, never pinned as a literal: a hardcoded version
 * here turns every release into a failing test, which is how 1.0.0 shipped before this was caught.
 */
const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const open: TestApi[] = [];
const dirs: string[] = [];
async function api(o?: Parameters<typeof makeApi>[0]) {
  const t = await makeApi(o);
  open.push(t);
  if (!o?.dir) dirs.push(t.dir);
  return t;
}
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
  for (const d of dirs.splice(0)) cleanup(d);
});

describe("read endpoints", () => {
  it("GET /health", async () => {
    const t = await api();
    const r = await t.get("/health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, version: VERSION, now: "2026-09-28T10:15:00+01:00", timeZone: "Africa/Tunis", tasksLoaded: 34 });
    // `credential` says which of the two Google credentials is in play ("injected" under test),
    // and `owned` is false only when CALENDAR_ID names a calendar the planner must never replace.
    expect(r.body.calendar).toEqual({
      authorized: false,
      credential: "injected",
      calendarId: null,
      owned: true,
      lastSyncAt: null,
      lastError: null,
      pending: false,
    });
  });

  it("GET /today: day, current, next, progress, upcoming", async () => {
    const t = await api();
    const r = await t.get("/today");
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.date).toBe(TODAY);
    expect(b.now).toBe("2026-09-28T10:15:00+01:00");
    expect(b.day.date).toBe(TODAY);
    expect(b.day.items[0].start).toBe("2026-09-28T08:00:00+01:00");
    expect(ms(b.current.start)).toBeLessThanOrEqual(ms(b.now));
    expect(ms(b.current.end)).toBeGreaterThan(ms(b.now));
    expect(ms(b.next.start)).toBeGreaterThan(ms(b.now));
    expect(b.progress).toMatchObject({ done: 0, total: tasksOf(b.day).length, taskMinDone: 0 });
    expect(b.progress.taskMinTotal).toBeGreaterThan(0);
    expect(b.progress.taskMinTotal).toBeLessThanOrEqual(480);
    expect(b.upcoming.date).toBe(TOMORROW);
    expect(typeof b.upcoming.firstTitle).toBe("string");
  });

  it("GET /plan: default 7 days, range, projection past the horizon, validation", async () => {
    const t = await api();
    const r = await t.get("/plan");
    expect(r.status).toBe(200);
    expect(r.body.days.map((d: any) => d.date)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    for (const d of r.body.days) expect(tasksOf(d).length).toBeGreaterThan(0);
    const one = await t.get(`/plan?from=${TOMORROW}&days=1`);
    expect(one.body.days).toHaveLength(1);
    expect(one.body.days[0]).toEqual(r.body.days[1]);
    const long = await t.get("/plan?days=30");
    expect(long.body.days).toHaveLength(30);
    expect(long.body.days.slice(0, 7)).toEqual(r.body.days);
    expect(tasksOf(long.body.days[20]).length).toBeGreaterThan(0); // projected, not stored
    expect((await t.get("/plan?days=8")).body.days).toHaveLength(8);
    expect(t.api.store.dateBounds()!.last).toBe("2026-10-04");
    expectError(await t.get("/plan?days=0"), 400, "INVALID_INPUT");
    expectError(await t.get("/plan?days=121"), 400, "INVALID_INPUT");
    expect(expectError(await t.get("/plan?from=28-09-2026"), 400, "INVALID_INPUT").message).toMatch(/from/);
  });

  it("GET /tasks with filters, GET /tasks/:uid, unknown uid", async () => {
    const t = await api();
    const all = await t.get("/tasks");
    expect(all.body.tasks).toHaveLength(34);
    const alpha = await t.get("/tasks?track=alpha&status=pending&type=coding");
    expect(alpha.body.tasks).toHaveLength(12);
    const a1 = alpha.body.tasks.find((x: any) => x.uid === "alpha/A1");
    expect(a1).toMatchObject({ status: "pending", scheduledOn: [TODAY], durationMin: 50, links: [{ url: "https://example.com/alpha/1" }] });
    expect((await t.get("/tasks?type=reading")).body.tasks.map((x: any) => x.uid)).toEqual(["lessons/DAILY"]);
    expect((await t.get("/tasks?status=done")).body.tasks).toEqual([]);
    expectError(await t.get("/tasks?status=finished"), 400, "INVALID_INPUT");

    const one = await t.get(`/tasks/${enc("alpha/A3")}`);
    expect(one.status).toBe(200);
    expect(one.body.uid).toBe("alpha/A3");
    expect(one.body.items.length).toBeGreaterThan(1);
    expect(one.body.items.every((i: any) => i.taskUid === "alpha/A3")).toBe(true);
    expect((await t.get("/tasks/alpha/A3")).body.uid).toBe("alpha/A3"); // unencoded works too

    const e = expectError(await t.get(`/tasks/${enc("alpha/A99")}`), 404, "UNKNOWN_TASK");
    expect(e.message).toBe("No task alpha/A99");
    expect(e.hint).toBe("Did you mean alpha/A9?");
  });

  it("GET /tracks", async () => {
    const t = await api();
    const r = await t.get("/tracks");
    expect(r.status).toBe(200);
    const alpha = r.body.tracks.find((x: any) => x.track === "alpha");
    expect(alpha).toMatchObject({ kind: "prep", priority: 1, title: "Alpha prep", total: 12, done: 0, skipped: 0, remainingMin: 11 * 50 + 600, active: true });
    expect(r.body.tracks.find((x: any) => x.track === "beta")).toMatchObject({ priority: 2, total: 20, active: false });
  });

  it("GET /notifications", async () => {
    const t = await api();
    expect((await t.get("/notifications")).body).toEqual([]);
    const s = t.api.store;
    expect(s.recordNotification({ at: "2026-09-28T08:00:00+01:00", type: "task_start", itemKey: "k1", title: "A1" })).toBe(true);
    expect(s.recordNotification({ at: "2026-09-28T08:00:00+01:00", type: "task_start", itemKey: "k1", title: "A1" })).toBe(false);
    s.recordNotification({ at: "2026-09-28T08:50:00+01:00", type: "task_end", itemKey: "k1", title: "A1" });
    const r = await t.get("/notifications?limit=1");
    expect(r.body).toEqual([{ at: "2026-09-28T08:50:00+01:00", type: "task_end", itemKey: "k1", title: "A1" }]);
    expect((await t.get("/notifications")).body).toHaveLength(2);
    expect((await t.get("/notifications?type=task_start")).body).toHaveLength(1);
    expectError(await t.get("/notifications?limit=0"), 400, "INVALID_INPUT");
  });

  it("GET /sync/status and calendar endpoints when not authorized", async () => {
    const t = await api();
    const r = await t.get("/sync/status");
    expect(r.body).toMatchObject({ authorized: false, calendarId: null, lastSyncAt: null, lastResult: null, pending: false, lastError: null });
    expectError(await t.get("/calendar/events"), 503, "CALENDAR_NOT_AUTHORIZED");
    const e = expectError(await t.post("/sync", {}), 503, "CALENDAR_NOT_AUTHORIZED");
    expect(e.hint).toMatch(/npm run auth/);
  });

  it("unknown route and bad JSON use the error shape", async () => {
    const t = await api();
    expectError(await t.get("/nope"), 404, "NOT_FOUND");
    const res = await t.api.app.inject({ method: "POST", url: "/plan/shift", payload: "{bad", headers: { "content-type": "application/json" } });
    expectError({ status: res.statusCode, body: JSON.parse(res.body) }, 400, "INVALID_INPUT");
  });
});

describe("status", () => {
  it("POST /items/:key/status: happy path and errors", async () => {
    const t = await api();
    const today = (await t.get("/today")).body;
    const a1 = today.day.items[0];
    const r = await t.post(`/items/${enc(a1.key)}/status`, { status: "done" });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ key: a1.key, status: "done", taskUid: "alpha/A1" });
    expect(r.body.regenerated[0]).toBe(TOMORROW);
    expect((await t.get("/tasks/alpha%2FA1")).body.status).toBe("done");
    expect((await t.get("/today")).body.progress.done).toBe(1);

    // A key with a changed part number still resolves when the task has exactly one item that day.
    expect((await t.post(`/items/${enc("2026-09-28|alpha/A1|9")}/status`, { status: "done" })).body.item.key).toBe("2026-09-28|alpha/A1|1");
    const e = expectError(await t.post(`/items/${enc("2026-09-30|alpha/A1|1")}/status`, { status: "done" }), 404, "UNKNOWN_ITEM");
    expect(e.hint).toMatch(/alpha\/A1 is not (scheduled on 2026-09-30|in the stored horizon)/);
    expect(expectError(await t.post(`/items/${enc("alpha/A1")}/status`, { status: "done" }), 404, "UNKNOWN_ITEM").hint).toMatch(/tasks\/alpha%2FA1\/status/);
    const rest = today.day.items.find((i: any) => i.kind === "rest");
    expectError(await t.post(`/items/${enc(rest.key)}/status`, { status: "done" }), 409, "CONFLICT");
    expectError(await t.post(`/items/${enc(a1.key)}/status`, { status: "finished" }), 400, "INVALID_INPUT");
    expectError(await t.post(`/items/${enc(a1.key)}/status`), 400, "INVALID_INPUT");
    expectError(await t.post(`/items/${enc(a1.key)}/status`, [1]), 400, "INVALID_INPUT");
  });

  it("never reshuffles today; regenerates the days after today assuming today's items get done", async () => {
    const t = await api();
    const before = (await t.get("/plan")).body.days;
    const todayBefore = before[0].items;
    const todayUids = new Set(tasksOf(before[0]).map((i: any) => i.taskUid));
    // Mark a task done that is scheduled later today and one that is past.
    for (const it of tasksOf(before[0]).filter((i: any) => i.taskUid === "alpha/A1" || i.taskUid === "portfolio/DAILY"))
      expect((await t.post(`/items/${enc(it.key)}/status`, { status: "done" })).status).toBe(200);
    const after = (await t.get("/plan")).body.days;
    expect(shape(after[0].items)).toEqual(shape(todayBefore)); // same keys, same times
    expect(after[0].items.filter((i: any) => i.status === "done").map((i: any) => i.taskUid).sort()).toEqual(["alpha/A1", "portfolio/DAILY"]);
    // Future: today's one-off tasks are not planned again, except the continuation of a split task.
    for (const d of after.slice(1))
      for (const it of tasksOf(d)) if (it.taskUid !== "alpha/A3" && !it.taskUid.endsWith("/DAILY")) expect(todayUids.has(it.taskUid)).toBe(false);
    // The split task continues tomorrow with its part numbering continued (carry-in).
    const partsToday = tasksOf(before[0]).filter((i: any) => i.taskUid === "alpha/A3").length;
    const a3Tomorrow = tasksOf(after[1]).filter((i: any) => i.taskUid === "alpha/A3");
    expect(a3Tomorrow.length).toBeGreaterThan(0);
    expect(a3Tomorrow[0].part.index).toBe(partsToday + 1);
    // Marking an earlier part of a split task only marks the item.
    const p1 = tasksOf(after[0]).find((i: any) => i.taskUid === "alpha/A3");
    await t.post(`/items/${enc(p1.key)}/status`, { status: "done" });
    expect((await t.get("/tasks/alpha%2FA3")).body.status).toBe("pending");
    const a3Next = tasksOf((await t.get(`/plan?from=${TOMORROW}&days=1`)).body.days[0]).filter((i: any) => i.taskUid === "alpha/A3");
    expect(a3Next[0].part.index).toBe(partsToday + 1);
  });

  it("a future task marked done stays visible (checked, out of the budget); pending brings it back", async () => {
    const t = await api();
    // A one-off task first scheduled after today (whatever the scheduler's exact layout is).
    const future = (await t.get("/tasks?track=alpha")).body.tasks.find((x: any) => x.uid !== "alpha/A3" && x.scheduledOn.length && x.scheduledOn[0] > TODAY);
    const uid = enc(future.uid);
    const r = await t.post(`/tasks/${uid}/status`, { status: "skipped" });
    expect(r.status).toBe(200);
    expect(r.body.task).toMatchObject({ uid: future.uid, status: "skipped", scheduledOn: [] });
    expect(r.body.regenerated).toContain(future.scheduledOn[0]);
    const days = (await t.get("/plan")).body.days;
    expect(days.flatMap((d: any) => d.items).some((i: any) => i.taskUid === future.uid)).toBe(false); // off the timeline
    const mine = days.flatMap((d: any) => d.checked).filter((i: any) => i.taskUid === future.uid);
    expect(mine.map((i: any) => [i.date, i.status])).toEqual([[future.scheduledOn[0], "skipped"]]); // in that day's checked list
    expect(mine[0].plannedStart).toBe(mine[0].start);
    await t.post(`/tasks/${uid}/status`, { status: "pending" });
    const back = (await t.get(`/tasks/${uid}`)).body;
    expect(back.status).toBe("pending");
    expect(back.scheduledOn).toEqual(future.scheduledOn);
    expect(back.items.filter((i: any) => i.date >= TODAY).every((i: any) => i.status === "pending")).toBe(true);
    expectError(await t.post("/tasks/alpha%2FA44/status", { status: "done" }), 404, "UNKNOWN_TASK");
    expectError(await t.post("/tasks/alpha%2FA4/status", { status: "nope" }), 400, "INVALID_INPUT");
  });

  it("daily tasks: status per date, date required", async () => {
    const t = await api();
    const e = expectError(await t.post("/tasks/lessons%2FDAILY/status", { status: "done" }), 400, "INVALID_INPUT");
    expect(e.message).toMatch(/date is required/);
    expectError(await t.post("/tasks/lessons%2FDAILY/status", { status: "done", date: "tomorrow" }), 400, "INVALID_INPUT");
    const r = await t.post("/tasks/lessons%2FDAILY/status", { status: "done", date: TODAY });
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: any) => [i.date, i.status])).toEqual([[TODAY, "done"]]);
    const plan = (await t.get("/plan?days=2")).body.days;
    expect(tasksOf(plan[0]).find((i: any) => i.taskUid === "lessons/DAILY").status).toBe("done");
    expect(tasksOf(plan[1]).find((i: any) => i.taskUid === "lessons/DAILY").status).toBe("pending");
    expect(t.api.store.getStatus(`lessons/DAILY@${TODAY}`)?.status).toBe("done");
    expect(t.api.store.getStatus("lessons/DAILY")).toBeUndefined();
    // By item key on tomorrow: only that date changes.
    const tomorrowLesson = tasksOf(plan[1]).find((i: any) => i.taskUid === "lessons/DAILY");
    await t.post(`/items/${enc(tomorrowLesson.key)}/status`, { status: "skipped" });
    expect(t.api.store.getStatus(`lessons/DAILY@${TOMORROW}`)?.status).toBe("skipped");
    expect((await t.get("/tasks/lessons%2FDAILY")).body.status).toBe("done"); // today's status
    // occurrences: 3 from the anchor
    const week = (await t.get("/plan")).body.days;
    const lessonStatus = (d: any) => [...tasksOf(d), ...d.checked].find((i: any) => i.taskUid === "lessons/DAILY")?.status ?? null;
    expect(week.map(lessonStatus)).toEqual(["done", "skipped", "pending", null, null, null, null]);
  });

  it("status survives a restart on the same database", async () => {
    const t = await api();
    const key = (await t.get("/today")).body.day.items[0].key;
    await t.post(`/items/${enc(key)}/status`, { status: "done" });
    await t.post("/tasks/lessons%2FDAILY/status", { status: "skipped", date: TODAY });
    const planBefore = (await t.get("/plan")).body;
    await t.close();
    open.splice(open.indexOf(t), 1);

    const t2 = await api({ dir: t.dir });
    const today = (await t2.get("/today")).body;
    expect(today.day.items[0]).toMatchObject({ key, status: "done" });
    expect(today.progress.done).toBe(2);
    expect((await t2.get("/tasks/alpha%2FA1")).body.status).toBe("done");
    expect((await t2.get("/plan")).body).toEqual(planBefore);
  });
});

describe("shift", () => {
  it("minutes: today's items from now move later, persisted", async () => {
    const t = await api();
    const before = (await t.get("/today")).body.day.items;
    const r = await t.post("/plan/shift", { amount: 30, unit: "minutes" });
    expect(r.status).toBe(200);
    const moving = before.filter((i: any) => ms(i.start) >= ms("2026-09-28T10:15:00+01:00"));
    expect(r.body).toMatchObject({ moved: moving.length, carried: 0, regenerated: [] });
    expect(ms(r.body.endOfDay)).toBe(ms(before.at(-1).end) + 30 * 60_000);
    const after = (await t.get("/today")).body.day.items;
    expect(after.map((i: any) => i.key)).toEqual(before.map((i: any) => i.key));
    for (let k = 0; k < before.length; k++) {
      if (before[k].kind !== "task") continue; // the rest right after the in-progress item may stay (core rule)
      const moved = ms(before[k].start) >= ms("2026-09-28T10:15:00+01:00");
      expect(ms(after[k].start) - ms(before[k].start)).toBe(moved ? 30 * 60_000 : 0);
    }
    // The in-progress item keeps its times, the gap after it grows.
    const current = (await t.get("/today")).body.current;
    expect(current.start).toBe(before.find((i: any) => i.key === current.key).start);
  });

  it("hours: persisted in /today and /plan and across restart", async () => {
    const t = await api();
    const before = (await t.get("/today")).body.day.items;
    const r = await t.post("/plan/shift", { amount: 1, unit: "hours" });
    expect(r.status).toBe(200);
    expect(ms(r.body.endOfDay)).toBe(ms(before.at(-1).end) + 3600_000);
    const planDay = (await t.get("/plan?days=1")).body.days[0].items;
    expect(planDay.at(-1).end).toBe(r.body.endOfDay);
    await t.close();
    open.splice(open.indexOf(t), 1);
    const t2 = await api({ dir: t.dir });
    expect((await t2.get("/today")).body.day.items.at(-1).end).toBe(r.body.endOfDay);
  });

  it("shift past midnight carries the task to tomorrow", async () => {
    const t = await api();
    const r = await t.post("/plan/shift", { amount: 12, unit: "hours" });
    expect(r.status).toBe(200);
    expect(r.body.regenerated[0]).toBe(TOMORROW);
    const [today, tomorrow] = (await t.get("/plan?days=2")).body.days;
    for (const it of today.items) expect(ms(it.start)).toBeLessThan(ms("2026-09-29T00:00:00+01:00"));
    expect(tomorrow.items[0].start).toBe("2026-09-29T08:00:00+01:00");
  });

  it("days: everything from now moves to later dates, persisted", async () => {
    const t = await api();
    const before = (await t.get("/today")).body;
    const nextTask = before.day.items.find((i: any) => i.kind === "task" && ms(i.start) >= ms(before.now));
    const r = await t.post("/plan/shift", { amount: 1, unit: "days" });
    expect(r.status).toBe(200);
    expect(r.body.moved).toBeGreaterThan(0);
    const after = (await t.get("/today")).body;
    expect(after.day.items.every((i: any) => ms(i.start) < ms(before.now))).toBe(true);
    expect(after.current?.key).toBe(before.current.key);
    const tomorrow = (await t.get(`/plan?from=${TOMORROW}&days=1`)).body.days[0];
    expect(tomorrow.items.some((i: any) => i.taskUid === nextTask.taskUid)).toBe(true);
    const plan = (await t.get("/plan?days=8")).body.days;
    expect(tasksOf(plan[7]).length).toBeGreaterThan(0);
  });

  it("days > 1 leaves days off that later regenerations keep empty", async () => {
    const t = await api();
    await t.post("/plan/shift", { amount: 3, unit: "days" });
    let plan = (await t.get("/plan?days=4")).body.days;
    expect(plan[1].items).toEqual([]);
    expect(plan[2].items).toEqual([]);
    expect(tasksOf(plan[3]).length).toBeGreaterThan(0);
    const first = tasksOf(plan[0])[0];
    await t.post(`/items/${enc(first.key)}/status`, { status: "done" });
    plan = (await t.get("/plan?days=4")).body.days;
    expect(plan[1].items).toEqual([]);
    expect(plan[2].items).toEqual([]);
  });

  it("preview computes without saving; errors", async () => {
    const t = await api();
    const before = (await t.get("/plan")).body;
    const p = await t.post("/plan/shift/preview", { amount: 45, unit: "minutes" });
    expect(p.status).toBe(200);
    expect(ms(p.body.endOfDay)).toBe(ms(before.days[0].items.at(-1).end) + 45 * 60_000);
    expect((await t.get("/plan")).body).toEqual(before);
    expectError(await t.post("/plan/shift", { amount: -1, unit: "hours" }), 400, "INVALID_INPUT");
    expectError(await t.post("/plan/shift", { amount: 1.5, unit: "hours" }), 400, "INVALID_INPUT");
    expectError(await t.post("/plan/shift", { amount: 1, unit: "weeks" }), 400, "INVALID_INPUT");
    expectError(await t.post("/plan/shift", {}), 400, "INVALID_INPUT");
    expect((await t.get("/plan")).body).toEqual(before);
  });

  it("409 when nothing is left to shift today", async () => {
    const t = await api({ now: "2026-09-28T23:00:00+01:00" });
    const e = expectError(await t.post("/plan/shift", { amount: 10, unit: "minutes" }), 409, "CONFLICT");
    expect(e.hint).toMatch(/days/);
  });
});

describe("regenerate and reload", () => {
  it("POST /plan/regenerate defaults to tomorrow, validates from", async () => {
    const t = await api();
    const r = await t.post("/plan/regenerate");
    expect(r.status).toBe(200);
    expect(r.body.regenerated[0]).toBe(TOMORROW);
    expect(r.body.regenerated).toHaveLength(6);
    expect((await t.post("/plan/regenerate", { from: TODAY })).body.regenerated[0]).toBe(TODAY);
    expectError(await t.post("/plan/regenerate", { from: "2026-09-27" }), 400, "INVALID_INPUT");
    expectError(await t.post("/plan/regenerate", { from: "2027-01-01" }), 400, "INVALID_INPUT");
  });

  it("POST /reload: new file picked up; broken file gives 422 and keeps the old tasks", async () => {
    const res = tempResources();
    dirs.push(res);
    const t = await api({ resourcesDir: res });
    writeFileSync(
      join(res, "gamma.md"),
      "---\nschema: planner/task-file@1\ntrack: gamma\ntitle: Gamma\nkind: prep\npriority: 3\n---\n\n### G1 · Gamma one\n\n```task\nid: G1\nduration: 30m\ntype: drill\n```\n",
    );
    const ok = await t.post("/reload");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ tasks: 35, errors: [] });
    expect((await t.get("/tasks/gamma%2FG1")).status).toBe(200);

    writeFileSync(join(res, "gamma.md"), "---\nschema: planner/task-file@1\ntrack: gamma\ntitle: Gamma\nkind: prep\n---\n\n### G1\n\n```task\nid: G1\nduration: forever\ntype: nonsense\n```\n");
    const bad = await t.post("/reload");
    const e = expectError(bad, 422, "TASK_FILE_ERRORS");
    expect(e.details.length).toBeGreaterThan(0);
    expect(e.details[0]).toMatchObject({ file: expect.stringContaining("gamma.md"), line: expect.any(Number), message: expect.any(String) });
    expect((await t.get("/health")).body.tasksLoaded).toBe(35);
    expect((await t.get("/tasks/gamma%2FG1")).status).toBe(200);
  });
});
