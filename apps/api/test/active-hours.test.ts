/**
 * Active hours over HTTP: `GET /settings`, `PATCH /settings`, and what the plan does afterwards.
 *
 * The scheduling behaviour itself is proved in `packages/core/test/active-hours.test.ts`. What is
 * tested here is the part the core cannot see: that the setting is durable, that both processes read
 * the same answer, that changing it re-plans **today** and not just tomorrow, and that the answer
 * tells the owner what their window actually grants rather than only what they asked for.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ACTIVE_HOURS } from "@planner/core";
import { PlanService, PlannerStore, fixedClock, loadResources } from "@planner/store";
import { NOW, TODAY, TZ, cleanup, expectError, makeApi, type TestApi } from "./helpers.ts";

let t: TestApi;
afterEach(async () => {
  if (t) {
    await t.close();
    cleanup(t.dir);
  }
});

const hhmm = (iso: string) => iso.slice(11, 16);
const taskMin = (day: any) => day.items.filter((i: any) => i.kind === "task").reduce((n: number, i: any) => n + (Date.parse(i.end) - Date.parse(i.start)) / 60_000, 0);

describe("GET /settings", () => {
  it("reports the defaults, which are the owner's original rules", async () => {
    t = await makeApi();
    const r = await t.get("/settings");
    expect(r.status).toBe(200);
    expect(r.body.activeHours).toEqual({ dayStart: "08:00", dayEnd: "24:00", dailyTaskMin: 480 });
    expect(r.body.defaults).toEqual(DEFAULT_ACTIVE_HOURS);
    expect(r.body.timeZone).toBe(TZ);
    // /health carries them too, so one call is enough to know how the day is shaped.
    expect((await t.get("/health")).body.activeHours).toEqual(r.body.activeHours);
  });

  it("says what the window actually grants, not only what was asked for", async () => {
    t = await makeApi();
    // 10 h of task time inside a 12 h window: the window wins, because crossing 8 h of work buys a
    // second hour-long rest and there is no room for it.
    expect((await t.patch("/settings", { dayEnd: "20:00", dailyTaskMin: 600 })).status).toBe(200);
    const r = await t.get("/settings");
    expect(r.body.activeHours).toEqual({ dayStart: "08:00", dayEnd: "20:00", dailyTaskMin: 600 });
    expect(r.body.effective.dailyTaskMin).toBeLessThan(600);
    expect(r.body.effective.boundBy).toBe("window");
    expect(hhmm(r.body.effective.lastEnd)).not.toBe("");

    // Open the window wide enough and the budget becomes the binding one instead.
    expect((await t.patch("/settings", { dayEnd: "23:30" })).status).toBe(200);
    const wide = await t.get("/settings");
    expect(wide.body.effective.dailyTaskMin).toBe(600);
    expect(wide.body.effective.boundBy).toBe("budget");
  });
});

describe("PATCH /settings", () => {
  it("a later start moves every future day, and today with it", async () => {
    t = await makeApi();
    expect(hhmm((await t.get("/today")).body.day.items[0].start)).toBe("08:00");
    const r = await t.patch("/settings", { dayStart: "10:00" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ changed: true, sync: "queued" });
    // Today is in the rebuild: a setting about when the day runs would look broken if it waited
    // until tomorrow to take effect.
    expect(r.body.regenerated).toContain(TODAY);
    const days = (await t.get("/plan?days=5")).body.days;
    for (const d of days.slice(1)) expect(hhmm(d.items[0].start), d.date).toBe("10:00");
  });

  it("an earlier end shortens the days and pushes the work out", async () => {
    t = await makeApi();
    const before = (await t.get("/plan?days=7")).body.days;
    const r = await t.patch("/settings", { dayEnd: "13:00" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = (await t.get("/plan?days=7")).body.days;
    for (const d of after.slice(1)) {
      expect(taskMin(d), d.date).toBeLessThan(480);
      for (const i of d.items) expect(hhmm(i.end) <= "13:00" || hhmm(i.end) === "00:00", `${i.key} ends ${hhmm(i.end)}`).toBe(true);
    }
    // Less per day means the same tasks reach further out, never that they vanish.
    const uids = (ds: any[]) => new Set(ds.flatMap((d: any) => d.items).filter((i: any) => i.kind === "task").map((i: any) => i.taskUid));
    for (const u of uids(after)) expect(uids(before)).toContain(u);
  });

  it("a bigger budget gives a bigger day, with a long rest at every 4 h", async () => {
    t = await makeApi();
    expect((await t.patch("/settings", { dailyTaskMin: 600, dayEnd: "23:30" })).status).toBe(200);
    // The fullest day, not simply the next one: how much a given day holds also depends on how the
    // remaining tasks divide (a 10 h task cannot be cut into any shape the day wants), so one day
    // being short of the budget is the no-fragment rule, not the window.
    const days = (await t.get("/plan?days=5")).body.days.slice(1);
    const fullest = days.reduce((a: any, b: any) => (taskMin(b) > taskMin(a) ? b : a));
    expect(taskMin(fullest)).toBe(600);
    const longs: number[] = [];
    let acc = 0;
    for (const i of fullest.items) {
      if (i.kind === "task") acc += (Date.parse(i.end) - Date.parse(i.start)) / 60_000;
      else if (i.restKind === "long") longs.push(acc);
    }
    expect(longs).toEqual([240, 480]);
    // And no day exceeds the budget it was given.
    for (const d of days) expect(taskMin(d)).toBeLessThanOrEqual(600);
  });

  it("asking for what is already set changes nothing and says so", async () => {
    t = await makeApi();
    const r = await t.patch("/settings", { dayStart: "08:00" });
    expect(r.body).toMatchObject({ changed: false, regenerated: [], sync: "skipped" });
    expect(t.api.sync.queued).toBe(false);
  });

  it("dryRun validates and re-plans nothing", async () => {
    t = await makeApi();
    const before = JSON.stringify((await t.get("/plan?days=7")).body);
    const r = await t.patch("/settings?dryRun=true", { dayStart: "11:00", dayEnd: "19:00", dailyTaskMin: 420 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, sync: "skipped" });
    expect(r.body.activeHours).toEqual({ dayStart: "11:00", dayEnd: "19:00", dailyTaskMin: 420 });
    expect(r.body.regenerated.length).toBeGreaterThan(0);
    // Nothing stored, nothing moved.
    expect((await t.get("/settings")).body.activeHours).toEqual(DEFAULT_ACTIVE_HOURS);
    expect(JSON.stringify((await t.get("/plan?days=7")).body)).toBe(before);
    expect(t.api.sync.queued).toBe(false);
  });

  it("a window that cannot work is refused, and nothing is stored", async () => {
    t = await makeApi();
    const bad: [string, object, RegExp][] = [
      ["the end before the start", { dayEnd: "06:00" }, /must be after/],
      ["the end equal to the start", { dayStart: "09:00", dayEnd: "09:00" }, /must be after/],
      ["a window that wraps midnight", { dayStart: "22:00", dayEnd: "02:00" }, /wraps midnight|must be after/],
      ["a window too short for a task", { dayStart: "08:00", dayEnd: "08:05" }, /too short/],
      ["a zero budget", { dailyTaskMin: 0 }, /dailyTaskMin/],
      ["a negative budget", { dailyTaskMin: -1 }, /dailyTaskMin/],
      ["a fractional budget", { dailyTaskMin: 30.5 }, /dailyTaskMin/],
      ["a budget longer than a day", { dailyTaskMin: 1441 }, /dailyTaskMin/],
      ["a clock time that is not one", { dayStart: "8am" }, /HH:MM/],
      ["an hour past midnight", { dayEnd: "24:30" }, /HH:MM/],
      ["a start that is not a string", { dayStart: 8 }, /must be a string/],
      ["an unknown setting", { dayBegin: "08:00" }, /unknown setting/],
      ["a typo for a real setting", { dailyTaskMinutes: 600 }, /unknown setting/],
    ];
    for (const [label, patch, message] of bad) {
      const e = expectError(await t.patch("/settings", patch), 400, "INVALID_INPUT");
      expect(e.message, label).toMatch(message);
      expect(e.hint.length, label).toBeGreaterThan(0);
      expect((await t.get("/settings")).body.activeHours, label).toEqual(DEFAULT_ACTIVE_HOURS);
    }
  });

  it("a number sent as a string from a form is accepted", async () => {
    t = await makeApi();
    const r = await t.patch("/settings", { dailyTaskMin: "420" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.activeHours.dailyTaskMin).toBe(420);
  });

  it("an unknown query parameter is refused rather than ignored", async () => {
    t = await makeApi();
    expectError(await t.patch("/settings?dryrun=true", { dayStart: "10:00" }), 400, "INVALID_INPUT");
    expect((await t.get("/settings")).body.activeHours).toEqual(DEFAULT_ACTIVE_HOURS);
  });

  it("publishes one plan event and queues one sync", async () => {
    t = await makeApi();
    const seen: string[] = [];
    const off = t.api.bus.on((e) => seen.push(e.event));
    expect((await t.patch("/settings", { dayStart: "09:00" })).status).toBe(200);
    off();
    expect(seen.filter((x) => x === "plan")).toHaveLength(1);
    expect(t.api.sync.queued).toBe(true);
  });
});

describe("the setting is durable and shared", () => {
  it("survives a restart", async () => {
    const dir = (t = await makeApi()).dir;
    expect((await t.patch("/settings", { dayStart: "07:30", dayEnd: "19:00", dailyTaskMin: 420 })).status).toBe(200);
    await t.close();
    t = await makeApi({ dir });
    expect((await t.get("/settings")).body.activeHours).toEqual({ dayStart: "07:30", dayEnd: "19:00", dailyTaskMin: 420 });
    expect(hhmm((await t.get("/plan?days=3")).body.days[1].items[0].start)).toBe("07:30");
  });

  it("a second process reads the same hours, with no cache to go stale", async () => {
    t = await makeApi();
    expect((await t.patch("/settings", { dayStart: "06:00" })).status).toBe(200);
    // A separate PlanService on the same database, as the daemon has.
    const store = new PlannerStore({ dir: t.dir });
    try {
      const other = new PlanService({
        store,
        clock: fixedClock(NOW, TZ),
        timeZone: TZ,
        horizon: 7,
        files: loadResources(require("node:path").resolve(import.meta.dirname, "fixtures/resources")).files,
      });
      expect(other.activeHours().dayStart).toBe("06:00");
      // And it keeps up with a later change rather than holding the value it first read.
      expect((await t.patch("/settings", { dayStart: "12:00" })).status).toBe(200);
      expect(other.activeHours().dayStart).toBe("12:00");
    } finally {
      store.close();
    }
  });

  it("a corrupt stored value falls back to the defaults instead of breaking every read", async () => {
    t = await makeApi();
    t.api.store.setSetting("active_hours", "{ not json");
    expect((await t.get("/settings")).body.activeHours).toEqual(DEFAULT_ACTIVE_HOURS);
    expect((await t.get("/health")).body.ok).toBe(true);
    expect((await t.get("/today")).body.day.items.length).toBeGreaterThan(0);
    // A value that parses but is no longer valid does the same.
    t.api.store.setSetting("active_hours", JSON.stringify({ dayStart: "20:00", dayEnd: "09:00", dailyTaskMin: 480 }));
    expect((await t.get("/settings")).body.activeHours).toEqual(DEFAULT_ACTIVE_HOURS);
    expect((await t.get("/today")).body.day.items.length).toBeGreaterThan(0);
  });
});

describe("active hours do not break the rest of the plan", () => {
  it("every day stays legal: no overlaps, no item on the wrong date, rests intact", async () => {
    t = await makeApi();
    for (const patch of [{ dayStart: "06:00" }, { dayEnd: "14:00" }, { dailyTaskMin: 600, dayEnd: "23:00" }, { dayStart: "19:00", dayEnd: "23:59" }]) {
      expect((await t.patch("/settings", patch)).status, JSON.stringify(patch)).toBe(200);
      for (const d of (await t.get("/plan?days=7")).body.days) {
        for (let k = 1; k < d.items.length; k++)
          expect(Date.parse(d.items[k].start), `${JSON.stringify(patch)} ${d.items[k].key}`).toBeGreaterThanOrEqual(Date.parse(d.items[k - 1].end));
        for (const i of [...d.items, ...d.checked]) expect(i.date, `${JSON.stringify(patch)} ${i.key}`).toBe(d.date);
        const rests = d.items.filter((i: any) => i.kind === "rest");
        expect(rests.map((r: any) => r.key)).toEqual(rests.map((_: any, n: number) => `${d.date}|rest|${n + 1}`));
      }
    }
  });

  it("a status change still works, and respects the new window", async () => {
    t = await makeApi();
    expect((await t.patch("/settings", { dayStart: "09:00", dayEnd: "17:00" })).status).toBe(200);
    const day = (await t.get("/today")).body.day;
    const item = day.items.find((i: any) => i.kind === "task" && i.status === "pending");
    if (!item) return;
    const r = await t.post(`/items/${encodeURIComponent(item.key)}/status`, { status: "done" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const d of (await t.get("/plan?days=5")).body.days.slice(1)) {
      expect(hhmm(d.items[0].start)).toBe("09:00");
      for (const i of d.items) expect(hhmm(i.end) <= "17:00" || hhmm(i.end) === "00:00").toBe(true);
    }
  });

  it("the fence governs new work, and cannot un-run what already happened today", async () => {
    // It is 10:15 in the fixture clock, so the morning has run. Setting a window that closes at
    // 09:00 cannot retroactively unschedule it: past and in-progress items keep their times, as they
    // do for every other rebuild of today. The fence applies to work still to be placed.
    t = await makeApi();
    const morning = (await t.get("/today")).body.day.items.filter((i: any) => Date.parse(i.start) < Date.parse(NOW));
    expect(morning.length).toBeGreaterThan(0);
    const r = await t.patch("/settings", { dayEnd: "09:00" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const today = (await t.get("/today")).body.day;
    // History is intact...
    for (const m of morning) expect(today.items.some((i: any) => i.key === m.key && i.start === m.start)).toBe(true);
    // ...and from tomorrow on, the fence is absolute.
    for (const d of (await t.get("/plan?days=5")).body.days.slice(1))
      for (const i of d.items) expect(hhmm(i.end) <= "09:00" || hhmm(i.end) === "00:00", `${i.key} ends ${hhmm(i.end)}`).toBe(true);
  });

  it("a shift still works inside the window", async () => {
    t = await makeApi();
    expect((await t.patch("/settings", { dayEnd: "20:00" })).status).toBe(200);
    const r = await t.post("/plan/shift", { amount: 30, unit: "minutes" });
    expect([200, 409]).toContain(r.status);
    if (r.status !== 200) return;
    for (const d of (await t.get("/plan?days=7")).body.days.slice(1))
      for (const i of d.items) expect(hhmm(i.end) <= "20:00" || hhmm(i.end) === "00:00", `${i.key} ends ${hhmm(i.end)}`).toBe(true);
  });
});
