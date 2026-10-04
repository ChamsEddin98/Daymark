import { describe, expect, it } from "vitest";
import { remindersFor, toEvent, type PlanItem } from "../src/index.ts";

const base: PlanItem = {
  key: "2026-09-28|bcg-a1|2",
  date: "2026-09-28",
  kind: "task",
  start: "2026-09-28T12:10:00+01:00",
  end: "2026-09-28T13:00:00+01:00",
  taskUid: "bcg-a1",
  track: "bcg",
  title: "A1 · Case interview basics — structuring (part 2/3)",
  part: { index: 2, total: 3 },
  links: [
    { label: "BCG Virtual Experience", url: "https://www.theforage.com/bcg" },
    { label: "Casebook", url: "https://example.com/casebook.pdf" },
  ],
  type: "course",
  status: "pending",
};

describe("toEvent", () => {
  it("uses the title verbatim, including the part suffix", () => {
    const e = toEvent(base, "Africa/Tunis");
    expect(e.summary).toBe("A1 · Case interview basics — structuring (part 2/3)");
  });

  it("floors both times to whole seconds, hash included, because Google stores no finer", () => {
    // What a resume leaves behind (docs/PLAN.md, P8): an exact, fractional-second start.
    const resumed = toEvent({ ...base, start: "2026-09-28T12:10:01.317+01:00", end: "2026-09-28T13:00:00.999+01:00" }, "Africa/Tunis");
    expect(resumed.start.dateTime).toBe("2026-09-28T12:10:01+01:00");
    expect(resumed.end.dateTime).toBe("2026-09-28T13:00:00+01:00");
    // The hash must be computed from the floored times, so it describes the event the server holds.
    const floored = toEvent({ ...base, start: "2026-09-28T12:10:01+01:00", end: "2026-09-28T13:00:00+01:00" }, "Africa/Tunis");
    expect(resumed.extendedProperties.private.plannerHash).toBe(floored.extendedProperties.private.plannerHash);
    // Two resumes inside the same second are therefore indistinguishable to the calendar.
    const later = toEvent({ ...base, start: "2026-09-28T12:10:01.842+01:00", end: "2026-09-28T13:00:00.001+01:00" }, "Africa/Tunis");
    expect(later.extendedProperties.private.plannerHash).toBe(resumed.extendedProperties.private.plannerHash);
    // A whole minute is untouched.
    expect(toEvent(base, "Africa/Tunis").start.dateTime).toBe("2026-09-28T12:10:00+01:00");
  });

  it("puts the primary link in source and on the first description line", () => {
    const e = toEvent(base, "Africa/Tunis");
    expect(e.source).toEqual({ title: "BCG Virtual Experience", url: "https://www.theforage.com/bcg" });
    expect(e.description!.split("\n")).toEqual([
      "https://www.theforage.com/bcg",
      "Casebook — https://example.com/casebook.pdf",
      "Track: bcg · Type: course",
    ]);
  });

  it("maps times, zone, reminders, transparency and private properties", () => {
    const e = toEvent(base, "Africa/Tunis");
    expect(e.start).toEqual({ dateTime: "2026-09-28T12:10:00+01:00", timeZone: "Africa/Tunis" });
    expect(e.end).toEqual({ dateTime: "2026-09-28T13:00:00+01:00", timeZone: "Africa/Tunis" });
    expect(e.reminders).toEqual({ useDefault: false, overrides: [] });
    expect(e.transparency).toBe("opaque");
    expect(e.extendedProperties.private.plannerKey).toBe(base.key);
    expect(e.extendedProperties.private.plannerHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("omits source and link lines when there are no links", () => {
    const e = toEvent({ ...base, links: [] }, "UTC");
    expect(e.source).toBeUndefined();
    expect(e.description).toBe("Track: bcg · Type: course");
  });

  it("hash is deterministic and changes with content", () => {
    const h = (i: PlanItem) => toEvent(i, "Africa/Tunis").extendedProperties.private.plannerHash;
    expect(h(base)).toBe(h({ ...base }));
    expect(h({ ...base, start: "2026-09-28T13:10:00+01:00" })).not.toBe(h(base));
    expect(h({ ...base, title: "Other" })).not.toBe(h(base));
    expect(h({ ...base, links: base.links!.slice(1) })).not.toBe(h(base));
    expect(h({ ...base, status: "done" })).toBe(h(base)); // status is not event content
  });

  it("refuses rest items", () => {
    expect(() => toEvent({ ...base, kind: "rest", title: "Rest" }, "UTC")).toThrow(/only task items/);
  });
});

/**
 * Reminders are what makes the plan announce itself on a phone. The default stays `off` because the
 * daemon already fires native toasts on the machine running the planner; a Google reminder on top
 * would double every one of them.
 */
describe("remindersFor", () => {
  it("off means Google stays silent", () => {
    expect(remindersFor("off")).toEqual({ useDefault: false, overrides: [] });
  });

  it("inherit hands the decision to the calendar's own notification settings", () => {
    expect(remindersFor("inherit")).toEqual({ useDefault: true, overrides: [] });
  });

  it("a number is a popup that many minutes before the start", () => {
    expect(remindersFor(10)).toEqual({ useDefault: false, overrides: [{ method: "popup", minutes: 10 }] });
    // 0 is "at the start", not "unset", so it has to survive the falsy check.
    expect(remindersFor(0)).toEqual({ useDefault: false, overrides: [{ method: "popup", minutes: 0 }] });
    expect(remindersFor(40_320)).toEqual({ useDefault: false, overrides: [{ method: "popup", minutes: 40_320 }] });
  });

  it("falls back to off rather than throwing, because a bad setting must not stop a sync", () => {
    const off = { useDefault: false, overrides: [] };
    for (const bad of [-1, 40_321, 10.5, Number.NaN, "10", null, undefined, {}] as never[]) {
      expect(remindersFor(bad)).toEqual(off);
    }
  });
});

describe("toEvent reminders", () => {
  it("defaults to off when no policy is passed, which is what the planner always wrote", () => {
    expect(toEvent(base, "Africa/Tunis").reminders).toEqual({ useDefault: false, overrides: [] });
  });

  it("carries the policy it is given", () => {
    expect(toEvent(base, "Africa/Tunis", 15).reminders).toEqual({ useDefault: false, overrides: [{ method: "popup", minutes: 15 }] });
    expect(toEvent(base, "Africa/Tunis", "inherit").reminders).toEqual({ useDefault: true, overrides: [] });
  });

  /**
   * The hash has to move with the policy. It is the only thing `needsPatch` compares, so if the
   * hash ignored reminders, turning them on would never reach the events that already exist.
   */
  it("changes the hash, so existing events get patched", () => {
    const h = (r?: Parameters<typeof toEvent>[2]) => toEvent(base, "Africa/Tunis", r).extendedProperties.private.plannerHash;
    expect(h("off")).toBe(h());
    expect(h(10)).not.toBe(h("off"));
    expect(h("inherit")).not.toBe(h("off"));
    expect(h(10)).not.toBe(h(15));
    expect(h(10)).toBe(h(10));
  });
});
