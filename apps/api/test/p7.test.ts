/**
 * P7 regressions on the REAL resources (docs/PLAN.md, "P7 · Explicit task progress"):
 *  D. undo after a restart leaves the task pending AND scheduled, never pending and absent.
 *  E. an undo re-plans without ever clearing a day off left by a days shift.
 *  F. POST /plan/regenerate {from: today} keeps history, splits nothing below minPartMin, leaves no
 *     hole in today's timeline and never ends the day on a rest.
 * Plus the two notes from the last P2 review: undo never rewrites a past item's status, and an
 * UNKNOWN_ITEM hint for a date past the stored plan says so.
 */
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixedClock, type ManualClock } from "@planner/store";
import { createApi, type Api } from "../src/app.ts";
// These build an API over the owner's own plan files, which are gitignored.
import { hasRealPlans } from "../../../packages/core/test/real-plans.ts";
import { checkDay, cleanup, enc, expectError, mins, ms, notAuthorized, tasksOf, tempDir } from "./helpers.ts";

const checkDayTz = (d: any) => checkDay(d, TZ);

const TZ = "Europe/Paris";
const RESOURCES = resolve(import.meta.dirname, "../../../resources");
const TODAY = "2026-09-28";
const NOW = `${TODAY}T10:15:00+02:00`;

interface Real {
  api: Api;
  dir: string;
  clock: ManualClock;
  get<T = any>(url: string): Promise<{ status: number; body: T }>;
  post<T = any>(url: string, payload?: unknown): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

const open: Real[] = [];
const dirs: string[] = [];

/** The API on the real resources/ folder, Europe/Paris, horizon 14. */
async function realApi(o: { now?: string; dir?: string; horizon?: number } = {}): Promise<Real> {
  const dir = o.dir ?? tempDir("planner-p7-");
  if (!o.dir) dirs.push(dir);
  const clock = fixedClock(o.now ?? NOW, TZ);
  const api = await createApi({
    dataDir: dir,
    resourcesDir: RESOURCES,
    clock,
    timeZone: TZ,
    horizon: o.horizon ?? 14,
    pollMs: 0,
    heartbeatMs: 0,
    logger: false,
    syncDebounceMs: 20,
    calendarClient: notAuthorized,
    env: {},
  });
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await api.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object, headers: { "content-type": "application/json" } } : {}) });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };
  const t: Real = { api, dir, clock, get: (u) => call("GET", u), post: (u, p) => call("POST", u, p), close: () => api.close() };
  open.push(t);
  return t;
}

afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
  for (const d of dirs.splice(0)) cleanup(d);
});

const day = async (t: Real, date: string) => (await t.get(`/plan?from=${date}&days=1`)).body.days[0];
const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!hasRealPlans)("D · undo across a restart: pending means scheduled", () => {
  it("skip, restart tomorrow, undo, skip again, undo by key -> bcg/A3 is pending AND scheduled", async () => {
    const t = await realApi();
    const first = await day(t, TODAY);
    const a3 = tasksOf(first).find((i: any) => i.taskUid === "bcg/A3");
    expect(a3, "bcg/A3 is on day 1 of the real plan").toBeTruthy();
    expect((await t.post(`/items/${enc(a3.key)}/status`, { status: "skipped" })).status).toBe(200);
    expect((await t.get("/tasks/bcg%2FA3")).body.status).toBe("skipped");
    await t.close();
    open.length = 0;

    // A new server the next morning: the rollover runs, then the undo.
    const t2 = await realApi({ dir: t.dir, now: "2026-09-29T10:00:00+02:00" });
    const undo1 = await t2.post("/tasks/bcg%2FA3/status", { status: "pending" });
    expect(undo1.status).toBe(200);
    expect(undo1.body.task.status).toBe("pending");
    expect(undo1.body.task.scheduledOn.length, "pending means scheduled").toBeGreaterThan(0);
    expect(t2.api.store.getTaskProgress("bcg/A3")).toEqual({ doneMin: 0, partsDone: 0 });
    // History is immutable: the skipped item of 2026-09-28 was never rewritten to pending.
    expect((await t2.get(`/plan?from=${TODAY}&days=1`)).body.days[0].items.every((i: any) => i.status !== "pending" || i.taskUid !== "bcg/A3")).toBe(true);

    // Skip it again, then undo the NEW item by its key.
    expect((await t2.post("/tasks/bcg%2FA3/status", { status: "skipped" })).status).toBe(200);
    const again = (await t2.get("/tasks/bcg%2FA3")).body;
    expect(again.status).toBe("skipped");
    const item = again.items.find((i: any) => i.date >= "2026-09-29");
    expect(item, "the re-planned item exists").toBeTruthy();
    const undo2 = await t2.post(`/items/${enc(item.key)}/status`, { status: "pending" });
    expect(undo2.status).toBe(200);
    const view = (await t2.get("/tasks/bcg%2FA3")).body;
    expect(view.status).toBe("pending");
    expect(view.scheduledOn.length, `pending with scheduledOn ${JSON.stringify(view.scheduledOn)}`).toBeGreaterThan(0);
    // And it really is on a timeline, not only in the task view.
    const plan = (await t2.get("/plan?from=2026-09-29&days=120")).body.days;
    expect(plan.some((d: any) => d.items.some((i: any) => i.taskUid === "bcg/A3" && i.status === "pending"))).toBe(true);
    for (const d of plan.slice(0, 14)) checkDayTz(d);
  });

  it("UNKNOWN_ITEM: a date past the stored plan says so instead of 'not scheduled on <date>'", async () => {
    const t = await realApi();
    const end = (await t.get("/health")).body.horizon.end;
    const beyond = "2027-03-01";
    const e = expectError(await t.post(`/items/${enc(`${beyond}|bcg/A3|1`)}/status`, { status: "done" }), 404, "UNKNOWN_ITEM");
    expect(e.hint).toContain(`past the stored plan, which ends on ${end}`);
    expect(e.hint).not.toContain(`not scheduled on ${beyond}`);
    const past = expectError(await t.post(`/items/${enc(`2026-09-01|bcg/A3|1`)}/status`, { status: "done" }), 404, "UNKNOWN_ITEM");
    expect(past.hint).toContain("is in the past");
  });
});

describe.skipIf(!hasRealPlans)("E · a days shift is never undone by a re-plan", () => {
  it("skip bcg/A2 at 09:00, shift +1 day, undo -> today stays off and A2 leads the next working day", async () => {
    const t = await realApi({ now: `${TODAY}T09:00:00+02:00` });
    const before = await day(t, TODAY);
    const a2 = tasksOf(before).find((i: any) => i.taskUid === "bcg/A2");
    expect(a2).toBeTruthy();
    expect((await t.post(`/items/${enc(a2.key)}/status`, { status: "skipped" })).status).toBe(200);
    const shifted = await t.post("/plan/shift", { amount: 1, unit: "days" });
    expect(shifted.status).toBe(200);
    const off = await day(t, TODAY);
    expect(off.items.every((i: any) => ms(i.start) < ms(`${TODAY}T09:00:00+02:00`)), "today holds only what already started").toBe(true);
    const pendingToday = off.items.filter((i: any) => i.status === "pending" && ms(i.start) >= ms(`${TODAY}T09:00:00+02:00`));
    expect(pendingToday).toEqual([]);

    const undo = await t.post("/tasks/bcg%2FA2/status", { status: "pending" });
    expect(undo.status).toBe(200);
    // Invariant 6: replan never clears a day off.
    const after = await day(t, TODAY);
    expect(after.items.filter((i: any) => i.status === "pending" && ms(i.start) >= ms(`${TODAY}T09:00:00+02:00`)), "today stayed a day off").toEqual([]);
    expect(after.items.map((i: any) => i.key)).toEqual(off.items.map((i: any) => i.key));
    // A2 is at the front of the next working day.
    const tomorrow = await day(t, nextDay(TODAY));
    const prep = tasksOf(tomorrow).filter((i: any) => i.track === "bcg");
    expect(prep[0].taskUid).toBe("bcg/A2");
    expect((await t.get("/tasks/bcg%2FA2")).body).toMatchObject({ status: "pending", scheduledOn: [nextDay(TODAY)] });
    checkDayTz(tomorrow);
  });

  it("the SKILL.md sequence: skip A2 and A3, move everything to tomorrow, undo that skip", async () => {
    const t = await realApi({ now: `${TODAY}T09:00:00+02:00` });
    for (const uid of ["bcg/A2", "bcg/A3"]) expect((await t.post(`/tasks/${enc(uid)}/status`, { status: "skipped" })).status).toBe(200);
    expect((await t.post("/plan/shift", { amount: 1, unit: "days" })).status).toBe(200);
    const off = await day(t, TODAY);
    expect((await t.post("/tasks/bcg%2FA2/status", { status: "pending" })).status).toBe(200);
    const after = await day(t, TODAY);
    expect(after.items.map((i: any) => [i.key, i.status])).toEqual(off.items.map((i: any) => [i.key, i.status]));
    const tomorrow = await day(t, nextDay(TODAY));
    expect(tasksOf(tomorrow).filter((i: any) => i.track === "bcg")[0].taskUid).toBe("bcg/A2");
    expect(tasksOf(tomorrow).some((i: any) => i.taskUid === "bcg/A3")).toBe(false); // still skipped
    // Only the explicit rebuild may clear the day off, and it says which dates it cleared.
    const regen = await t.post("/plan/regenerate", { from: TODAY });
    expect(regen.status).toBe(200);
    expect(regen.body.clearedDaysOff).toContain(TODAY);
    expect(tasksOf(await day(t, TODAY)).some((i: any) => ms(i.start) >= ms(`${TODAY}T09:00:00+02:00`))).toBe(true);
  });

  /**
   * Emptying today has to leave it actually empty. A days shift keeps whatever already started, so
   * the first task and the rest behind it stay; undoing that task takes the task away and used to
   * leave the rest standing alone - a day off whose daily view still said "Rest", separating nothing
   * from nothing. An emptied day has no rebuild coming, so the trim cannot wait for one.
   */
  it("undoing the last task of a day off leaves no rest behind", async () => {
    // 08:45 is inside the first rest, so the first task has run and the rest is current.
    const t = await realApi({ now: `${TODAY}T08:45:00+02:00` });
    const first = tasksOf(await day(t, TODAY))[0];
    expect((await t.post("/plan/shift", { amount: 1, unit: "days" })).status).toBe(200);

    const off = await day(t, TODAY);
    expect(tasksOf(off).map((i: any) => i.taskUid), "the task that already started stays").toEqual([first.taskUid]);
    expect(off.items.at(-1)!.kind, "and the rest behind it with it").toBe("rest");

    expect((await t.post(`/items/${enc(first.key)}/status`, { status: "pending" })).status).toBe(200);
    const after = await day(t, TODAY);
    expect(after.items, "the day off is empty, rest included").toEqual([]);
    // The work was not lost: it leads the next working day.
    expect(tasksOf(await day(t, nextDay(TODAY)))[0].taskUid).toBe(first.taskUid);
  });
});

describe.skipIf(!hasRealPlans)("F · regenerate {from: today}", () => {
  const MIN_PART = 15;

  /** No hole: every item starts exactly when the one before it ends. */
  function expectContiguous(d: any, label: string) {
    for (let i = 1; i < d.items.length; i++) {
      const gap = (ms(d.items[i].start) - ms(d.items[i - 1].end)) / 60_000;
      expect(gap, `${label}: ${gap}-min hole before ${d.items[i].key}`).toBe(0);
    }
    expect(d.items.at(-1)?.kind ?? "task", `${label}: trailing rest`).toBe("task");
  }

  it("keeps past, in-progress and checked items, and splits nothing below minPartMin", async () => {
    const t = await realApi({ now: `${TODAY}T11:05:00+02:00` });
    const before = (await t.get("/today")).body;
    const past = before.day.items.filter((i: any) => ms(i.end) <= ms(before.now));
    const current = before.current;
    const done = past.filter((i: any) => i.kind === "task")[0];
    await t.post(`/items/${enc(done.key)}/status`, { status: "done" });
    const later = tasksOf(before.day).filter((i: any) => ms(i.start) > ms(before.now) && !i.taskUid.endsWith("/DAILY")).slice(0, 2);
    for (const l of later) await t.post(`/items/${enc(l.key)}/status`, { status: "skipped" });

    const r = await t.post("/plan/regenerate", { from: TODAY });
    expect(r.status).toBe(200);
    const after = (await t.get("/today")).body.day;
    for (const p of past) if (p.kind === "task") expect(after.items.concat(after.checked).some((i: any) => i.key === p.key), `${p.key} kept`).toBe(true);
    expect(after.items.find((i: any) => i.key === current.key)).toMatchObject({ start: current.start, end: current.end });
    expect(after.items.find((i: any) => i.key === done.key)).toMatchObject({ status: "done" });
    expect(after.checked.map((i: any) => i.key).sort()).toEqual(later.map((l: any) => l.key).sort());
    for (const i of tasksOf(after)) expect(mins(i), `${i.key} is a fragment`).toBeGreaterThanOrEqual(MIN_PART);
    expectContiguous(after, "after regenerate");
    checkDayTz(after);
  });

  it.each([
    [35, "minutes"],
    [2, "hours"],
  ] as const)("leaves no hole and no trailing rest after a +%d %s shift", async (amount, unit) => {
    const t = await realApi({ now: `${TODAY}T10:25:00+02:00` });
    expect((await t.post("/plan/shift", { amount, unit })).status).toBe(200);
    const shifted = (await t.get("/today")).body.day;
    expectContiguous(shifted, `after +${amount} ${unit}`);
    const r = await t.post("/plan/regenerate", { from: TODAY });
    expect(r.status).toBe(200);
    const after = (await t.get("/today")).body;
    expectContiguous(after.day, `after +${amount} ${unit} then regenerate`);
    // The shift is kept: new work never starts before the shifted first pending task.
    const firstNew = tasksOf(after.day).find((i: any) => ms(i.start) >= ms(after.now));
    const resume = tasksOf(shifted).find((i: any) => ms(i.start) >= ms(after.now));
    if (firstNew && resume) expect(ms(firstNew.start)).toBeGreaterThanOrEqual(ms(resume.start));
    for (const i of tasksOf(after.day)) expect(mins(i), `${i.key} is a fragment`).toBeGreaterThanOrEqual(MIN_PART);
    checkDayTz(after.day);
  });

  it("the added rest covers the whole gap up to the shift's resume point (the 60-min hole)", async () => {
    // A6 13:50-14:30 is in progress at 14:25; +60 min moves the lessons block from 14:40 to 15:40.
    // The rest after A6 must then last 14:30-15:40, not 10 minutes with a 60-minute hole after it.
    const t = await realApi({ now: `${TODAY}T14:25:00+02:00` });
    expect((await t.post("/plan/shift", { amount: 60, unit: "minutes" })).status).toBe(200);
    const shifted = (await t.get("/today")).body.day;
    expectContiguous(shifted, "after +60 minutes");
    expect((await t.post("/plan/regenerate", { from: TODAY })).status).toBe(200);
    const after = (await t.get("/today")).body.day;
    expectContiguous(after, "after regenerate from now");
    const inProgress = after.items.find((i: any) => i.taskUid === "bcg/A6");
    const rest = after.items[after.items.indexOf(inProgress) + 1];
    expect(rest.kind).toBe("rest");
    expect(ms(rest.end)).toBe(ms(after.items[after.items.indexOf(rest) + 1].start));
    expect(mins(rest)).toBeGreaterThanOrEqual(10);
    checkDayTz(after);
  });

  it("evening: when nothing else fits, the day does not end on a rest", async () => {
    const t = await realApi({ now: `${TODAY}T16:45:00+02:00` });
    expect((await t.post("/plan/shift", { amount: 5, unit: "hours" })).status).toBe(200);
    expect((await t.post("/plan/regenerate", { from: TODAY })).status).toBe(200);
    const after = (await t.get("/today")).body.day;
    expectContiguous(after, "evening regenerate");
    checkDayTz(after);
  });
});

/**
 * Second review round: the same "derive it from the plan" pattern in two more places, plus three
 * smaller notes. Each one is the critic's own repro.
 */
describe.skipIf(!hasRealPlans)("round 2 · days off, held sessions, holes, history and part labels", () => {
  const PARIS_OFF = (date: string) => (date < "2026-10-25" ? "+02:00" : "+01:00");
  const at = (date: string, hm: string) => ms(`${date}T${hm}:00${PARIS_OFF(date)}`);
  const pending = (d: any) => d.items.filter((i: any) => i.kind === "task" && i.status === "pending");
  const plan = async (t: Real, from: string, days: number) => (await t.get(`/plan?from=${from}&days=${days}`)).body.days;

  it("1a · off_until follows where the work landed: +1d then +1d survives a status change", async () => {
    const twice = await realApi({ now: `2026-09-29T06:00:00+02:00`, horizon: 28 });
    expect((await twice.post("/plan/shift", { amount: 1, unit: "days" })).status).toBe(200);
    expect((await twice.post("/plan/shift", { amount: 1, unit: "days" })).status).toBe(200);
    const once = await realApi({ now: `2026-09-29T06:00:00+02:00`, horizon: 28 });
    expect((await once.post("/plan/shift", { amount: 2, unit: "days" })).status).toBe(200);
    const shape = (days: any[]) => days.map((d) => [d.date, d.items.map((i: any) => `${i.key} ${i.start}`)]);
    expect(shape(await plan(twice, "2026-09-29", 10))).toEqual(shape(await plan(once, "2026-09-29", 10)));
    expect(pending((await plan(twice, "2026-09-30", 1))[0]), "09-30 is a day off").toEqual([]);

    // One checkbox must not silently bring the day off back.
    for (const t of [twice, once]) {
      const r = await t.post(`/items/${enc("2026-10-01|bcg/SKIP|1")}/status`, { status: "done" });
      expect(r.status).toBe(200);
      expect(pending((await plan(t, "2026-09-30", 1))[0]).map((i: any) => i.key), "the day off stayed off").toEqual([]);
    }
    expect(shape(await plan(twice, "2026-09-29", 10))).toEqual(shape(await plan(once, "2026-09-29", 10)));
  });

  it("1b · late at night, a +1d shift that empties tomorrow records tomorrow as the day off", async () => {
    const t = await realApi({ now: `2026-09-29T23:55:00+02:00`, horizon: 28 });
    expect((await t.post("/plan/shift", { amount: 1, unit: "days" })).status).toBe(200);
    expect(pending((await plan(t, "2026-09-30", 1))[0]), "09-30 is empty").toEqual([]);
    expect(t.api.store.getMeta("off_until")).toBe("2026-09-30");
    const first = (await plan(t, "2026-10-01", 1))[0];
    expect(pending(first).length).toBeGreaterThan(0);
    // Any status change keeps it empty.
    expect((await t.post(`/items/${enc(pending(first)[0].key)}/status`, { status: "done" })).status).toBe(200);
    expect(pending((await plan(t, "2026-09-30", 1))[0]).map((i: any) => i.key)).toEqual([]);
  });

  it.each([
    [12, "hours"],
    [1, "days"],
  ] as const)("2 · a skipped session is held: it is never handed out again by a +%d %s shift", async (amount, unit) => {
    const t = await realApi({ now: `2026-09-29T11:59:00+02:00`, horizon: 90 });
    const lessons = async () => {
      const days = await plan(t, "2026-09-28", 120);
      return new Set(days.filter((d: any) => [...d.items, ...d.checked].some((i: any) => i.taskUid === "lessons/DAILY")).map((d: any) => d.date));
    };
    expect((await lessons()).size).toBe(28);
    const r = await t.post("/tasks/lessons%2FDAILY/status", { status: "skipped", date: "2026-09-29" });
    expect(r.status).toBe(200);
    expect(r.body.task.progress.sessionsHeld, "the skipped session is recorded as held").toBeGreaterThanOrEqual(1);
    expect(t.api.store.heldSessionDates("lessons/DAILY")).toContain("2026-09-29");
    expect((await lessons()).size).toBe(28);
    expect((await t.post("/plan/shift", { amount, unit })).status).toBe(200);
    expect([...(await lessons())].length, "28 sessions, skipped one included").toBe(28);
    expect((await lessons()).has("2026-09-29")).toBe(true);
  });

  it("3 · regenerating at or after the end of a rest leaves no unlabelled hole", async () => {
    const t = await realApi({ now: `2026-09-29T06:00:00+02:00`, horizon: 28 });
    await t.close();
    open.splice(open.indexOf(t), 1);
    const t2 = await realApi({ dir: t.dir, now: `2026-09-29T12:00:00+02:00`, horizon: 28 });
    expect((await t2.post("/plan/shift", { amount: 1, unit: "days" })).status).toBe(200);
    const beforeEnd = (await t2.get("/today")).body.day.items.at(-1);
    expect(beforeEnd.kind).toBe("task");
    await t2.close();
    open.splice(open.indexOf(t2), 1);
    // now is 10 minutes after the day's last task ended, so the rest after it is entirely in the past.
    const t3 = await realApi({ dir: t.dir, now: `2026-09-29T12:10:00+02:00`, horizon: 28 });
    expect((await t3.post("/plan/regenerate", { from: "2026-09-29" })).status).toBe(200);
    const day = (await t3.get("/today")).body.day;
    for (let i = 1; i < day.items.length; i++) {
      const gap = (ms(day.items[i].start) - ms(day.items[i - 1].end)) / 60_000;
      expect(gap, `${gap}-min hole before ${day.items[i].key}`).toBe(0);
    }
    expect(day.items.at(-1).kind).toBe("task");
    checkDayTz(day);
  });

  it("4 · history holds only what happened: no pending item survives on a past date", async () => {
    const t = await realApi({ now: `2026-09-29T06:00:00+02:00`, horizon: 28 });
    expect(pending((await plan(t, "2026-09-29", 1))[0]).length).toBeGreaterThan(0);
    await t.close();
    open.splice(open.indexOf(t), 1);
    const t2 = await realApi({ dir: t.dir, now: `2026-10-02T09:17:00+02:00`, horizon: 28 });
    expect((await t2.get("/today")).body.date).toBe("2026-10-02");
    for (const d of await plan(t2, "2026-09-29", 4)) {
      if (d.date >= "2026-10-02") continue;
      expect(d.items.filter((i: any) => i.status === "pending").map((i: any) => i.key), `${d.date} still has pending items`).toEqual([]);
    }
    for (const uid of ["lessons/DAILY", "portfolio/DAILY"]) {
      const view = (await t2.get(`/tasks/${enc(uid)}`)).body;
      expect(view.items.filter((i: any) => i.date < "2026-10-02" && i.status === "pending"), `${uid} keeps stale history`).toEqual([]);
      // A session is spent by *acting* on it, not by its date going by. Three days passed with these
      // untouched, so none of them was consumed: the series slides and finishes three days later.
      // (This replaced the opposite assertion - "sessions were harvested before the purge" - which
      // made a day you ignored cost you a lesson for ever.)
      expect(view.progress.sessionsHeld ?? 0, `${uid} spent a session on a day that was never done`).toBe(0);
    }
    // And the work really is still coming: the capped track still has its full allowance ahead.
    const lessons = (await t2.get(`/tasks/${enc("lessons/DAILY")}`)).body;
    expect(lessons.scheduledOn.length, "the lessons series continues after three ignored days").toBeGreaterThan(0);
  });

  it("5 · part labels follow the timeline: never part 2/2 above part 1/2", async () => {
    const t = await realApi({ now: `2026-09-29T06:00:00+02:00`, horizon: 28 });
    const days = await plan(t, "2026-09-29", 28);
    const all = days.flatMap((d: any) => d.items.map((i: any) => ({ ...i, date: d.date })));
    const split = all.find((i: any) => i.part && i.part.total > 1 && i.date > "2026-10-02" && !i.taskUid.endsWith("/DAILY"));
    expect(split, "the 28-day plan has a split task after 10-02").toBeTruthy();
    expect((await t.post(`/items/${enc(split.key)}/status`, { status: "done" })).status).toBe(200);
    const after = (await t.get(`/tasks/${enc(split.taskUid)}`)).body;
    const parts = after.items.filter((i: any) => i.part).sort((a: any, b: any) => ms(a.start) - ms(b.start));
    expect(parts.map((i: any) => i.part.index), `${split.taskUid} labels out of order`).toEqual(parts.map((_: any, k: number) => k + 1));
    for (const i of parts) expect(i.title.endsWith(`(part ${i.part.index}/${i.part.total})`)).toBe(true);
    // The minutes still add up to the duration.
    expect(after.items.reduce((n: number, i: any) => n + (ms(i.end) - ms(i.start)) / 60_000, 0)).toBe(after.durationMin);
  });
});

/**
 * Third review round. Note 1 is a correction to docs/PLAN.md itself: a task closes only when every
 * minute of it is done, never because an item carried the last part label.
 */
describe.skipIf(!hasRealPlans)("round 3 · closing rule, validation order, days off, slot order", () => {
  const pendingOf = (d: any) => d.items.filter((i: any) => i.kind === "task" && i.status === "pending");

  it("1 · marking the LAST part of a split task done leaves the earlier minutes to do", async () => {
    const t = await realApi({ now: "2026-09-30T08:05:00+02:00", horizon: 90 });
    const before = (await t.get("/tasks/bcg%2FMOCK-2")).body;
    expect(before.durationMin).toBe(120);
    expect(before.items.map((i: any) => [i.key, i.part])).toEqual([
      ["2026-10-07|bcg/MOCK-2|1", { index: 1, total: 2 }],
      ["2026-10-08|bcg/MOCK-2|2", { index: 2, total: 2 }],
    ]);

    const r = await t.post(`/items/${enc("2026-10-08|bcg/MOCK-2|2")}/status`, { status: "done" });
    expect(r.status).toBe(200);
    const after = (await t.get("/tasks/bcg%2FMOCK-2")).body;
    expect(after.progress).toEqual({ doneMin: 60, partsDone: 1, remainingMin: 60 });
    expect(after.status, "60 of 120 minutes are done, so the task is not").toBe("pending");
    expect(after.scheduledOn.length, "the other 60 minutes are still scheduled").toBeGreaterThan(0);
    const placed = after.items.filter((i: any) => i.status === "pending").reduce((n: number, i: any) => n + mins(i), 0);
    expect(placed, "exactly the remaining minutes are on the plan").toBe(60);

    // Marking the rest done closes it, and the undo gives every minute back.
    const rest = after.items.find((i: any) => i.status === "pending");
    expect((await t.post(`/items/${enc(rest.key)}/status`, { status: "done" })).status).toBe(200);
    const closed = (await t.get("/tasks/bcg%2FMOCK-2")).body;
    expect(closed.status).toBe("done");
    expect(closed.progress).toMatchObject({ doneMin: 120, remainingMin: 0 });
    expect(closed.scheduledOn).toEqual([]);
    expect((await t.post("/tasks/bcg%2FMOCK-2/status", { status: "pending" })).status).toBe(200);
    const undone = (await t.get("/tasks/bcg%2FMOCK-2")).body;
    expect(undone.status).toBe("pending");
    expect(undone.progress).toEqual({ doneMin: 0, partsDone: 0, remainingMin: 120 });
    expect(undone.items.filter((i: any) => i.status === "pending").reduce((n: number, i: any) => n + mins(i), 0)).toBe(120);
  });

  it("2 · an invalid amount is 400 whatever today still holds", async () => {
    const late = await realApi({ now: "2026-10-23T23:55:00+02:00", horizon: 28 });
    for (const body of [{ amount: 0, unit: "minutes" }, { amount: -5, unit: "hours" }, { amount: 1.5, unit: "hours" }]) {
      const e = expectError(await late.post("/plan/shift", body), 400, "INVALID_INPUT");
      expect(e.hint).toBeTruthy();
      expectError(await late.post("/plan/shift/preview", body), 400, "INVALID_INPUT");
    }
    // A valid amount with nothing left to move is still the documented 409.
    expectError(await late.post("/plan/shift", { amount: 10, unit: "minutes" }), 409, "CONFLICT");
    // And the same bodies answer 400 earlier in the day, as they always did.
    const early = await realApi({ now: "2026-10-23T09:00:00+02:00", horizon: 28 });
    expectError(await early.post("/plan/shift", { amount: 0, unit: "minutes" }), 400, "INVALID_INPUT");
  });

  it("3 · an in-place undo never puts pending work back on a day off", async () => {
    // 2026-10-25 is the Paris fall-back day; at 11:00 bcg/A2 (09:40-10:20) has run, so a days shift
    // keeps it on today's timeline while every later minute of today moves away.
    const t = await realApi({ now: "2026-10-25T11:00:00+01:00", horizon: 7 });
    const today = (await t.get("/today")).body.date;
    expect(today).toBe("2026-10-25");
    const a2 = (await t.get(`/plan?from=${today}&days=1`)).body.days[0].items.find((i: any) => i.taskUid === "bcg/A2");
    expect(a2).toBeTruthy();
    expect((await t.post(`/items/${enc(a2.key)}/status`, { status: "done" })).status).toBe(200);
    expect((await t.post("/plan/shift", { amount: 3, unit: "days" })).status).toBe(200);
    const now = ms((await t.get("/today")).body.now);
    // A day off holds no work to do: today keeps only what already started.
    const ahead = (d: any) => pendingOf(d).filter((i: any) => ms(i.start) >= now).map((i: any) => i.key);
    expect(ahead((await t.get(`/plan?from=${today}&days=1`)).body.days[0]), "today is a day off").toEqual([]);
    expect((await t.get(`/plan?from=${today}&days=1`)).body.days[0].items.some((i: any) => i.key === a2.key), "A2 is still on it").toBe(true);

    const undo = await t.post(`/items/${enc(a2.key)}/status`, { status: "pending" });
    expect(undo.status).toBe(200);
    expect(undo.body.replanned).toBe(true);
    const day = (await t.get(`/plan?from=${today}&days=1`)).body.days[0];
    expect(ahead(day), "still a day off after the undo").toEqual([]);
    expect(day.items.some((i: any) => i.key === a2.key), "the undone item was removed, not left pending").toBe(false);
    for (const d of (await t.get(`/plan?from=${today}&days=3`)).body.days.slice(1)) expect(pendingOf(d), `${d.date} is off`).toEqual([]);
    const view = (await t.get("/tasks/bcg%2FA2")).body;
    expect(view.status).toBe("pending");
    expect(view.scheduledOn.length).toBeGreaterThan(0);
    expect(view.scheduledOn[0] > "2026-10-27", `landed on ${view.scheduledOn[0]}, not after the days off`).toBe(true);
  });

  it("4 · the rest of today never goes back a slot, and a stretched bridge rest says so", async () => {
    const rank: Record<string, number> = { bcg: 0, salesforce: 0, anthropic: 0, lessons: 1, portfolio: 2, apply: 3 };
    const t = await realApi({ now: "2026-09-30T16:45:00+02:00", horizon: 90 });
    expect((await t.post("/plan/shift", { amount: 4, unit: "hours" })).status).toBe(200);
    await t.close();
    open.splice(open.indexOf(t), 1);
    // The portfolio block now sits at 20:50; skipping it frees 60 min after the lessons slot has run.
    const t2 = await realApi({ dir: t.dir, now: "2026-09-30T17:00:00+02:00", horizon: 90 });
    const pf = (await t2.get("/today")).body.day.items.find((i: any) => i.taskUid === "portfolio/DAILY");
    expect(ms(pf.start)).toBe(ms("2026-09-30T20:50:00+02:00"));
    expect((await t2.post(`/items/${enc(pf.key)}/status`, { status: "skipped" })).status).toBe(200);
    await t2.close();
    open.splice(open.indexOf(t2), 1);

    const t3 = await realApi({ dir: t.dir, now: "2026-09-30T20:00:00+02:00", horizon: 90 });
    expect((await t3.post("/plan/regenerate", { from: "2026-09-30" })).status).toBe(200);
    const day = (await t3.get("/today")).body.day;
    const ranks = day.items.filter((i: any) => i.kind === "task").map((i: any) => rank[i.track]);
    expect(ranks, "the day's slot order never goes backwards").toEqual([...ranks].sort((a: number, b: number) => a - b));
    expect(day.items.at(-1).taskUid, "nothing is placed after the lessons slot").toBe("lessons/DAILY");
    checkDayTz(day);

    // A bridge rest that covers hours is not presented as the 10-minute rest.
    const t4 = await realApi({ now: "2026-09-30T14:25:00+02:00", horizon: 28 });
    expect((await t4.post("/plan/shift", { amount: 60, unit: "minutes" })).status).toBe(200);
    expect((await t4.post("/plan/regenerate", { from: "2026-09-30" })).status).toBe(200);
    const rests = (await t4.get("/today")).body.day.items.filter((i: any) => i.kind === "rest");
    const stretched = rests.filter((i: any) => mins(i) > (i.restKind === "long" ? 60 : 10));
    expect(stretched.length, "the shift left a stretched rest").toBeGreaterThan(0);
    for (const r of stretched) expect(r.title, `${mins(r)} min titled "${r.title}"`).not.toBe(r.restKind === "long" ? "Long rest" : "Rest");
    for (const r of rests.filter((i: any) => mins(i) <= (i.restKind === "long" ? 60 : 10)))
      expect(r.title).toBe(r.restKind === "long" ? "Long rest" : "Rest");
  });
});
