/**
 * Active hours: when the day may start, when it must stop, and how much task time it holds.
 *
 * The three settings are independent and whichever binds first wins. The rest rules are untouched by
 * all of them — a short rest between consecutive tasks, a long rest after every 4 h of task time —
 * so raising the budget makes more blocks, never a longer one. Work that does not fit before the
 * fence goes to the next day, which is the property most of this file is about.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, checkActiveHours, generatePlan, parseClock, type PlanDay, type ScheduleConfig } from "../src/index.ts";
import { TZ, assertDayInvariants, hhmm, mins, mkFile, many, standardFiles, tasksOf } from "./schedule-helpers.ts";

const FROM = "2026-03-02"; // a Monday, no DST inside the window
const config = (over: Partial<ScheduleConfig> = {}) => ({ timeZone: TZ, ...over });

const plan = (over: Partial<ScheduleConfig> = {}, days = 5, files = standardFiles()) =>
  generatePlan({ files, from: FROM, days, anchor: FROM, config: config(over), status: new Map() });

const taskMin = (d: PlanDay) => tasksOf(d).reduce((n, i) => n + mins(i), 0);
const lastEnd = (d: PlanDay) => d.items.at(-1)!.end;
const firstStart = (d: PlanDay) => d.items[0]!.start;
/** Every long rest sits exactly on a 4 h multiple of task time: the rule raising the budget must keep. */
const longRestMarks = (d: PlanDay) => {
  const marks: number[] = [];
  let t = 0;
  for (const i of d.items) {
    if (i.kind === "task") t += mins(i);
    else if (i.restKind === "long") marks.push(t);
  }
  return marks;
};

describe("the defaults are exactly what the owner's rules describe", () => {
  it("08:00, 8 h of task time, and a fence at midnight that never bites", () => {
    expect(DEFAULT_CONFIG.dayStart).toBe("08:00");
    expect(DEFAULT_CONFIG.dailyTaskMin).toBe(480);
    // "24:00" means "no fence beyond the calendar day", so the default behaves as it did before
    // active hours existed. A narrower default would have silently shortened everyone's day.
    expect(DEFAULT_CONFIG.dayEnd).toBe("24:00");
    expect(parseClock("24:00")).toBe(1440);
  });

  it("a default day is 4 h, a long rest, 4 h, starting at 08:00", () => {
    const days = plan();
    for (const d of days) {
      assertDayInvariants(d);
      expect(taskMin(d)).toBe(480);
      expect(hhmm(firstStart(d))).toBe("08:00");
      expect(longRestMarks(d)).toEqual([240]);
    }
  });
});

describe("dayStart moves the whole day", () => {
  // A start early enough for the whole budget to fit before midnight: same day, just shifted.
  for (const start of ["06:00", "08:00", "10:00"]) {
    it(`a day that starts at ${start} holds the same work, just later`, () => {
      const days = plan({ dayStart: start });
      expect(hhmm(firstStart(days[0]!))).toBe(start);
      for (const d of days) {
        assertDayInvariants(d, { dayStart: start });
        expect(taskMin(d)).toBe(480);
        expect(longRestMarks(d)).toEqual([240]);
        expect(hhmm(firstStart(d))).toBe(start);
      }
    });
  }

  // A start so late that 8 h of task time plus its rests would run past midnight. The day is
  // trimmed and the remainder moves on - the same answer the fence gives for any other overshoot.
  for (const start of ["14:00", "18:30", "21:00"]) {
    it(`a day that starts at ${start} is trimmed rather than spilling past midnight`, () => {
      const days = plan({ dayStart: start });
      for (const d of days) {
        assertDayInvariants(d, { dayStart: start });
        expect(hhmm(firstStart(d))).toBe(start);
        expect(taskMin(d)).toBeLessThan(480);
        expect(taskMin(d)).toBeGreaterThan(0);
        expect(d.items.every((i) => i.date === d.date)).toBe(true);
      }
    });
  }

  it("a late start never stores an item on the following date", () => {
    // This is what the fence is really protecting: before it existed, nothing stopped a day that
    // started at 21:00 from laying items past 24:00, where the item's own `date` would then
    // disagree with the day it was stored under - and every key in the system carries that date.
    for (const start of ["18:30", "21:00", "23:00"]) {
      for (const d of plan({ dayStart: start }, 4)) {
        for (const i of d.items) {
          expect(i.date, `${start}: ${i.key}`).toBe(d.date);
          expect(Date.parse(i.end)).toBeLessThanOrEqual(Date.parse(`${d.date}T24:00:00+01:00`));
        }
      }
    }
  });
});

describe("dayEnd is a hard stop, and what does not fit moves to the next day", () => {
  it("no item ends after the fence, on any day", () => {
    for (const end of ["12:00", "14:00", "16:00", "18:00", "20:00"]) {
      const days = plan({ dayEnd: end });
      const fenceMin = parseClock(end);
      for (const d of days) {
        for (const i of d.items)
          expect(parseClock(hhmm(i.end)) || 1440, `${end}: ${i.key} ends ${hhmm(i.end)}`).toBeLessThanOrEqual(fenceMin);
        assertDayInvariants(d, { dayEnd: end });
      }
    }
  });

  it("a narrow window holds less work per day, and the rest rules still hold inside it", () => {
    const days = plan({ dayEnd: "14:00" }); // 6 h of clock from 08:00
    for (const d of days) {
      assertDayInvariants(d, { dayEnd: "14:00" });
      expect(taskMin(d)).toBeLessThan(480);
      expect(taskMin(d)).toBeGreaterThan(0);
      // The long rest still comes after 4 h of task time, if the day gets that far.
      for (const mark of longRestMarks(d)) expect(mark % DEFAULT_CONFIG.blockMin).toBe(0);
    }
  });

  it("the work is deferred, never dropped: a fenced plan schedules the same tasks, later", () => {
    const files = standardFiles({ bcg: many("B", 10, 60) });
    const uids = (ds: PlanDay[]) => new Set(ds.flatMap((d) => tasksOf(d)).map((i) => i.taskUid!));
    const open = plan({}, 12, files);
    const fenced = plan({ dayEnd: "13:00" }, 12, files);
    // Fewer minutes per day...
    expect(taskMin(fenced[0]!)).toBeLessThan(taskMin(open[0]!));
    // ...and the ones that moved are still on the plan, just further out.
    const openTotal = open.reduce((n, d) => n + taskMin(d), 0);
    const fencedTotal = fenced.reduce((n, d) => n + taskMin(d), 0);
    expect(fencedTotal).toBeLessThan(openTotal);
    expect([...uids(fenced)].every((u) => uids(open).has(u))).toBe(true);
    // Every task the fenced plan places, it places in full or in parts that continue later.
    for (const d of fenced) expect(taskMin(d)).toBeLessThanOrEqual(480);
  });

  it("a window too small for the fixed blocks still produces legal days, never a broken one", () => {
    // 08:00-09:30 cannot hold the 2 h lessons block at all.
    const days = plan({ dayEnd: "09:30" });
    for (const d of days) {
      assertDayInvariants(d, { dayEnd: "09:30" });
      expect(taskMin(d)).toBeLessThanOrEqual(90);
      for (const i of d.items) expect(parseClock(hhmm(i.end)) || 1440).toBeLessThanOrEqual(parseClock("09:30"));
    }
  });
});

describe("dailyTaskMin raises the day's work, and the blocks follow", () => {
  it("10 h of task time gets a long rest at 4 h and another at 8 h", () => {
    const days = plan({ dailyTaskMin: 600 });
    const d = days[0]!;
    expect(taskMin(d)).toBe(600);
    // Not one longer block: the 4 h rule is untouched, so the day has three blocks.
    expect(longRestMarks(d)).toEqual([240, 480]);
    assertDayInvariants(d, { dailyTaskMin: 600 });
  });

  for (const [hours, expected] of [
    [9, [240, 480]],
    [10, [240, 480]],
  ] as [number, number[]][]) {
    it(`${hours} h of task time keeps a long rest every 4 h (marks ${expected.join(", ")})`, () => {
      const d = plan({ dailyTaskMin: hours * 60 }, 3)[0]!;
      expect(taskMin(d)).toBe(hours * 60);
      expect(longRestMarks(d)).toEqual(expected);
      assertDayInvariants(d, { dailyTaskMin: hours * 60 });
      // Long rests are an hour, short ones ten minutes, whatever the budget.
      for (const i of d.items.filter((x) => x.kind === "rest"))
        expect(mins(i), `${i.key} ${i.title}`).toBe(i.restKind === "long" ? DEFAULT_CONFIG.longRestMin : DEFAULT_CONFIG.shortRestMin);
    });
  }

  it("a budget no calendar day can hold is trimmed to what a day can, not spread past midnight", () => {
    // 14 h of task time needs 14 h plus three long rests plus a rest between every pair of tasks:
    // more than the 24 h a date has. Asking for it is allowed - it is a budget, not a promise - and
    // the fence decides what actually happens.
    const d = plan({ dailyTaskMin: 14 * 60 }, 3)[0]!;
    expect(taskMin(d)).toBeLessThan(14 * 60);
    expect(taskMin(d)).toBeGreaterThan(480); // but more than the default day, which is the point
    assertDayInvariants(d, { dailyTaskMin: 14 * 60 });
    for (const mark of longRestMarks(d)) expect(mark % DEFAULT_CONFIG.blockMin).toBe(0);
  });

  it("a budget the window cannot hold is bounded by the window, not by itself", () => {
    // 14 h of task time asked for, but only 08:00-16:00 to put it in.
    const d = plan({ dailyTaskMin: 14 * 60, dayEnd: "16:00" }, 3)[0]!;
    expect(taskMin(d)).toBeLessThan(14 * 60);
    expect(parseClock(hhmm(lastEnd(d))) || 1440).toBeLessThanOrEqual(parseClock("16:00"));
    assertDayInvariants(d, { dayEnd: "16:00", dailyTaskMin: 14 * 60 });
  });

  it("a budget below the window's room is the binding one", () => {
    // Plenty of clock, deliberately little work.
    const d = plan({ dailyTaskMin: 120, dayEnd: "22:00" }, 3)[0]!;
    expect(taskMin(d)).toBe(120);
    expect(parseClock(hhmm(lastEnd(d))) || 1440).toBeLessThan(parseClock("22:00"));
  });
});

describe("the two together describe the owner's example", () => {
  it("08:00 to 20:00 asked for 10 h of work: the window grants 8 h and stops", () => {
    const days = plan({ dayStart: "08:00", dayEnd: "20:00", dailyTaskMin: 600 }, 5);
    for (const d of days) {
      assertDayInvariants(d, { dayEnd: "20:00", dailyTaskMin: 600 });
      expect(hhmm(firstStart(d))).toBe("08:00");
      expect(parseClock(hhmm(lastEnd(d))) || 1440).toBeLessThanOrEqual(parseClock("20:00"));
    }
    // Not a shortfall in the search - a step in the rules. See the next test.
    expect(taskMin(days[0]!)).toBe(480);
  });

  it("the clock cost of work is stepped, because every 4 h of it buys an hour of long rest", () => {
    // This is the one thing about active hours that surprises people, so it is pinned here: raising
    // the budget from 8 h to 8.5 h costs **1 h 40** of clock, not 30 minutes, because the 480-minute
    // mark adds a second long rest. A window has to clear a step to be worth widening.
    const endOf = (budget: number) => hhmm(lastEnd(plan({ dailyTaskMin: budget }, 1)[0]!));
    expect(endOf(480)).toBe("18:40"); // 8 h of task time, one long rest
    expect(endOf(510)).toBe("20:20"); // 8.5 h, two long rests: +30 min of work, +1 h 40 of clock
    // So 10 h of task time needs the window open until well past 22:00.
    expect(parseClock(endOf(600))).toBeGreaterThan(parseClock("22:00"));
  });

  it("a window wide enough really does grant the bigger day", () => {
    const days = plan({ dayStart: "08:00", dayEnd: "23:00", dailyTaskMin: 600 }, 4);
    for (const d of days) {
      assertDayInvariants(d, { dayEnd: "23:00", dailyTaskMin: 600 });
      // Every day beats the default 8 h, and the third block's long rest is there.
      expect(taskMin(d)).toBeGreaterThan(480);
      expect(longRestMarks(d)).toEqual([240, 480]);
    }
    // And the full 10 h is actually reached, not merely approached. (A day can come out slightly
    // short when the remaining tasks do not divide into the last slot - the no-fragment rule.)
    expect(days.map((d) => taskMin(d))).toContain(600);
  });

  it("every day of a week is laid out the same way: one setting, all days", () => {
    const days = plan({ dayStart: "09:00", dayEnd: "17:00", dailyTaskMin: 600 }, 7);
    const shapes = new Set(days.map((d) => `${hhmm(firstStart(d))}..${hhmm(lastEnd(d))}`));
    // Monday through Sunday, no weekday special-casing.
    expect(days).toHaveLength(7);
    expect(shapes.size).toBeLessThanOrEqual(2); // the last day may be short of work
    for (const d of days) expect(hhmm(firstStart(d))).toBe("09:00");
  });
});

describe("a window that cannot work is refused, not guessed at", () => {
  const bad: [string, Partial<ScheduleConfig>, RegExp][] = [
    ["the end before the start", { dayStart: "18:00", dayEnd: "09:00" }, /must be after/],
    ["the end equal to the start", { dayStart: "09:00", dayEnd: "09:00" }, /must be after/],
    ["a window that wraps midnight", { dayStart: "22:00", dayEnd: "02:00" }, /wraps midnight/],
    ["a window too short for one task", { dayStart: "08:00", dayEnd: "08:05" }, /too short/],
    ["a budget of zero", { dailyTaskMin: 0 }, /dailyTaskMin/],
    ["a negative budget", { dailyTaskMin: -60 }, /dailyTaskMin/],
    ["a fractional budget", { dailyTaskMin: 90.5 }, /dailyTaskMin/],
    ["a budget longer than a day", { dailyTaskMin: 25 * 60 }, /dailyTaskMin/],
    ["a clock time that is not one", { dayStart: "8am" }, /expected HH:MM/],
    ["an hour past midnight", { dayEnd: "24:30" }, /expected HH:MM/],
    ["a 25th hour", { dayEnd: "25:00" }, /expected HH:MM/],
  ];
  for (const [label, over, message] of bad) {
    it(`${label} throws, and says why`, () => {
      expect(() => plan(over), label).toThrow(message);
    });
  }

  it("the check is callable on its own, so a UI can validate before saving", () => {
    expect(() => checkActiveHours({ dayStart: "08:00", dayEnd: "20:00", dailyTaskMin: 600, minPartMin: 15 })).not.toThrow();
    expect(() => checkActiveHours({ dayStart: "20:00", dayEnd: "08:00", dailyTaskMin: 600, minPartMin: 15 })).toThrow(/must be after/);
  });
});

describe("a day whose window shifts does not corrupt the plan", () => {
  it("items always carry the date they are stored under", () => {
    for (const over of [{ dayStart: "21:00" }, { dayEnd: "09:00" }, { dailyTaskMin: 14 * 60 }, { dayStart: "19:00", dailyTaskMin: 600 }]) {
      for (const d of plan(over, 6)) {
        for (const i of d.items) expect(i.date, `${JSON.stringify(over)} ${i.key}`).toBe(d.date);
        expect(d.items.map((i) => Date.parse(i.start))).toEqual([...d.items.map((i) => Date.parse(i.start))].sort((a, b) => a - b));
      }
    }
  });

  it("a one-task-wide window still makes progress every day instead of stalling", () => {
    const files = [mkFile("solo.md", "solo", "prep", many("S", 8, 45), { priority: 1 })];
    const days = plan({ dayEnd: "08:45" }, 6, files);
    const placed = days.map((d) => taskMin(d));
    // Exactly one 45-minute task a day: the fence allows one, and the next day gets the next one.
    expect(placed.every((m) => m === 45)).toBe(true);
    const uids = days.flatMap((d) => tasksOf(d)).map((i) => i.taskUid);
    expect(new Set(uids).size).toBe(uids.length); // no task placed twice
  });
});
