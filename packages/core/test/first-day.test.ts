/** GenerateInput.firstDay (additive): lay out only the rest of the first day. */
import { describe, expect, it } from "vitest";
import { generatePlan, type GenerateInput } from "../src/index.ts";
import { MIN_PART, TZ, assertDayInvariants, assertSlotOrder, hhmm, mins, ms, standardFiles, tasksOf } from "./schedule-helpers.ts";

const base: GenerateInput = { files: standardFiles(), from: "2026-09-28", days: 3, config: { timeZone: TZ } };

describe("firstDay", () => {
  it("defaults are unchanged: omitting firstDay equals the plain plan", () => {
    expect(generatePlan({ ...base, firstDay: undefined })).toEqual(generatePlan(base));
  });

  it("starts at startAt, counts spent task minutes toward the 240 mark and the 480 day", () => {
    const [d0, d1] = generatePlan({ ...base, firstDay: { startAt: "2026-09-28T11:00:00+01:00", taskMinSpent: 150 } });
    expect(d0!.items[0]!.start).toBe("2026-09-28T11:00:00+01:00");
    assertDayInvariants(d0!, { strictStart: false, taskMinBefore: 150 });
    assertSlotOrder(d0!);
    const taskMin = tasksOf(d0!).reduce((n, i) => n + mins(i), 0);
    expect(taskMin).toBeLessThanOrEqual(480 - 150);
    // The first long rest comes after exactly 240 - 150 = 90 new task minutes, never earlier.
    let acc = 150;
    for (const it of d0!.items) {
      if (it.kind === "task") acc += mins(it);
      else if (it.restKind === "long") expect(acc).toBe(240);
    }
    for (const t of tasksOf(d0!)) expect(mins(t)).toBeGreaterThanOrEqual(MIN_PART);
    assertDayInvariants(d1!); // later days unchanged in shape
    expect(hhmm(d1!.items[0]!.start)).toBe("08:00");
  });

  it("fixed slots still fit after a busy morning; prep shrinks first", () => {
    const [d0] = generatePlan({ ...base, days: 1, firstDay: { startAt: "2026-09-28T14:00:00+01:00", taskMinSpent: 300 } });
    const uids = tasksOf(d0!).map((t) => t.taskUid);
    expect(uids).toContain("lessons/DAILY");
    expect(uids).toContain("portfolio/DAILY");
    expect(tasksOf(d0!).reduce((n, i) => n + mins(i), 0)).toBeLessThanOrEqual(180);
    assertDayInvariants(d0!, { strictStart: false, taskMinBefore: 300 });
  });

  it("maxTaskMin caps the new work (e.g. to end before midnight); the rest continues the next day", () => {
    const capped = generatePlan({ ...base, days: 2, firstDay: { startAt: "2026-09-28T20:00:00+01:00", taskMinSpent: 0, maxTaskMin: 180 } });
    expect(tasksOf(capped[0]!).reduce((n, i) => n + mins(i), 0)).toBeLessThanOrEqual(180);
    expect(ms(capped[0]!.items.at(-1)!.end)).toBeLessThanOrEqual(ms("2026-09-29T00:00:00+01:00"));
    assertDayInvariants(capped[1]!);
  });

  it("is deterministic", () => {
    const input: GenerateInput = { ...base, firstDay: { startAt: "2026-09-28T10:10:00+01:00", taskMinSpent: 100 } };
    expect(generatePlan(input)).toEqual(generatePlan(input));
  });
});
