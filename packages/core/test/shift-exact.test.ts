/**
 * The exact (millisecond) shift path: `shiftPlan({ unit: "ms" })`, which pause/resume uses
 * (docs/PLAN.md, P8). It must apply the delta to the millisecond and otherwise behave exactly like a
 * minute shift: gap-to-rest, midnight overflow, days off, dropped daily items, day invariants.
 */
import { describe, expect, it } from "vitest";
import { MAX_SHIFT_MS, ShiftError, generatePlan, shiftPlan, toIso, type PlanDay, type ShiftInput, type ShiftResult } from "../src/index.ts";
import { TZ, assertDayInvariants, assertSlotOrder, mins, ms, tasksOf } from "./schedule-helpers.ts";
import { standardFiles } from "./schedule-helpers.ts";

const FROM = "2026-09-28";
const files = standardFiles();
const base = (from = FROM, days = 7) => generatePlan({ files, from, days, anchor: FROM, config: { timeZone: TZ } });
const at = (hm: string, date = FROM) => `${date}T${hm}:00+01:00`;
const shift = (plan: PlanDay[], now: string, amount: number, unit: ShiftInput["unit"], extra: Partial<ShiftInput> = {}) =>
  shiftPlan({ plan, now, amount, unit, files, anchor: FROM, config: { timeZone: TZ }, ...extra });
const find = (d: PlanDay, uid: string) => d.items.find((i) => i.taskUid === uid)!;

/** Today may have a stretched rest and a trailing in-progress rest; every other day is strict. */
function assertShifted(r: ShiftResult): void {
  const keys = r.days.flatMap((d) => d.items.map((i) => i.key));
  expect(new Set(keys).size, "keys unique across the plan").toBe(keys.length);
  for (const d of r.days) {
    if (d.date === r.today) assertDayInvariants(d, { strictStart: false, stretchedRests: true, allowTrailingRest: true, allowGaps: true });
    else {
      assertDayInvariants(d);
      assertSlotOrder(d);
    }
  }
}

/** 45 s, an odd fraction of a second, just under a second, 3 ms, and 2 h — all as exact ms. */
const DELTAS = [45_000, 45_317, 999, 3, 2 * 60 * 60_000];

describe("shiftPlan unit: ms - exactness", () => {
  const plan = base();

  for (const d of DELTAS) {
    it(`moves every item starting at or after now by exactly ${d} ms and nothing else`, () => {
      const now = at("10:25"); // bcg/B4 10:00-10:30 is under way
      const r = shift(plan, now, d, "ms");
      const before = plan[0]!.items;
      const after = r.days[0]!.items;

      // Order and identity are untouched: same keys, same order, nothing added or removed.
      expect(after.map((i) => i.key)).toEqual(before.map((i) => i.key));
      expect(r.added).toEqual([]);
      expect(r.removedKeys).toEqual([]);
      expect(r.dropped).toEqual([]);
      expect(r.regeneratedDates).toEqual([]);

      let head = true; // the first item at or after now absorbs the widened gap when it is a rest
      for (const [i, it] of before.entries()) {
        const a = after[i]!;
        if (ms(it.start) < ms(now)) {
          // An item already under way keeps its start. Only a rest may end later, because the gap the
          // pause opened before the next item is rest time (P8 rule 2).
          expect(a.start, `${it.key} start frozen`).toBe(it.start);
          if (a.end !== it.end) expect(a.kind, `${it.key} only a rest stretches`).toBe("rest");
          continue;
        }
        expect(ms(a.end) - ms(it.end), `${it.key} end`).toBe(d);
        if (head && it.kind === "rest") {
          expect(a.start, `${it.key} absorbs the pause instead of moving`).toBe(it.start);
          expect(ms(a.end) - ms(a.start) - (ms(it.end) - ms(it.start)), `${it.key} grew by the pause`).toBe(d);
        } else {
          expect(ms(a.start) - ms(it.start), `${it.key} start`).toBe(d);
          expect(mins(a), `${it.key} duration`).toBe(mins(it));
          expect({ ...a, start: it.start, end: it.end }, `${it.key} only its times changed`).toEqual(it);
        }
        head = false;
      }

      // The timeline has no holes before or after, so every inter-item gap is byte-identical (zero).
      for (const items of [before, after]) for (let k = 1; k < items.length; k++) expect(ms(items[k]!.start), `${items[k]!.key} contiguous`).toBe(ms(items[k - 1]!.end));
      expect(ms(after.at(-1)!.end) - ms(before.at(-1)!.end), "the day ends exactly d later").toBe(d);

      // The item under way is frozen and the rest behind it absorbs the pause.
      expect([find(r.days[0]!, "bcg/B4").start, find(r.days[0]!, "bcg/B4").end]).toEqual([at("10:00"), at("10:30")]);
      const stretched = after[after.findIndex((i) => i.key === find(r.days[0]!, "bcg/B4").key) + 1]!;
      expect(stretched.kind).toBe("rest");
      expect(ms(stretched.end) - ms(stretched.start), "the rest absorbed the pause").toBe(10 * 60_000 + d);

      // Later days are untouched (nothing left today, so nothing is regenerated).
      for (const day of r.days.slice(1)) expect(day.items).toEqual(plan.find((p) => p.date === day.date)!.items);
      assertShifted(r);
    });
  }

  it("never rounds to a minute: a 3 ms and a 999 ms shift both show in the stored ISO", () => {
    const now = at("10:25");
    const small = shift(plan, now, 3, "ms");
    const big = shift(plan, now, 999, "ms");
    const next = (r: ShiftResult) => find(r.days[0]!, "bcg/B5").start;
    expect(next(small)).toBe("2026-09-28T10:40:00.003+01:00");
    expect(next(big)).toBe("2026-09-28T10:40:00.999+01:00");
    expect(find(plan[0]!, "bcg/B5").start).toBe("2026-09-28T10:40:00+01:00");
  });

  it("composes: two exact shifts equal one shift by the sum", () => {
    const now = at("10:25");
    const a = shift(plan, now, 45_317, "ms");
    const b = shift(a.days, now, 1_683, "ms");
    const one = shift(plan, now, 47_000, "ms");
    expect(b.days.flatMap((d) => d.items)).toEqual(one.days.flatMap((d) => d.items));
  });

  it("the cut point and the delta are independent: `now` decides what moves, `amount` how far", () => {
    // What a resume needs: cut at 09:59 (the pause instant) and move by 5 minutes (the elapsed time),
    // so bcg/B4, due at 10:00, runs at 10:05 - it is never treated as already under way.
    const r = shift(plan, at("09:59"), 5 * 60_000, "ms");
    const b4 = find(r.days[0]!, "bcg/B4");
    expect([b4.start, b4.end]).toEqual([at("10:05"), at("10:35")]);
    // bcg/B3 09:20-09:50 had already ended, and the rest running at 09:59 keeps its start.
    expect(find(r.days[0]!, "bcg/B3").start).toBe(at("09:20"));
    const running = r.days[0]!.items.find((i) => ms(i.start) <= ms(at("09:59")) && ms(at("09:59")) < ms(i.end))!;
    expect(running.kind).toBe("rest");
    expect(running.start).toBe(at("09:50"));
    expect(ms(running.end) - ms(running.start), "it absorbed the 5 minutes").toBe(15 * 60_000);
    assertShifted(r);
  });

  it("a whole number of ms equal to a minute is the same plan as the minute shift", () => {
    const now = at("10:25");
    const exact = shift(plan, now, 15 * 60_000, "ms");
    const minutes = shift(plan, now, 15, "minutes");
    expect(exact.days).toEqual(minutes.days);
  });
});

describe("shiftPlan unit: ms - the rest rules still hold", () => {
  const plan = base();

  it("spanning a short rest: the rest stretches, keeps its kind and its 10-minute floor", () => {
    // bcg/B4 10:00-10:30, rest 10:30-10:40, B5 10:40-11:10. Pause inside the rest.
    const now = at("10:33");
    const r = shift(plan, now, 45_000, "ms");
    const day = r.days[0]!;
    const rest = day.items.find((i) => i.key === `${FROM}|rest|4`)!;
    expect(rest.restKind).toBe("short");
    expect(rest.start).toBe(at("10:30"));
    expect(ms(rest.end) - ms(rest.start)).toBe(10 * 60_000 + 45_000);
    expect(find(day, "bcg/B5").start).toBe("2026-09-28T10:40:45+01:00");
    assertShifted(r);
  });

  it("spanning the long rest: it stays long, still sits at exactly 240 task minutes", () => {
    // Long rest 13:10-14:10 after B8 (240 task minutes).
    const now = at("13:30");
    const r = shift(plan, now, 137_000, "ms");
    const day = r.days[0]!;
    const long = day.items.find((i) => i.restKind === "long")!;
    expect(long.start).toBe(at("13:10"));
    expect(ms(long.end) - ms(long.start)).toBe(60 * 60_000 + 137_000);
    let taskMin = 0;
    for (const i of day.items) {
      if (i.kind === "task") taskMin += mins(i);
      else if (i.restKind === "long") expect(taskMin % 240).toBe(0);
    }
    expect(find(day, "bcg/B9").start).toBe("2026-09-28T14:12:17+01:00");
    assertShifted(r);
  });

  it("spanning midnight: what no longer fits leaves today, daily items are dropped, invariants hold", () => {
    const now = at("18:00"); // portfolio/DAILY 17:40-18:40 under way, lessons already done for the day
    const late = base(FROM, 3);
    const r = shift(late, now, 6 * 60 * 60_000 + 321, "ms");
    const day = r.days[0]!;
    const midnight = ms(`2026-09-29T00:00:00+01:00`);
    for (const i of day.items) expect(ms(i.start), `${i.key} stayed before midnight`).toBeLessThan(midnight);
    expect(r.dropped.every((i) => i.taskUid!.endsWith("/DAILY"))).toBe(true);
    assertShifted(r);
  });

  it("on an existing day off: the regeneration starts after it, the day off stays empty", () => {
    // A 16 h pause from 08:00 pushes the whole day past midnight, so the work has to land somewhere:
    // never on the date the owner already pushed past.
    const now = at("08:00");
    const four = base(FROM, 4);
    const off = "2026-09-29";
    const r = shift(four, now, 16 * 60 * 60_000 + 7, "ms", { offUntil: off });
    expect(tasksOf(r.days.find((d) => d.date === off)!), `${off} stays off`).toEqual([]);
    expect(r.regeneratedDates.length).toBeGreaterThan(0);
    for (const d of r.regeneratedDates) expect(d > off, `${d} is after the day off`).toBe(true);
    expect(r.dropped.every((i) => i.taskUid!.endsWith("/DAILY")), "only daily items are dropped").toBe(true);
    assertShifted(r);
  });
});

describe("checkShiftAmount / shiftPlan validation of the exact path", () => {
  const plan = base();
  const bad = (amount: number) => {
    try {
      shift(plan, at("10:25"), amount, "ms");
    } catch (e) {
      expect(e).toBeInstanceOf(ShiftError);
      return e as ShiftError;
    }
    throw new Error(`expected ${amount} ms to be rejected`);
  };

  it("rejects a non-positive, non-finite or fractional amount", () => {
    for (const a of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(bad(a).code).toBe("INVALID_AMOUNT");
    expect(bad(1.5).message).toMatch(/whole number of milliseconds/);
  });

  it(`caps the exact shift at 24 h (${MAX_SHIFT_MS} ms)`, () => {
    expect(MAX_SHIFT_MS).toBe(86_400_000);
    const e = bad(MAX_SHIFT_MS + 1);
    expect(e.code).toBe("INVALID_AMOUNT");
    expect(e.hint).toMatch(/whole days/);
    // Exactly 24 h is still allowed.
    expect(() => shift(plan, at("10:25"), MAX_SHIFT_MS, "ms")).not.toThrow();
  });

  it("keeps rejecting an unknown unit", () => {
    expect(() => shift(plan, at("10:25"), 5, "seconds" as never)).toThrow(ShiftError);
  });
});

describe("toIso keeps milliseconds", () => {
  it("prints a fractional second only when there is one", () => {
    const t = ms("2026-09-28T08:00:00+01:00");
    expect(toIso(t, TZ)).toBe("2026-09-28T08:00:00+01:00");
    expect(toIso(t + 3, TZ)).toBe("2026-09-28T08:00:00.003+01:00");
    expect(toIso(t + 999, TZ)).toBe("2026-09-28T08:00:00.999+01:00");
    expect(toIso(t + 1000, TZ)).toBe("2026-09-28T08:00:01+01:00");
    expect(toIso(t + 45_317, TZ)).toBe("2026-09-28T08:00:45.317+01:00");
    for (const d of [3, 999, 45_317]) expect(ms(toIso(t + d, TZ))).toBe(t + d);
  });
});
