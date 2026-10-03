import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  addDays,
  daysBetween,
  generatePlan,
  loadTaskFiles,
  ShiftError,
  shiftPlan,
  type PlanDay,
  type ShiftInput,
  type ShiftResult,
  type TaskFile,
} from "../src/index.ts";
import { MIN_PART, TZ, assertDayInvariants, assertSlotOrder, hhmm, mins, ms, partsByTask, standardFiles, tasksOf } from "./schedule-helpers.ts";

const FROM = "2026-09-28";
const D2 = addDays(FROM, 1);
const files = standardFiles();
const base = (from = FROM, days = 7, timeZone = TZ, f: TaskFile[] = files) => generatePlan({ files: f, from, days, anchor: FROM, config: { timeZone } });
const at = (hm: string, date = FROM, off = "+01:00") => `${date}T${hm}:00${off}`;
const shift = (plan: PlanDay[], now: string, amount: number, unit: ShiftInput["unit"], extra: Partial<ShiftInput> = {}) =>
  shiftPlan({ plan, now, amount, unit, files, anchor: FROM, config: { timeZone: TZ }, ...extra });
const byKey = (days: PlanDay[]) => new Map(days.flatMap((d) => d.items).map((i) => [i.key, i]));
const find = (d: PlanDay, uid: string) => d.items.find((i) => i.taskUid === uid)!;
const span = (i: { start: string; end: string }) => `${hhmm(i.start)}-${hhmm(i.end)}`;
const sessions = (days: PlanDay[], track = "lessons") => days.filter((d) => tasksOf(d).some((t) => t.track === track)).length;

/**
 * After every shift: today keeps the rest rules with no holes (a rest may be stretched over the time
 * the shift opened; a trailing in-progress rest is allowed); every other day is strict: 08:00 start,
 * 10-min rests, long rest after exactly 240 task minutes.
 */
function assertShifted(r: ShiftResult, timeZone = TZ, kindOf?: Parameters<typeof assertSlotOrder>[1]) {
  const keys = r.days.flatMap((d) => d.items.map((i) => i.key));
  expect(new Set(keys).size, "keys unique across the plan").toBe(keys.length);
  expect(r.days[0]!.date).toBe(r.today);
  for (const d of r.days) {
    if (d.date === r.today) assertDayInvariants(d, { timeZone, strictStart: false, stretchedRests: true, allowTrailingRest: true });
    else {
      assertDayInvariants(d, { timeZone });
      assertSlotOrder(d, kindOf);
    }
  }
  for (const it of r.dropped) expect(keys).not.toContain(it.key);
  for (const [uid, p] of partsByTask(r.days)) {
    expect(daysBetween(p[0]!.date, p.at(-1)!.date), uid).toBeLessThanOrEqual(1);
    if (p.length > 1) for (const x of p) expect(x.min, uid).toBeGreaterThanOrEqual(MIN_PART);
  }
}

// Day 1 (Tunis, +01:00), BCG 30-min tasks: Bk starts 08:00 + (k-1) x 40 min up to B8 12:40-13:10,
// long rest 13:10-14:10, B9 14:10-14:40, B10 14:50-15:20, lessons 15:30-17:30, portfolio 17:40-18:40.
describe("shiftPlan by minutes and hours", () => {
  const plan = base();

  it("fixture layout is as documented", () => {
    const d = plan[0]!;
    expect([find(d, "bcg/B8"), d.items.find((i) => i.restKind === "long")!, find(d, "bcg/B9"), find(d, "lessons/DAILY"), find(d, "portfolio/DAILY")].map(span)).toEqual([
      "12:40-13:10",
      "13:10-14:10",
      "14:10-14:40",
      "15:30-17:30",
      "17:40-18:40",
    ]);
  });

  it("moves items starting at or after now; the rest after the in-progress item stretches over the gap", () => {
    const now = at("10:25"); // B4 10:00-10:30 in progress
    const r = shift(plan, now, 15, "minutes");
    const before = plan[0]!.items;
    const after = r.days[0]!.items;
    expect(after.map((i) => i.key)).toEqual(before.map((i) => i.key));
    for (const [i, it] of before.entries()) {
      if (ms(it.start) < ms(now)) expect(after[i], it.key).toEqual(it);
      else expect(ms(after[i]!.end) - ms(it.end), it.key).toBe(15 * 60_000);
      if (it.kind === "task" && ms(it.start) >= ms(now)) expect(ms(after[i]!.start) - ms(it.start)).toBe(15 * 60_000);
    }
    expect(span(find(r.days[0]!, "bcg/B4"))).toBe("10:00-10:30");
    const stretched = after[after.indexOf(find(r.days[0]!, "bcg/B4")) + 1]!;
    expect(stretched).toMatchObject({ kind: "rest", restKind: "short" });
    expect(span(stretched)).toBe("10:30-10:55");
    expect(hhmm(find(r.days[0]!, "bcg/B5").start)).toBe("10:55");
    assertDayInvariants(r.days[0]!, { strictStart: true, stretchedRests: true }); // contiguous: no holes
    expect([r.removedKeys, r.added, r.regeneratedDates, r.dropped]).toEqual([[], [], [], []]);
    expect(r.days.slice(1)).toEqual(plan.slice(1));
    assertShifted(r);
  });

  it("a shift made exactly at a boundary leaves no hole: the rest starting now stretches back", () => {
    const r = shift(plan, at("09:10"), 30, "minutes"); // B2 ended 09:10; its rest starts 09:10
    const d = r.days[0]!;
    const i = d.items.indexOf(find(d, "bcg/B2"));
    expect(span(d.items[i + 1]!)).toBe("09:10-09:50");
    expect(hhmm(find(d, "bcg/B3").start)).toBe("09:50");
    assertDayInvariants(d, { stretchedRests: true });
  });

  it("shifts by hours; before the day starts everything moves as one block", () => {
    const r = shift(plan, at("07:30"), 2, "hours");
    expect(r.days[0]!.items[0]!.start).toBe(at("10:00"));
    assertDayInvariants(r.days[0]!, { strictStart: false });
    expect(r.moved).toHaveLength(plan[0]!.items.length);
    assertShifted(r);
  });

  it("a shift crossing the long rest keeps it right after 240 task minutes, stretched over the shift", () => {
    const r = shift(plan, at("12:50"), 45, "minutes");
    const d = r.days[0]!;
    expect(span(find(d, "bcg/B8"))).toBe("12:40-13:10"); // in progress: unchanged
    const long = d.items.find((i) => i.restKind === "long")!;
    expect(span(long)).toBe("13:10-14:55");
    expect(hhmm(find(d, "bcg/B9").start)).toBe("14:55");
    assertShifted(r);
  });

  it("an in-progress item keeps its times; the rest after it covers the gap", () => {
    const r = shift(plan, at("09:00"), 30, "minutes");
    const d = r.days[0]!;
    const b2 = find(d, "bcg/B2");
    expect(b2).toEqual(find(plan[0]!, "bcg/B2"));
    const next = d.items[d.items.indexOf(b2) + 1]!;
    expect(next).toMatchObject({ kind: "rest", restKind: "short" });
    expect(span(next)).toBe("09:10-09:50");
    assertShifted(r);
  });

  it("an in-progress rest stretches to the next moved task", () => {
    const r = shift(plan, at("13:30"), 20, "minutes");
    const long = r.days[0]!.items.find((i) => i.restKind === "long")!;
    expect(span(long)).toBe("13:10-14:30");
    expect(hhmm(find(r.days[0]!, "bcg/B9").start)).toBe("14:30");
    assertShifted(r);
  });

  it("crossing midnight: one-off overflow leads tomorrow, daily items are dropped and their sessions added back", () => {
    const long = base(FROM, 35);
    const r = shift(long, at("13:30"), 580, "minutes"); // during the long rest; B9 14:10 -> 23:50
    const today = r.days[0]!;
    const b9 = find(today, "bcg/B9");
    expect([b9.start, b9.end]).toEqual([at("23:50"), at("00:20", D2)]); // starts before midnight: stays
    expect(today.items.at(-1)).toBe(b9);
    expect(span(today.items.find((i) => i.restKind === "long")!)).toBe("13:10-23:50");
    expect(r.carryIn).toEqual(["bcg/B10"]); // ordering only: the minutes come from `progress`
    expect(r.days[1]!.items[0]).toMatchObject({ taskUid: "bcg/B10", title: "bcg B10", start: at("08:00", D2), end: at("08:30", D2) });
    expect(r.dropped.map((i) => i.taskUid)).toEqual(["lessons/DAILY", "portfolio/DAILY"]);
    expect(r.removedKeys).toEqual(expect.arrayContaining([`${FROM}|lessons/DAILY|1`, `${FROM}|bcg/B10|1`]));
    expect(r.regeneratedDates).toEqual(long.slice(1).map((d) => d.date));
    expect(sessions(r.days)).toBe(28);
    assertShifted(r);
  });

  it("an overflow of only daily items without occurrences regenerates nothing", () => {
    const r = shift(plan, at("15:25"), 7, "hours"); // lessons 22:30 (stays), portfolio 00:40 (dropped)
    expect(r.dropped.map((i) => i.taskUid)).toEqual(["portfolio/DAILY"]);
    expect(r.regeneratedDates).toEqual([]);
    assertShifted(r);
  });

  it("repeated shifts keep every invariant", () => {
    let p = plan;
    const steps: [string, number, ShiftInput["unit"]][] = [
      [at("08:20"), 20, "minutes"],
      [at("09:55"), 1, "hours"],
      [at("12:45"), 35, "minutes"],
      [at("14:00"), 3, "hours"],
      [at("17:00"), 5, "hours"],
      [at("19:30"), 45, "minutes"],
    ];
    for (const [now, n, unit] of steps) {
      const r = shift(p, now, n, unit);
      assertShifted(r);
      const prev = byKey(p);
      // Items that already started keep their start; only a rest may stretch its end.
      for (const it of r.days[0]!.items) {
        const o = prev.get(it.key);
        if (o && ms(o.start) < ms(now)) {
          expect(it.start).toBe(o.start);
          if (it.kind === "task") expect(it.end).toBe(o.end);
        }
      }
      p = r.days;
    }
  });
});

describe("shiftPlan by days", () => {
  const plan = base();

  it("today keeps past + in-progress items; the rest is regenerated from today+N at 08:00, remaining tasks first", () => {
    const r = shift(plan, at("12:05"), 1, "days"); // B7 12:00-12:30 in progress
    const today = r.days[0]!;
    expect(tasksOf(today).map((t) => t.taskUid)).toEqual(["bcg/B1", "bcg/B2", "bcg/B3", "bcg/B4", "bcg/B5", "bcg/B6", "bcg/B7"]);
    expect(today.items.at(-1)!.taskUid).toBe("bcg/B7");
    const d2 = r.days[1]!;
    expect(tasksOf(d2).slice(0, 3).map((t) => t.taskUid)).toEqual(["bcg/B8", "bcg/B9", "bcg/B10"]);
    expect(d2.items[0]).toMatchObject({ key: `${D2}|bcg/B8|1`, start: at("08:00", D2) });
    expect(r.carryIn).toEqual(["bcg/B8", "bcg/B9", "bcg/B10"]);
    expect(r.regeneratedDates).toEqual(Array.from({ length: 7 }, (_, i) => addDays(FROM, i + 1)));
    expect(r.days).toHaveLength(8);
    expect(r.dropped.map((i) => i.taskUid)).toEqual(["lessons/DAILY", "portfolio/DAILY"]);
    expect(sessions(r.days)).toBe(7); // today holds none; every later day of the horizon has one
    expect(r.removedKeys).toContain(`${FROM}|bcg/B8|1`);
    assertShifted(r);
  });

  it.each([1, 2])("a rest in progress stays on today (+%d days)", (n) => {
    const r = shift(plan, at("13:30"), n, "days");
    const long = plan[0]!.items.find((i) => i.restKind === "long")!;
    expect(r.days[0]!.items.at(-1)).toEqual(long);
    expect(r.removedKeys).not.toContain(long.key);
    expect(r.days[n]!.items[0]).toMatchObject({ taskUid: "bcg/B9", start: at("08:00", addDays(FROM, n)) });
    assertShifted(r);
  });

  it("the future plan is the old plan moved by N days; days between are off", () => {
    const n = 3;
    const r = shift(plan, at("07:00"), n, "days");
    expect(r.days.slice(0, n).every((d) => d.items.length === 0)).toBe(true);
    for (let i = 0; i < 7; i++) {
      const old = plan[i]!.items.map((x) => [x.title, hhmm(x.start), hhmm(x.end), x.key.slice(10)]);
      expect(r.days[n + i]!.items.map((x) => [x.title, hhmm(x.start), hhmm(x.end), x.key.slice(10)]), `day ${i}`).toEqual(old);
    }
    // Today's lesson and the two days off are simply not held: every working day still has one.
    expect(sessions(r.days)).toBe(7);
    assertShifted(r);
  });

  it.each([
    ["10:00", 1, 1],
    ["07:00", 1, 1],
    ["10:00", 2, 1],
    ["13:30", 1, 2],
  ] as const)("shifts compose: at %s, +%d days then +%d days equals one shift by the sum", (hm, a, b) => {
    const long = base(FROM, 35);
    const r1 = shift(long, at(hm), a, "days");
    const r2 = shift(r1.days, at(hm === "07:00" ? "07:05" : hm.replace(/0$/, "5")), b, "days");
    const once = shift(long, at(hm), a + b, "days");
    expect(r2.days).toEqual(once.days);
    // Existing days off stay off: work resumes on today + a + b.
    for (let i = 1; i < a + b; i++) expect(r2.days[i]!.items, `day ${i} off`).toEqual([]);
    for (const r of [r1, r2, once]) {
      expect(sessions(r.days), "28 lesson sessions").toBe(28);
      assertShifted(r);
    }
  });

  it("generates the whole horizon after today+N", () => {
    const r = shift(plan, at("07:00"), 1, "days", { days: 9 });
    expect(r.regeneratedDates).toEqual(Array.from({ length: 9 }, (_, i) => addDays(FROM, i + 1)));
    expect(r.days.at(-1)!.items[0]!.start).toBe(at("08:00", addDays(FROM, 9)));
    assertShifted(r);
  });

  it("across the Paris DST change: 08:00 local on the new day, offset follows", () => {
    const p = base("2026-10-24", 3, "Europe/Paris");
    const cfg = { timeZone: "Europe/Paris" };
    const r = shiftPlan({ plan: p, now: "2026-10-24T12:05:00+02:00", amount: 1, unit: "days", files, anchor: FROM, config: cfg });
    expect(r.days[1]!.items[0]).toMatchObject({ start: "2026-10-25T08:00:00+01:00", key: expect.stringMatching(/^2026-10-25\|bcg\//) });
    expect(r.days[2]!.items[0]!.start).toBe("2026-10-26T08:00:00+01:00");
    assertShifted(r, "Europe/Paris");
    const m = shiftPlan({ plan: r.days, now: "2026-10-25T07:00:00+01:00", amount: 30, unit: "minutes", files, anchor: FROM, config: cfg });
    expect(m.days[0]!.items[0]!.start).toBe("2026-10-25T08:30:00+01:00");
    assertShifted(m, "Europe/Paris");
  });

  it("repeated day and minute shifts keep every invariant (Africa/Tunis stays +01:00)", () => {
    let r = shift(plan, at("07:00"), 1, "days");
    assertShifted(r);
    const steps: [string, number, ShiftInput["unit"]][] = [
      [at("10:15", D2), 2, "days"],
      [at("09:00", addDays(FROM, 3)), 90, "minutes"],
      [at("20:00", addDays(FROM, 3)), 6, "hours"],
      [at("13:40", addDays(FROM, 4)), 1, "days"],
    ];
    for (const [now, n, unit] of steps) {
      r = shift(r.days, now, n, unit);
      assertShifted(r);
    }
    for (const d of r.days) for (const i of d.items) expect(i.start.endsWith("+01:00")).toBe(true);
  });
});

describe("shiftPlan on the real resources", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const real = loadTaskFiles([`${root}resources`], root).files;
  const kindOf = Object.fromEntries(real.map((f) => [f.meta.track, f.meta.kind]));
  const cfg = { timeZone: "Europe/Paris" };
  const plan = base(FROM, 40, "Europe/Paris", real);
  /** Sessions held before `date` are the ones the plan already ran: the store keeps them as rows. */
  const heldBefore = (date: string) =>
    new Map([["lessons/DAILY", plan.filter((d) => d.date < date && tasksOf(d).some((t) => t.track === "lessons")).map((d) => d.date)]]);
  const run = (date: string, hm: string, n: number, unit: ShiftInput["unit"]) =>
    shiftPlan({
      plan: plan.filter((d) => d.date >= date),
      now: at(hm, date, "+02:00"),
      amount: n,
      unit,
      files: real,
      anchor: FROM,
      config: cfg,
      heldDates: heldBefore(date),
    });

  it.each([
    ["10:00", 45, "minutes"],
    ["12:30", 2, "hours"],
    ["14:00", 11, "hours"],
    ["08:40", 1, "days"],
    ["13:30", 2, "days"],
    ["14:50", 1, "days"],
  ] as const)("now %s +%d %s: every day keeps 240 -> long rest, no fragments", (hm, n, unit) => {
    const r = run(FROM, hm, n, unit);
    assertShifted(r, "Europe/Paris", kindOf);
    expect(sessions(r.days), "28 sessions in total").toBe(28);
  });

  // Lesson sessions held before today + sessions in the shifted plan == 28, for a grid of shifts,
  // including 10-01 where the lesson is split at the 4 h mark.
  const grid: [string, string, number, ShiftInput["unit"]][] = [];
  for (const date of ["2026-09-28", "2026-10-01", "2026-10-02"])
    for (const hm of ["07:30", "08:00", "08:30", "12:00", "13:00", "15:00", "17:30"])
      for (const [n, unit] of [[30, "minutes"], [11, "hours"], [16, "hours"], [1, "days"], [3, "days"]] as const) grid.push([date, hm, n, unit]);
  it(`keeps 28 lesson sessions and every invariant across ${grid.length} shifts`, () => {
    for (const [date, hm, n, unit] of grid) {
      const r = run(date, hm, n, unit);
      const held = sessions(plan.filter((d) => d.date < date));
      expect(held + sessions(r.days), `${date} ${hm} +${n} ${unit}`).toBe(28);
      assertShifted(r, "Europe/Paris", kindOf);
    }
  }, 30_000); // 105 shifts, each regenerating up to ~40 days

  it("a lesson split at the 4 h mark that overflows counts as one session", () => {
    const day = plan.find((d) => tasksOf(d).filter((t) => t.track === "lessons").length === 2);
    if (!day) return; // no split lesson in this plan
    const first = tasksOf(day).find((t) => t.track === "lessons")!;
    // +13 h pushes both parts past midnight: two dropped items, one lost session.
    const r = shiftPlan({
      plan: plan.filter((d) => d.date >= day.date),
      now: first.start,
      amount: 13,
      unit: "hours",
      files: real,
      anchor: FROM,
      config: cfg,
      heldDates: heldBefore(day.date),
    });
    expect(r.dropped.filter((i) => i.track === "lessons")).toHaveLength(2);
    expect(r.days[0]!.items.some((i) => i.taskUid === "lessons/DAILY")).toBe(false); // the date holds no part
    expect(sessions(plan.filter((d) => d.date < day.date)) + sessions(r.days)).toBe(28);
  });
});

describe("shiftPlan validation", () => {
  const plan = base(FROM, 1);
  it.each([0, -5, Number.NaN, Infinity])("rejects amount %s with a typed error", (n) => {
    let e: unknown;
    try {
      shift(plan, at("09:00"), n, "minutes");
    } catch (err) {
      e = err;
    }
    expect(e).toBeInstanceOf(ShiftError);
    expect((e as ShiftError).code).toBe("INVALID_AMOUNT");
    expect((e as ShiftError).hint).toBeTruthy();
  });
  it("rejects fractional amounts, unknown units and a bad now", () => {
    expect(() => shift(plan, at("09:00"), 1.5, "hours")).toThrow(expect.objectContaining({ code: "INVALID_AMOUNT" }));
    expect(() => shift(plan, at("09:00"), 1, "weeks" as never)).toThrow(expect.objectContaining({ code: "INVALID_UNIT" }));
    expect(() => shift(plan, "not a date", 1, "hours")).toThrow(expect.objectContaining({ code: "INVALID_NOW" }));
  });
});
