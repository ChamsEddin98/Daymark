import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { addDays, daysBetween, generatePlan, loadTaskFiles, localMinute, type GenerateInput, type PlanDay } from "../src/index.ts";
import {
  MIN_PART,
  TZ,
  assertDayInvariants,
  assertSlotOrder,
  hhmm,
  many,
  mins,
  mkFile,
  ms,
  partsByTask,
  standardFiles,
  tasksOf,
} from "./schedule-helpers.ts";

const FROM = "2026-09-28";
const gen = (over: Partial<GenerateInput> = {}) =>
  generatePlan({ files: standardFiles(), from: FROM, days: 7, config: { timeZone: TZ }, ...over });
const taskMin = (d: PlanDay) => tasksOf(d).reduce((s, t) => s + mins(t), 0);
const prepMin = (d: PlanDay) => tasksOf(d).filter((t) => ["bcg", "salesforce", "anthropic"].includes(t.track!)).reduce((s, t) => s + mins(t), 0);
const tracks = (d: PlanDay) => tasksOf(d).map((t) => t.track);
const has = (d: PlanDay, track: string) => tasksOf(d).some((t) => t.track === track);
const prepTracks = (d: PlanDay) => tracks(d).filter((t) => ["bcg", "salesforce", "anthropic"].includes(t!));

// Fixture (schedule-helpers): BCG 16 x 30 min, Salesforce 20 x 45, Anthropic 200 x 45,
// lessons 2 h x 28 days, portfolio 1 h, apply 30 min after BCG. Prep budget 300, or 270 with apply.
describe("generatePlan: day shape", () => {
  const plan = gen({ days: 14 });

  it("covers every date in the horizon, chronological", () => {
    expect(plan.map((d) => d.date)).toEqual(Array.from({ length: 14 }, (_, i) => addDays(FROM, i)));
    for (const d of plan) {
      const starts = d.items.map((i) => ms(i.start));
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
    }
  });

  it("every day passes the rest-rule invariants and starts at 08:00", () => {
    for (const d of plan) {
      assertDayInvariants(d);
      expect(d.items[0]!.start).toBe(`${d.date}T08:00:00+01:00`);
    }
  });

  it("gaps between consecutive tasks inside a block are exactly one 10-minute short rest", () => {
    for (const d of plan) {
      const it = d.items;
      for (let i = 1; i < it.length - 1; i++) {
        if (it[i]!.kind !== "rest" || it[i]!.restKind !== "short") continue;
        expect(ms(it[i + 1]!.start) - ms(it[i - 1]!.end)).toBe(10 * 60_000);
        expect(it[i - 1]!.kind).toBe("task");
        expect(it[i + 1]!.kind).toBe("task");
      }
    }
  });

  it("long rest is exactly 60 min, comes after exactly 240 task minutes, once per day", () => {
    for (const d of plan) {
      const longs = d.items.filter((i) => i.restKind === "long");
      expect(longs).toHaveLength(1);
      const idx = d.items.indexOf(longs[0]!);
      expect(mins(longs[0]!)).toBe(60);
      expect(d.items.slice(0, idx).filter((i) => i.kind === "task").reduce((s, t) => s + mins(t), 0)).toBe(240);
      expect(ms(longs[0]!.start)).toBe(ms(d.items[idx - 1]!.end));
      expect(ms(longs[0]!.end)).toBe(ms(d.items[idx + 1]!.start));
    }
  });

  it("holds 480 task minutes a day when the tasks tile the budget, never more", () => {
    for (const d of plan) expect(taskMin(d)).toBe(480);
    const lastDay = gen({ files: standardFiles({ bcg: many("B", 2, 60), salesforce: [], anthropic: [] }), days: 1 })[0]!;
    expect(taskMin(lastDay)).toBe(120 + 120 + 60 + 30);
    assertDayInvariants(lastDay);
  });

  it("day order is prep, lessons, portfolio, recurring", () => {
    for (const d of gen({ days: 28 })) assertSlotOrder(d);
    expect(tracks(plan[0]!).slice(-2)).toEqual(["lessons", "portfolio"]);
    expect(tracks(plan[2]!).slice(-3)).toEqual(["lessons", "portfolio", "apply"]);
  });

  it("items carry title, track, links, type and stable keys", () => {
    const first = plan[0]!.items[0]!;
    expect(first).toMatchObject({ key: `${FROM}|bcg/B1|1`, kind: "task", taskUid: "bcg/B1", track: "bcg", title: "bcg B1", type: "coding", status: "pending" });
    expect(first.links?.[0]?.url).toBe("https://example.com/bcg/B1");
    const rests = plan[0]!.items.filter((i) => i.kind === "rest");
    expect(rests.map((r) => r.key)).toEqual(rests.map((_, i) => `${FROM}|rest|${i + 1}`));
  });
});

describe("generatePlan: splitting and fragments", () => {
  const one = (bcg: { id: string; min: number }[], days = 1) => generatePlan({ files: standardFiles({ bcg }), from: FROM, days, config: { timeZone: TZ } });

  it("splits a task at the 4 h mark: part 1 ends at 240 min, long rest, part 2", () => {
    const d = one([{ id: "X", min: 100 }, { id: "Y", min: 95 }, { id: "Z", min: 100 }])[0]!;
    assertDayInvariants(d);
    const z = d.items.filter((i) => i.taskUid === "bcg/Z");
    expect(z.map((i) => i.title)).toEqual(["bcg Z (part 1/2)", "bcg Z (part 2/2)"]);
    expect(z.map(mins)).toEqual([45, 55]);
    expect(z.map((i) => i.part)).toEqual([{ index: 1, total: 2 }, { index: 2, total: 2 }]);
    expect(z.map((i) => i.key)).toEqual([`${FROM}|bcg/Z|1`, `${FROM}|bcg/Z|2`]);
    expect(hhmm(z[0]!.end)).toBe("12:20"); // 08:00 + 240 task + 2 x 10 rest
    expect(d.items[d.items.indexOf(z[0]!) + 1]).toMatchObject({ kind: "rest", restKind: "long", title: "Long rest" });
    expect(hhmm(z[1]!.start)).toBe("13:20");
  });

  it("a task of >= 90 min is only split at the 4 h mark with both parts >= 45 min", () => {
    // In file order Z would split 40/60 at the mark, which is not allowed for a 100-min task.
    const d = one([{ id: "X", min: 100 }, { id: "Y", min: 100 }, { id: "Z", min: 100 }, { id: "W", min: 40 }])[0]!;
    assertDayInvariants(d);
    for (const t of tasksOf(d)) if (t.part && t.part.total > 1 && t.track === "bcg") expect(mins(t)).toBeGreaterThanOrEqual(45);
  });

  it("a task that fills a block exactly is not split; the long rest follows it", () => {
    const d = one([{ id: "X", min: 240 }, { id: "Y", min: 60 }])[0]!;
    assertDayInvariants(d);
    expect(d.items[0]!.title).toBe("bcg X");
    expect(d.items[0]!.part).toBeUndefined();
    expect(d.items[1]).toMatchObject({ restKind: "long" });
  });

  it("never leaves a part under the minimum at the 4 h mark: look-ahead reorders within the track", () => {
    // File order puts the mark 10 min into D (30+100+100 = 230). E (10) is pulled ahead to end exactly at 240.
    const d = one([{ id: "A", min: 30 }, { id: "B", min: 100 }, { id: "C", min: 100 }, { id: "D", min: 50 }, { id: "E", min: 10 }])[0]!;
    assertDayInvariants(d);
    expect(tasksOf(d).map((t) => t.taskUid)).toEqual(["bcg/A", "bcg/B", "bcg/C", "bcg/E", "bcg/D", "lessons/DAILY", "portfolio/DAILY"]);
    expect(tasksOf(d).find((t) => t.taskUid === "bcg/E")!.end).toBe(d.items.find((i) => i.restKind === "long")!.start);
    expect(tasksOf(d).every((t) => !t.part)).toBe(true);
  });

  it("sections are ordering barriers: a first-section task is never displaced behind a later-section task", () => {
    // Without the barrier, S (30) would move behind six 40s to land on the mark (see next test).
    const bcg = [{ id: "S", min: 30, section: "Skip test" }, ...many("B", 8, 40).map((t) => ({ ...t, section: "Techniques" }))];
    const d = one(bcg)[0]!;
    assertDayInvariants(d);
    expect(tasksOf(d)[0]!.taskUid).toBe("bcg/S");
    // Within one section the look-ahead still reorders.
    const inSection = [{ id: "A", min: 30, section: "X" }, { id: "B", min: 100, section: "X" }, { id: "C", min: 100, section: "X" }, { id: "D", min: 50, section: "Y" }, { id: "E", min: 10, section: "Y" }];
    const d2 = one(inSection)[0]!;
    assertDayInvariants(d2);
    const order = tasksOf(d2).map((t) => t.taskUid).filter((u) => u!.startsWith("bcg/"));
    for (const [i, u] of order.entries()) {
      const sec = (x: string) => inSection.find((t) => `bcg/${t.id}` === x)!.section;
      for (const later of order.slice(i + 1)) expect(sec(later!) >= sec(u!), `${later} placed after ${u}`).toBe(true);
    }
  });

  it("uses a look-ahead task to hit the mark exactly instead of fragmenting", () => {
    // 30 + 40*5 = 230: a 40-min task would leave 10 min before the mark. Six 40s give exactly 240.
    const d = one([{ id: "S", min: 30 }, ...many("B", 8, 40)])[0]!;
    assertDayInvariants(d);
    expect(tasksOf(d).every((t) => !t.part)).toBe(true);
    expect(prepMin(d)).toBeGreaterThanOrEqual(270);
  });

  it("a task under 90 min is never split across days; leftover prep time stays unused", () => {
    // Best whole fill is 60+60+80+80 = 280; the 20 min left stay unused rather than split a task.
    const days = one([...many("A", 4, 60), { id: "C", min: 80 }, { id: "D", min: 80 }], 2);
    days.forEach((d) => assertDayInvariants(d));
    expect(prepMin(days[0]!)).toBe(280);
    for (const [, p] of partsByTask(days)) expect(new Set(p.map((x) => x.date)).size).toBe(1);
  });

  it("a task of >= 90 min is split across days (pieces >= 45) when nothing fits whole; the piece goes first next day", () => {
    const days = one([...many("A", 4, 60), { id: "E", min: 150 }], 2);
    days.forEach((d) => assertDayInvariants(d));
    expect(prepMin(days[0]!)).toBe(300);
    const e = partsByTask(days).get("bcg/E")!;
    expect(e).toEqual([{ date: FROM, min: 60 }, { date: addDays(FROM, 1), min: 90 }]);
    expect(tasksOf(days[1]!)[0]).toMatchObject({ taskUid: "bcg/E", title: "bcg E (part 2/2)", start: `${addDays(FROM, 1)}T08:00:00+01:00` });
  });

  it("prefers a look-ahead task that fits whole over splitting the head across days", () => {
    // At 240 min F (45) fits whole, so E is not split; 15 min stay unused and E runs whole on day 2.
    const days = one([...many("A", 4, 60), { id: "E", min: 150 }, { id: "F", min: 45 }], 2);
    expect(prepMin(days[0]!)).toBe(285);
    expect(partsByTask(days).get("bcg/E")).toEqual([{ date: addDays(FROM, 1), min: 150 }]);
    expect(tasksOf(days[1]!)[0]!.taskUid).toBe("bcg/E");
  });

  it("no split whose day-1 piece would be under 45 min", () => {
    // 5 x 55 = 275 leaves 25 < 45: E waits whole for day 2.
    const days = one([...many("A", 5, 55), { id: "E", min: 150 }], 2);
    expect(prepMin(days[0]!)).toBe(275);
    expect(partsByTask(days).get("bcg/E")!.map((p) => p.date)).toEqual([addDays(FROM, 1)]);
  });

  it("a task longer than a whole day's prep budget: one contiguous piece today, the rest first thing the next day", () => {
    const days = one([{ id: "A", min: 100 }, { id: "B", min: 400 }, { id: "C", min: 40 }], 2);
    const [d1, d2] = days;
    days.forEach((d) => assertDayInvariants(d));
    // C (40) fits whole first; B's piece today stays inside the first block (100 min, up to the mark).
    expect(tasksOf(d1!).map((t) => t.taskUid).slice(0, 3)).toEqual(["bcg/A", "bcg/C", "bcg/B"]);
    const b1 = tasksOf(d1!).filter((t) => t.taskUid === "bcg/B");
    const b2 = tasksOf(d2!).filter((t) => t.taskUid === "bcg/B");
    expect(b1.map(mins)).toEqual([100]);
    expect(b2.map(mins)).toEqual([240, 60]);
    expect([...b1, ...b2].map((t) => t.title)).toEqual(["bcg B (part 1/3)", "bcg B (part 2/3)", "bcg B (part 3/3)"]);
    expect(b2[0]).toMatchObject({ key: `${addDays(FROM, 1)}|bcg/B|2`, start: `${addDays(FROM, 1)}T08:00:00+01:00` });
  });

  it("a task that cannot sit whole in an empty day (250 min: 240 + 10) is split instead of starving", () => {
    const days = one([{ id: "A", min: 250 }, { id: "B", min: 30 }], 3);
    days.forEach((d) => assertDayInvariants(d));
    const parts = partsByTask(days).get("bcg/A")!;
    expect(parts.reduce((s, p) => s + p.min, 0)).toBe(250);
    for (const p of parts) expect(p.min).toBeGreaterThanOrEqual(MIN_PART);
    expect(daysBetween(parts[0]!.date, parts.at(-1)!.date)).toBeLessThanOrEqual(1);
  });

  it("minPartMin is configurable", () => {
    const files = standardFiles({ bcg: [{ id: "A", min: 30 }, ...many("B", 8, 40)] });
    const dflt = generatePlan({ files, from: FROM, days: 1, config: { timeZone: TZ } })[0]!;
    const loose = generatePlan({ files, from: FROM, days: 1, config: { timeZone: TZ, minPartMin: 1 } })[0]!;
    expect(taskMin(loose)).toBeGreaterThanOrEqual(taskMin(dflt));
    const strict = generatePlan({ files, from: FROM, days: 1, config: { timeZone: TZ, minPartMin: 30 } })[0]!;
    for (const t of tasksOf(strict)) if (t.part) expect(mins(t)).toBeGreaterThanOrEqual(30);
  });
});

describe("generatePlan: tracks, apply and lessons", () => {
  it("hands BCG -> Salesforce -> Anthropic over mid-day in the same slot", () => {
    const files = standardFiles({ bcg: many("B", 3, 60), salesforce: [{ id: "S1", min: 60 }, { id: "S2", min: 120 }], anthropic: many("A", 5, 60) });
    const days = generatePlan({ files, from: FROM, days: 3, config: { timeZone: TZ } });
    days.forEach((d) => assertDayInvariants(d));
    // Day 1: BCG ends and apply joins (budget 270): 180 BCG, then Salesforce S1 in the same slot.
    expect(prepTracks(days[0]!)).toEqual(["bcg", "bcg", "bcg", "salesforce"]);
    expect(has(days[0]!, "apply")).toBe(true);
    // Day 2: S2, then Anthropic takes over in the same slot.
    expect(prepTracks(days[1]!).slice(0, 3)).toEqual(["salesforce", "anthropic", "anthropic"]);
  });

  it("apply is absent while BCG runs and appears from the day BCG finishes, every day after", () => {
    const days = gen({ days: 10 });
    // 16 x 30 = 480 min of BCG; 300 on day 1, the last 180 on day 2 (fits in 270 with apply).
    expect(has(days[0]!, "bcg") && has(days[1]!, "bcg") && !has(days[2]!, "bcg")).toBe(true);
    expect(has(days[0]!, "apply")).toBe(false);
    for (const d of days.slice(1)) expect(has(d, "apply"), d.date).toBe(true);
    expect(tasksOf(days[1]!).at(-1)).toMatchObject({ title: "Apply for positions", key: `${days[1]!.date}|apply/DAILY|1` });
    expect(taskMin(days[1]!)).toBe(480);
  });

  it("circularity: BCG finishes only without apply -> apply starts the next day", () => {
    // Day 1 takes 300. Day 2 has 290 left: fits in 300 (no apply) but not in 270 (with apply).
    const files = standardFiles({ bcg: [...many("B", 5, 60), { id: "L", min: 290 }] });
    const days = generatePlan({ files, from: FROM, days: 3, config: { timeZone: TZ } });
    days.forEach((d) => assertDayInvariants(d));
    expect(has(days[1]!, "apply")).toBe(false);
    expect(tasksOf(days[1]!).filter((t) => t.taskUid === "bcg/L").map(mins).reduce((a, b) => a + b)).toBe(290);
    expect(has(days[2]!, "apply")).toBe(true);
  });

  it("circularity: BCG still finishes with apply included -> apply the same day, shrinking prep", () => {
    const files = standardFiles({ bcg: [...many("B", 5, 60), { id: "L", min: 240 }] });
    const days = generatePlan({ files, from: FROM, days: 2, config: { timeZone: TZ } });
    expect(has(days[1]!, "apply")).toBe(true);
    expect(tasksOf(days[1]!)[0]).toMatchObject({ taskUid: "bcg/L", title: "bcg L" });
    expect(prepMin(days[1]!)).toBeLessThanOrEqual(270);
  });

  it("apply is active from day 1 when every BCG task is already done or skipped", () => {
    const status = new Map(many("B", 16, 30).map((t, i) => [`bcg/${t.id}`, i % 2 ? "done" : "skipped"] as const));
    const [d] = gen({ days: 1, status });
    expect(has(d!, "bcg")).toBe(false);
    expect(has(d!, "apply")).toBe(true);
    expect(tasksOf(d!)[0]!.track).toBe("salesforce");
  });

  it("lessons appear on exactly the first 28 plan days from the anchor, then prep grows", () => {
    const days = gen({ days: 35 });
    expect(days.filter((d) => has(d, "lessons")).map((d) => d.date)).toEqual(days.slice(0, 28).map((d) => d.date));
    for (const d of days) assertDayInvariants(d);
    expect(prepMin(days[28]!)).toBeGreaterThan(300);
    // Regenerating a later window: the caller says how many sessions were already held.
    const later = gen({ from: addDays(FROM, 25), anchor: FROM, days: 5, sessionsHeld: new Map([["lessons/DAILY", 25]]) });
    expect(later.map((d) => has(d, "lessons"))).toEqual([true, true, true, false, false]);
  });

  it("occurrences counts sessions: sessionsHeld shortens what is left to place", () => {
    // 28 sessions in total, wherever the plan starts: 2 already held leave 26 to place.
    expect(gen({ days: 32, sessionsHeld: new Map([["lessons/DAILY", 2]]) }).filter((d) => has(d, "lessons"))).toHaveLength(26);
    expect(gen({ days: 32, sessionsHeld: new Map([["lessons/DAILY", 28]]) }).filter((d) => has(d, "lessons"))).toHaveLength(0);
    // A date whose session is done or skipped held it: the count never depends on the calendar.
    const status = new Map([[`lessons/DAILY@${FROM}`, "done" as const], [`lessons/DAILY@${addDays(FROM, 1)}`, "skipped" as const]]);
    expect(gen({ days: 32, status }).filter((d) => has(d, "lessons"))).toHaveLength(26);
  });
});

describe("generatePlan: status and inputs", () => {
  it("excludes done/skipped tasks and per-date daily status", () => {
    const status = new Map<string, "done" | "skipped">([
      ["bcg/B1", "done"],
      ["bcg/B2", "skipped"],
      [`lessons/DAILY@${FROM}`, "skipped"],
      [`portfolio/DAILY@${addDays(FROM, 1)}`, "done"],
    ]);
    const [d1, d2] = gen({ days: 2, status });
    const uids = [...d1!.items, ...d2!.items].map((i) => i.taskUid);
    expect(uids).not.toContain("bcg/B1");
    expect(uids).not.toContain("bcg/B2");
    expect(tasksOf(d1!)[0]!.taskUid).toBe("bcg/B3");
    expect(has(d1!, "lessons")).toBe(false);
    expect(has(d1!, "portfolio")).toBe(true);
    expect(has(d2!, "lessons")).toBe(true);
    expect(has(d2!, "portfolio")).toBe(false);
    expect(taskMin(d1!)).toBe(480); // freed lesson time goes to prep
    assertDayInvariants(d1!);
    expect(gen({ days: 2, status: (k) => status.get(k) })).toEqual([d1, d2]);
  });

  it("progress drives remaining minutes and part numbering; carry-in only orders", () => {
    // B7 is 30 min with 10 already done and 2 parts done: 20 min left, numbered part 3 of 3.
    const [d] = gen({
      days: 1,
      assumeDone: ["bcg/B1", "bcg/B2"],
      progress: new Map([["bcg/B7", { doneMin: 10, partsDone: 2 }]]),
      carryIn: ["bcg/B7", "bcg/B5"],
    });
    const t = tasksOf(d!);
    expect(t[0]).toMatchObject({ taskUid: "bcg/B7", title: "bcg B7 (part 3/3)", key: `${FROM}|bcg/B7|3`, part: { index: 3, total: 3 } });
    expect(mins(t[0]!)).toBe(20);
    expect(t[1]!.taskUid).toBe("bcg/B5");
    expect(t[2]!.taskUid).toBe("bcg/B3");
    expect(t.map((x) => x.taskUid)).not.toContain("bcg/B1");
    assertDayInvariants(d!);
  });

  it("assumeDone closes a whole task, but progress wins for a task that is only partly placed", () => {
    // The hazard: `assumeDone` on a uid whose minutes are only partly placed would drop the rest.
    const progress = new Map([["bcg/B3", { doneMin: 10, partsDone: 1 }]]);
    const days = gen({ days: 2, assumeDone: ["bcg/B1", "bcg/B3"], progress });
    const uids = days.flatMap((d) => tasksOf(d).map((x) => x.taskUid));
    expect(uids).not.toContain("bcg/B1"); // no progress: assumed done, gone
    const b3 = days.flatMap((d) => tasksOf(d)).filter((x) => x.taskUid === "bcg/B3");
    expect(b3.reduce((n, x) => n + mins(x), 0), "the 20 minutes left of B3 are still placed").toBe(20);
    expect(b3[0]!.part, "and they are its last part").toMatchObject({ index: 2, total: 2 });
    for (const d of days) assertDayInvariants(d);
  });

  it("a task whose progress covers its duration is never scheduled, and its track is finished", () => {
    const progress = new Map(many("B", 16, 30).map((s) => [`bcg/${s.id}`, { doneMin: 30, partsDone: 1 }]));
    const [d] = gen({ days: 1, progress });
    expect(has(d!, "bcg")).toBe(false);
    expect(tasksOf(d!)[0]!.track).toBe("salesforce"); // the next prep track opens
    expect(has(d!, "apply")).toBe(true); // starts_after: bcg is satisfied
  });

  it("carry-in never lets a later prep track jump a lower-priority one that still has work", () => {
    const [d] = gen({ days: 1, carryIn: ["anthropic/A1", "salesforce/S1"] });
    expect(new Set(prepTracks(d!))).toEqual(new Set(["bcg"]));
  });

  it("is deterministic: same inputs, identical output including keys", () => {
    const a = gen({ days: 28 });
    expect(gen({ days: 28, files: [...standardFiles()].reverse() })).toEqual(a);
    expect(JSON.stringify(gen({ days: 28 }))).toBe(JSON.stringify(a));
    const keys = a.flatMap((d) => d.items.map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("a one-off lessons queue schedules one lesson per day", () => {
    const files = [mkFile("p.md", "p", "prep", many("P", 20, 60), { priority: 1 }), mkFile("l.md", "l", "lessons", many("L", 3, 90))];
    const days = generatePlan({ files, from: FROM, days: 4, config: { timeZone: TZ } });
    expect(days.map((d) => tasksOf(d).filter((t) => t.track === "l").map((t) => t.taskUid))).toEqual([["l/L1"], ["l/L2"], ["l/L3"], []]);
    for (const d of days) assertDayInvariants(d);
  });
});

describe("generatePlan: time zones", () => {
  it("Europe/Paris across the 2026-10-25 DST change: 08:00 local every day, exact durations", () => {
    const days = gen({ from: "2026-10-24", days: 3, config: { timeZone: "Europe/Paris" } });
    expect(days.map((d) => d.items[0]!.start)).toEqual(["2026-10-24T08:00:00+02:00", "2026-10-25T08:00:00+01:00", "2026-10-26T08:00:00+01:00"]);
    for (const d of days) {
      assertDayInvariants(d, { timeZone: "Europe/Paris" });
      const last = d.items.at(-1)!;
      expect((ms(last.end) - ms(d.items[0]!.start)) / 60_000).toBe(localMinute(ms(last.end), "Europe/Paris") - 480);
    }
  });

  it("Africa/Tunis has no DST: offset is +01:00 all year", () => {
    const days = gen({ from: "2026-03-25", days: 10 });
    for (const d of days) for (const i of d.items) expect(i.start.endsWith("+01:00")).toBe(true);
    for (const d of days) assertDayInvariants(d);
  });
});

describe("generatePlan: real resources and horizons", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const { files, errors } = loadTaskFiles([`${root}resources`], root);
  const real = (days: number, timeZone = TZ) => generatePlan({ files, from: FROM, days, config: { timeZone } });
  const kindOf = Object.fromEntries(files.map((f) => [f.meta.track, f.meta.kind]));

  it("loads without errors", () => expect(errors).toEqual([]));

  it.each([7, 28, 90])("%d-day horizon: every day passes the invariants", (n) => {
    const plan = real(n);
    expect(plan).toHaveLength(n);
    for (const d of plan) {
      assertDayInvariants(d);
      assertSlotOrder(d, kindOf);
    }
    expect(real(n)).toEqual(plan);
  });

  it("a shorter horizon is exactly the prefix of a longer one", () => {
    const long = real(90);
    for (const n of [1, 7, 28]) expect(real(n)).toEqual(long.slice(0, n));
  });

  it("90 days generate in < 200 ms", () => {
    real(90);
    const t0 = performance.now();
    real(90);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it.each(["Europe/Paris", "Africa/Tunis"])("90 days (%s): no part under the minimum, no needless cross-day split", (tz) => {
    const plan = real(90, tz);
    const parts = partsByTask(plan);
    const dur = new Map(files.flatMap((f) => f.tasks).map((t) => [t.uid, t.durationMin]));
    let split = 0;
    let cross = 0;
    for (const [uid, p] of parts) {
      if (p.length > 1) split++;
      if (p.length > 1) for (const x of p) expect(x.min, uid).toBeGreaterThanOrEqual(MIN_PART);
      const span = daysBetween(p[0]!.date, p.at(-1)!.date);
      expect(span, `${uid}: parts at most a day apart`).toBeLessThanOrEqual(1);
      if (span) {
        cross++;
        expect(dur.get(uid)!, `${uid}: only tasks >= 90 min cross days`).toBeGreaterThanOrEqual(90);
        const perDay = [p[0]!.date, p.at(-1)!.date].map((dt) => p.filter((x) => x.date === dt).reduce((s, x) => s + x.min, 0));
        for (const m of perDay) expect(m, `${uid}: each day's piece >= 45`).toBeGreaterThanOrEqual(45);
      }
      expect(p.reduce((s, x) => s + x.min, 0), uid).toBe(dur.get(uid));
    }
    expect(split).toBeLessThan(60);
    expect(cross).toBeGreaterThan(0);
    // Prep days use their budget: unused prep time stays small.
    const prepDays = plan.filter((d) => tasksOf(d).some((t) => kindOf[t.track!] === "prep"));
    const unused = prepDays.slice(0, -1).reduce((s, d) => s + 480 - taskMin(d), 0);
    expect(unused).toBeLessThan(prepDays.length * 30);
  });

  it("first day: 08:00 BCG, lessons then portfolio at the end, no fragments", () => {
    const d = real(1, "Europe/Paris")[0]!;
    expect(d.items[0]).toMatchObject({ start: "2026-09-28T08:00:00+02:00", track: "bcg" });
    expect(tracks(d).slice(-2)).toEqual(["lessons", "portfolio"]);
    expect(taskMin(d)).toBeGreaterThanOrEqual(450);
    // The skip test decides what to skip: it opens BCG at 08:00, never reordered behind techniques.
    expect(d.items[0]).toMatchObject({ taskUid: "bcg/SKIP", start: "2026-09-28T08:00:00+02:00" });
    expect(tasksOf(d).every((t) => !t.part || mins(t) >= MIN_PART)).toBe(true);
  });

  it("BCG finishes mid-horizon, Salesforce takes over the same day, apply appears that day", () => {
    const plan = real(28);
    const last = plan.findIndex((d, i) => has(d, "bcg") && !plan.slice(i + 1).some((x) => has(x, "bcg")));
    expect(last).toBeGreaterThan(0);
    // Salesforce continues the same slot that day if its next task fits the leftover budget whole.
    const tr = tracks(plan[last]!);
    const sfHead = files.find((f) => f.meta.track === "salesforce")!.tasks[0]!;
    const leftover = 270 - prepMin(plan[last]!);
    if (tr.includes("salesforce")) expect(tr.lastIndexOf("bcg")).toBeLessThan(tr.indexOf("salesforce"));
    else expect(leftover < sfHead.durationMin && (sfHead.durationMin < 90 || leftover < 45)).toBe(true);
    expect(tasksOf(plan[last + 1]!)[0]!.track).toBe("salesforce");
    expect(plan.slice(0, last).some((d) => has(d, "apply"))).toBe(false);
    expect(plan.slice(last + 1).every((d) => has(d, "apply"))).toBe(true);
    const all = real(90);
    expect(all.filter((d) => has(d, "lessons"))).toHaveLength(28);
    expect(all.some((d) => has(d, "anthropic"))).toBe(true);
  });
});
