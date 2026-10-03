/**
 * P7 (docs/PLAN.md): explicit task progress. The generator's only sources of truth are `progress`
 * (minutes and parts done), `sessionsHeld` (daily sessions) and `status`; `carryIn` only orders.
 *
 * This file holds the three core regressions the P1/P2 critics found and a seeded property test over
 * generate + shift sequences that asserts P7's invariants 1-4 plus every day invariant, in two zones
 * and at horizons 7, 28 and 90.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  addDays,
  carryInFor,
  generatePlan,
  loadTaskFiles,
  localDate,
  projectedProgress,
  shiftPlan,
  statusKey,
  type ItemStatus,
  type PlanDay,
  type PlanItem,
  type ShiftUnit,
  type Task,
  type TaskFile,
  type TaskProgress,
} from "../src/index.ts";
import { assertDayInvariants, assertSlotOrder, mins, ms, tasksOf } from "./schedule-helpers.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REAL = loadTaskFiles([`${ROOT}resources`], ROOT).files;
const KIND_OF = Object.fromEntries(REAL.map((f) => [f.meta.track, f.meta.kind]));
const PRIORITY = new Map(REAL.filter((f) => f.meta.kind === "prep").map((f) => [f.meta.track, f.meta.priority ?? 99]));
const TASKS = new Map<string, Task>();
for (const f of [...REAL].sort((a, b) => (a.path < b.path ? -1 : 1))) for (const t of f.tasks) if (!TASKS.has(t.uid)) TASKS.set(t.uid, t);
const isDaily = (uid: string) => TASKS.get(uid)?.repeat === "daily";
const durationOf = (uid: string) => TASKS.get(uid)?.durationMin;
const LESSONS = "lessons/DAILY";
const OCCURRENCES = TASKS.get(LESSONS)!.occurrences!;

// ---------------------------------------------------------------- unit: the two shared projections

describe("projectedProgress / carryInFor", () => {
  const item = (uid: string, date: string, hm: string, min: number, status: ItemStatus = "pending", part?: [number, number]): PlanItem => ({
    key: `${date}|${uid}|${part?.[0] ?? 1}`,
    date,
    kind: "task",
    start: `${date}T${hm}:00+01:00`,
    end: new Date(Date.parse(`${date}T${hm}:00+01:00`) + min * 60_000).toISOString().replace("Z", "+00:00"),
    taskUid: uid,
    title: uid,
    status,
    ...(part ? { part: { index: part[0], total: part[1] } } : {}),
  });

  it("projects the minutes of PENDING one-off parts that stay, and nothing else", () => {
    const base = new Map<string, TaskProgress>([["a/1", { doneMin: 30, partsDone: 1 }]]);
    const kept = [item("a/1", "2026-09-28", "08:00", 60), item("a/2", "2026-09-28", "10:00", 60, "done"), item("d/DAILY", "2026-09-28", "12:00", 60)];
    const p = projectedProgress(base, kept, (u) => u === "d/DAILY");
    expect(p.get("a/1")).toEqual({ doneMin: 90, partsDone: 2 }); // 30 done + 60 kept
    expect(p.get("a/2")).toEqual({ doneMin: 0, partsDone: 1 }); // a done part adds no minutes, only a part floor
    expect(p.has("d/DAILY")).toBe(false); // daily tasks use sessions, never minutes
    expect(projectedProgress(undefined, [], () => false).size).toBe(0);
    // A part that stays keeps its number: what follows is numbered after it, never over it.
    const stale = projectedProgress(new Map(), [item("a/1", "2026-09-28", "08:00", 60, "pending", [4, 5])], () => false);
    expect(stale.get("a/1")).toEqual({ doneMin: 60, partsDone: 4 });
  });

  it("carries only tasks that are under way AND unfinished, continuations first", () => {
    const dur = (u: string) => ({ "a/1": 150, "a/2": 60, "a/3": 90 })[u];
    const kept = [item("a/3", "2026-09-28", "09:00", 30), item("a/2", "2026-09-28", "08:00", 60)];
    const p = projectedProgress(new Map([["a/1", { doneMin: 50, partsDone: 1 }]]), kept, () => false);
    // a/1: begun earlier, leads. a/3: begun today, 60 left. a/2: fully placed today, dropped.
    expect(carryInFor(p, kept, dur, () => false)).toEqual(["a/1", "a/3"]);
    expect(carryInFor(new Map(), [], dur, () => false)).toEqual([]);
  });
});

// ---------------------------------------------------------------- regression A (P1 round 3)

describe("regression A: a prep track never starts while a lower-priority one has remaining work", () => {
  /** Walk the plan item by item; `rem` starts at duration - doneMin and drops as minutes are placed. */
  function trackViolations(days: PlanDay[], progress = new Map<string, TaskProgress>()): string[] {
    const rem = new Map<string, number>();
    for (const [uid, t] of TASKS) if (PRIORITY.has(t.track)) rem.set(uid, t.durationMin - (progress.get(uid)?.doneMin ?? 0));
    const open = (track: string) => [...rem].some(([u, m]) => m > 0 && TASKS.get(u)!.track === track);
    const out: string[] = [];
    for (const d of days)
      for (const it of d.items) {
        if (it.kind !== "task" || !it.taskUid || !PRIORITY.has(it.track!)) continue;
        for (const [track, p] of PRIORITY)
          if (p < PRIORITY.get(it.track!)! && open(track)) out.push(`${d.date} ${it.key} while ${track} still has work`);
        rem.set(it.taskUid, (rem.get(it.taskUid) ?? 0) - mins(it));
      }
    return out;
  }

  it("60 days from 2026-09-29 (Paris): anthropic waits for salesforce, salesforce for bcg", () => {
    const plan = generatePlan({ files: REAL, from: "2026-09-29", days: 60, anchor: "2026-09-28", config: { timeZone: "Europe/Paris" } });
    expect(trackViolations(plan)).toEqual([]);
    // The handover is strictly ordered, one track at a time, and anthropic starts last.
    const firstDay = new Map<string, string>();
    for (const d of plan) for (const it of d.items) if (it.kind === "task" && PRIORITY.has(it.track!) && !firstDay.has(it.track!)) firstDay.set(it.track!, d.date);
    expect([...firstDay.keys()]).toEqual(["bcg", "salesforce", "anthropic"]);
    const t1 = plan.flatMap((d) => d.items).filter((i) => i.taskUid === "anthropic/T1");
    const sfLast = plan.flatMap((d) => d.items.map((i) => ({ ...i, d: d.date }))).filter((i) => i.track === "salesforce").at(-1)!;
    for (const i of t1) expect(i.date >= sfLast.d, `${i.key} before salesforce finished on ${sfLast.d}`).toBe(true);
  });

  it("a mid-split task keeps its track open (the split bookkeeping cannot hide it)", () => {
    // SKIP + one 600-min salesforce task: its cross-day piece must not let anthropic in.
    const files = REAL.map((f) =>
      f.meta.track === "salesforce" ? { ...f, tasks: f.tasks.slice(0, 1).map((t) => ({ ...t, durationMin: 600 })) } : f,
    );
    const done = new Map<string, ItemStatus>(files.flatMap((f) => (f.meta.track === "bcg" ? f.tasks.map((t) => [t.uid, "done" as ItemStatus]) : [])));
    const plan = generatePlan({ files, from: "2026-09-28", days: 6, config: { timeZone: "Europe/Paris" }, status: done });
    const tracks = plan.map((d) => [...new Set(tasksOf(d).map((t) => t.track))].filter((t) => PRIORITY.has(t!)));
    expect(tracks.slice(0, 2)).toEqual([["salesforce"], ["salesforce"]]);
    expect(plan.flatMap((d) => tasksOf(d)).filter((t) => t.taskUid!.startsWith("anthropic/")).length).toBeGreaterThan(0);
    for (const d of plan) assertDayInvariants(d, { timeZone: "Europe/Paris" });
  });
});

// ---------------------------------------------------------------- the world (what the store does)

/**
 * The store's contract, in memory: durable progress and held sessions, a timeline, and a `checked`
 * list for done/skipped items that lost their slot. Pending items before today are history that never
 * happened: they are purged and their tasks re-placed (docs/PLAN.md P7, "Store and API rules").
 */
class World {
  days = new Map<string, PlanItem[]>();
  checked: PlanItem[] = [];
  progress = new Map<string, TaskProgress>();
  status = new Map<string, ItemStatus>();
  held = new Map<string, Set<string>>();
  today: string;
  nowMs: number;
  /** Last day off left by a days shift. `replan` keeps it; only an explicit rebuild clears it. */
  offUntil?: string;
  /** The dates a days shift actually left empty. A replan must never refill one (invariant 6). */
  daysOff = new Set<string>();

  constructor(
    readonly files: TaskFile[],
    readonly tz: string,
    readonly horizon: number,
    now: string,
    readonly anchor = localDate(Date.parse(now), tz),
  ) {
    this.nowMs = Date.parse(now);
    this.today = localDate(this.nowMs, tz);
    this.regen(this.today);
  }

  get end(): string {
    return addDays(this.today, this.horizon - 1);
  }
  dates(from = this.today): string[] {
    const last = [...this.days.keys()].reduce((a, b) => (a > b ? a : b), this.end);
    const out: string[] = [];
    for (let d = from; d <= last; d = addDays(d, 1)) out.push(d);
    return out;
  }
  plan(from = this.today): PlanDay[] {
    return this.dates(from).map((date) => ({ date, items: this.days.get(date) ?? [] }));
  }
  items(): PlanItem[] {
    return [...this.days.values()].flat();
  }
  statusOf(key: string): ItemStatus {
    return this.status.get(key) ?? "pending";
  }
  remainingOf(uid: string): number {
    return (durationOf(uid) ?? 0) - (this.progress.get(uid)?.doneMin ?? 0);
  }

  /** A session is held on a date that ran (it is in the past, or its status closed it). */
  private harvest(): void {
    // A session ran when its date is past, or when its status closed it (done OR skipped).
    for (const [date, items] of this.days)
      for (const it of items) if (it.taskUid && isDaily(it.taskUid) && (date < this.today || it.status !== "pending")) this.hold(it.taskUid, date);
    for (const it of this.checked) if (it.taskUid && isDaily(it.taskUid)) this.hold(it.taskUid, it.date);
  }
  hold(uid: string, date: string): void {
    this.held.set(uid, (this.held.get(uid) ?? new Set()).add(date));
  }
  private purge(): void {
    for (const [date, items] of this.days) if (date < this.today) this.days.set(date, items.filter((i) => i.status !== "pending"));
  }
  heldDates(uid: string): string[] {
    return [...new Set([...(this.held.get(uid) ?? []), ...this.checked.filter((i) => i.taskUid === uid).map((i) => i.date)])];
  }
  sessionsHeld(from: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const [uid, t] of TASKS) {
      if (t.repeat !== "daily" || t.occurrences === undefined) continue;
      const dates = new Set(this.heldDates(uid).filter((d) => d < from));
      for (const [date, items] of this.days) if (date < from && items.some((i) => i.taskUid === uid)) dates.add(date);
      out.set(uid, dates.size);
    }
    return out;
  }
  kept(from: string): PlanItem[] {
    return this.plan(this.today).filter((d) => d.date < from).flatMap((d) => d.items);
  }

  /** Rebuild every date from `from`. Done and skipped items that lose their slot go to `checked`. */
  regen(from: string, clearDaysOff = false): void {
    this.purge();
    this.harvest();
    if (clearDaysOff && this.offUntil && this.offUntil >= from) {
      this.offUntil = from > this.today ? addDays(from, -1) : undefined;
      for (const d of [...this.daysOff]) if (d >= from) this.daysOff.delete(d);
    }
    if (this.offUntil && this.offUntil >= from) {
      // A day off stays off: clear it and start the rebuild after it (invariant 6).
      for (let d = from; d <= this.offUntil; d = addDays(d, 1)) this.days.set(d, (this.days.get(d) ?? []).filter((i) => i.status !== "pending"));
      from = addDays(this.offUntil, 1);
    }
    const progress = projectedProgress(this.progress, this.kept(from), isDaily);
    const gen = generatePlan({
      files: this.files,
      from,
      days: Math.max(1, (Date.parse(`${this.end}T00:00Z`) - Date.parse(`${from}T00:00Z`)) / 86_400_000 + 1),
      anchor: this.anchor,
      config: { timeZone: this.tz },
      status: this.status,
      progress,
      sessionsHeld: this.sessionsHeld(from),
      carryIn: carryInFor(progress, this.kept(from), durationOf, isDaily),
    });
    const keys = new Set(gen.flatMap((d) => d.items.map((i) => i.key)));
    for (const date of this.dates(from)) {
      for (const it of this.days.get(date) ?? []) if (it.status !== "pending" && !keys.has(it.key)) this.checked.push(it);
      this.days.delete(date);
    }
    for (const d of gen) this.days.set(d.date, d.items);
  }

  shift(amount: number, unit: ShiftUnit): void {
    this.purge();
    this.harvest();
    const r = shiftPlan({
      plan: this.plan(this.today),
      now: this.nowMs,
      amount,
      unit,
      files: this.files,
      anchor: this.anchor,
      config: { timeZone: this.tz },
      status: this.status,
      progress: this.progress,
      heldDates: new Map([...TASKS.keys()].filter(isDaily).map((uid) => [uid, this.heldDates(uid)])),
      days: this.horizon,
      ...(this.offUntil && this.offUntil >= this.today ? { offUntil: this.offUntil } : {}),
    });
    const keys = new Set(r.days.flatMap((d) => d.items.map((i) => i.key)));
    for (const date of this.dates(this.today)) {
      for (const it of this.days.get(date) ?? []) if (it.status !== "pending" && !keys.has(it.key)) this.checked.push(it);
      this.days.delete(date);
    }
    for (const d of r.days) this.days.set(d.date, d.items);
    if (unit === "days") {
      const off = addDays(this.today, amount - 1);
      if (off > (this.offUntil ?? "")) this.offUntil = off;
      for (let d = this.today; d <= off; d = addDays(d, 1)) if (!(this.days.get(d) ?? []).some((i) => i.status === "pending")) this.daysOff.add(d);
    }
  }

  /** P7's transition table, by item. */
  setItemStatus(it: PlanItem, status: ItemStatus): void {
    const uid = it.taskUid!;
    const key = statusKey(uid, isDaily(uid) ? it.date : undefined);
    const was = it.status;
    if (!isDaily(uid)) {
      const p = this.progress.get(uid) ?? { doneMin: 0, partsDone: 0 };
      if (was === "done" && status !== "done") this.progress.set(uid, { doneMin: Math.max(0, p.doneMin - mins(it)), partsDone: Math.max(0, p.partsDone - 1) });
      else if (was !== "done" && status === "done") this.progress.set(uid, { doneMin: Math.min(durationOf(uid)!, p.doneMin + mins(it)), partsDone: p.partsDone + 1 });
    }
    const last = !it.part || it.part.index === it.part.total;
    const covered = (this.progress.get(uid)?.doneMin ?? 0) >= (durationOf(uid) ?? Infinity);
    if (status === "pending") this.status.delete(key);
    else if (status === "skipped" || last || covered) this.status.set(key, status);
    if (status === "pending") {
      this.days.set(it.date, (this.days.get(it.date) ?? []).filter((x) => x.key !== it.key));
      this.checked = this.checked.filter((x) => x.key !== it.key);
      if (isDaily(uid)) this.held.get(uid)?.delete(it.date);
      this.regen(it.date < this.today ? this.today : it.date);
    } else {
      this.days.set(it.date, (this.days.get(it.date) ?? []).map((x) => (x.key === it.key ? { ...x, status } : x)));
      if (isDaily(uid)) this.hold(uid, it.date);
      this.regen(addDays(this.today, 1));
    }
  }

  /** P7's transition table, by uid. */
  setTaskStatus(uid: string, status: ItemStatus, date?: string): void {
    const key = statusKey(uid, date);
    const mine = (i: PlanItem) => i.taskUid === uid && (!date || i.date === date);
    if (status === "pending") {
      this.status.delete(key);
      if (!isDaily(uid)) this.progress.delete(uid);
      else if (date) this.held.get(uid)?.delete(date);
      for (const [d, items] of this.days) this.days.set(d, items.filter((i) => !mine(i)));
      this.checked = this.checked.filter((i) => !mine(i));
      this.regen(this.today);
      return;
    }
    this.status.set(key, status);
    if (status === "done" && !isDaily(uid))
      this.progress.set(uid, { doneMin: durationOf(uid)!, partsDone: Math.max(1, this.items().filter(mine).length) });
    for (const [d, items] of this.days) this.days.set(d, items.map((i) => (mine(i) ? { ...i, status } : i)));
    this.regen(addDays(this.today, 1));
  }

  advance(minutes: number): void {
    this.nowMs += minutes * 60_000;
    const date = localDate(this.nowMs, this.tz);
    if (date === this.today) return;
    this.today = date;
    this.regen(this.today); // the midnight rollover: unfinished work comes back
  }
}

// ---------------------------------------------------------------- the six invariants, as assertions

function assertInvariants(w: World, where: string): void {
  const plan = w.plan(w.today);
  for (const d of plan) {
    if (!d.items.length) continue;
    assertDayInvariants(d, { timeZone: w.tz, strictStart: d.date !== w.today, stretchedRests: d.date === w.today, allowTrailingRest: d.date === w.today, allowGaps: d.date === w.today });
    assertSlotOrder(d, KIND_OF);
  }

  // 2. Done minutes never exceed the duration, and the same minutes are never placed twice.
  const placed = new Map<string, PlanItem[]>();
  for (const it of [...w.items(), ...w.checked]) if (it.kind === "task" && it.taskUid) placed.set(it.taskUid, [...(placed.get(it.taskUid) ?? []), it]);
  for (const [uid, items] of placed) {
    if (isDaily(uid)) continue;
    const dur = durationOf(uid)!;
    const p = w.progress.get(uid) ?? { doneMin: 0, partsDone: 0 };
    expect(p.doneMin, `${where}: ${uid} done minutes`).toBeLessThanOrEqual(dur);
    const doneMin = items.filter((i) => i.status === "done").reduce((n, i) => n + mins(i), 0);
    if (w.statusOf(uid) !== "done") expect(doneMin, `${where}: ${uid} done items vs progress`).toBeLessThanOrEqual(p.doneMin);
    const pending = items.filter((i) => i.status === "pending").reduce((n, i) => n + mins(i), 0);
    expect(pending, `${where}: ${uid} placed twice (${pending} pending min, ${dur} - ${p.doneMin} left)`).toBeLessThanOrEqual(dur - p.doneMin);
    const idx = items.filter((i) => i.status === "pending").map((i) => i.part?.index ?? 1);
    expect(new Set(idx).size, `${where}: ${uid} duplicate part numbers ${idx.join(",")}`).toBe(idx.length);
  }

  // 1 + 4. No task of a later section or of a higher-priority-number prep track is placed while an
  // earlier one still has remaining work.
  const rem = new Map<string, number>();
  for (const [uid, t] of TASKS) if (PRIORITY.has(t.track) && w.statusOf(uid) === "pending" && w.remainingOf(uid) > 0) rem.set(uid, w.remainingOf(uid));
  const open = (track: string) => [...rem].some(([u, m]) => m > 0 && TASKS.get(u)!.track === track);
  const sections = new Map<string, string[]>();
  for (const [uid, t] of TASKS) if (PRIORITY.has(t.track) && !(sections.get(t.track) ?? []).includes(t.section ?? "")) sections.set(t.track, [...(sections.get(t.track) ?? []), t.section ?? ""]);
  for (const d of plan)
    for (const it of d.items) {
      if (it.kind !== "task" || !it.taskUid || !PRIORITY.has(it.track!)) continue;
      // An item that has already started is under way; only what is still ahead can "start" a track.
      const ahead = ms(it.start) >= w.nowMs;
      for (const [track, p] of PRIORITY)
        if (ahead && p < PRIORITY.get(it.track!)! && open(track)) throw new Error(`${where}: ${d.date} ${it.key} placed while ${track} still has remaining work`);
      const sec = sections.get(it.track!)!;
      const mySec = sec.indexOf(TASKS.get(it.taskUid)!.section ?? "");
      for (const [u, m] of rem)
        if (ahead && m > 0 && TASKS.get(u)!.track === it.track && sec.indexOf(TASKS.get(u)!.section ?? "") < mySec && !w.items().some((x) => x.taskUid === u))
          throw new Error(`${where}: ${d.date} ${it.key} placed while ${u} (earlier section) is nowhere on the plan`);
      rem.set(it.taskUid, (rem.get(it.taskUid) ?? 0) - mins(it));
    }

  // 1. With a horizon long enough to hold every remaining minute, nothing pending is unreachable.
  if (w.horizon >= 60) {
    const on = new Set(w.items().flatMap((i) => (i.taskUid ? [i.taskUid] : [])));
    for (const [uid] of TASKS)
      if (!isDaily(uid) && w.statusOf(uid) === "pending" && w.remainingOf(uid) > 0)
        expect(on.has(uid), `${where}: ${uid} is pending with ${w.remainingOf(uid)} min left and scheduled nowhere`).toBe(true);
  }

  // 3. Sessions held plus sessions planned never exceed `occurrences`, and none is ever skipped: a
  // horizon long enough to hold them all holds exactly `occurrences`.
  const heldDates = new Set(w.heldDates(LESSONS));
  for (const [date, items] of w.days) if (items.some((i) => i.taskUid === LESSONS)) heldDates.add(date);
  expect(heldDates.size, `${where}: lesson sessions held + planned`).toBeLessThanOrEqual(OCCURRENCES);
  if (w.horizon >= 60) expect(heldDates.size, `${where}: lesson sessions held + planned`).toBe(OCCURRENCES);
  else
    for (const d of plan)
      if (heldDates.size < OCCURRENCES && d.items.some((i) => i.kind === "task") && w.statusOf(statusKey(LESSONS, d.date)) === "pending")
        expect(d.items.some((i) => i.taskUid === LESSONS), `${where}: ${d.date} has work but no lesson while sessions are left`).toBe(true);

  // 6. A day off is never refilled by a replan.
  for (const d of plan)
    if (w.daysOff.has(d.date)) expect(d.items.filter((i) => i.status === "pending"), `${where}: ${d.date} is a day off`).toEqual([]);
}

// ---------------------------------------------------------------- regression B and C

describe("regression B: a cross-day split is never duplicated by a shift", () => {
  it("+2 days then +1 day (Paris, 90 days): every task's placed minutes equal its duration", () => {
    const status = new Map<string, ItemStatus>();
    for (const [uid, t] of TASKS) if (t.track === "bcg") status.set(uid, "done");
    status.set("salesforce/SKIP", "done");
    const w = new World(REAL, "Europe/Paris", 90, "2026-09-28T08:00:00+02:00");
    w.status = status;
    w.regen(w.today);
    const a1 = "salesforce/A1";
    const split = w.items().filter((i) => i.taskUid === a1);
    expect(split.length, "A1 is split by the fixture").toBeGreaterThan(0);

    w.advance((22 - 8) * 60 + 8 * 24 * 60); // 2026-10-06T22:00
    expect(w.today).toBe("2026-10-06");
    w.shift(2, "days");
    assertInvariants(w, "after +2 days");
    w.advance(12 * 60); // 2026-10-07T10:00, now a day off
    expect(w.today).toBe("2026-10-07");
    expect(w.days.get("2026-10-07") ?? []).toEqual([]);
    w.shift(1, "days");
    assertInvariants(w, "after +1 day");

    // No task is on the plan twice for the same minutes, and each one is placed in full exactly once.
    for (const [uid, t] of TASKS) {
      if (isDaily(uid) || w.statusOf(uid) !== "pending") continue;
      const total = [...w.items(), ...w.checked].filter((i) => i.taskUid === uid).reduce((n, i) => n + mins(i), 0);
      expect(total, `${uid} placed minutes`).toBe(t.durationMin - (w.progress.get(uid)?.doneMin ?? 0));
    }
    const parts = [...w.items(), ...w.checked].filter((i) => i.taskUid === a1);
    expect(parts.reduce((n, i) => n + mins(i), 0)).toBe(TASKS.get(a1)!.durationMin);
    expect(new Set(parts.map((i) => i.date)).size, "A1 is not on two unrelated dates").toBeLessThanOrEqual(2);
  });
});

describe("regression D: a skipped session is held, so a shift cannot hand out a 29th", () => {
  it("skip 2026-09-29's lesson at 11:59 (Paris), then shift: still 28 sessions", () => {
    for (const [amount, unit] of [[12, "hours"], [1, "days"], [30, "minutes"]] as [number, ShiftUnit][]) {
      const w = new World(REAL, "Europe/Paris", 90, "2026-09-28T08:00:00+02:00");
      w.advance(24 * 60 + 3 * 60 + 59); // 2026-09-29T11:59
      expect(w.today).toBe("2026-09-29");
      w.setTaskStatus(LESSONS, "skipped", "2026-09-29");
      expect(w.heldDates(LESSONS), "the skipped session is held").toContain("2026-09-29");
      w.shift(amount, unit);
      const held = new Set(w.heldDates(LESSONS));
      for (const [d, items] of w.days) if (items.some((i) => i.taskUid === LESSONS)) held.add(d);
      expect(held.size, `+${amount} ${unit}`).toBe(OCCURRENCES);
      expect(held.has("2026-09-29")).toBe(true);
      assertInvariants(w, `skipped session then +${amount} ${unit}`);
    }
  });
});

describe("regression C: lessons stay at 28 sessions across a grid of shifts", () => {
  it("2026-10-24T07:00 Paris +3 days keeps 28, and so does every shift of the grid", () => {
    const one = (date: string, hm: string, amount: number, unit: ShiftUnit) => {
      const w = new World(REAL, "Europe/Paris", 90, "2026-09-28T08:00:00+02:00");
      const target = Date.parse(`${date}T${hm}:00+0${date < "2026-10-25" ? 2 : 1}:00`);
      w.advance((target - w.nowMs) / 60_000);
      w.shift(amount, unit);
      const held = new Set(w.heldDates(LESSONS));
      for (const [d, items] of w.days) if (items.some((i) => i.taskUid === LESSONS)) held.add(d);
      expect(held.size, `${date} ${hm} +${amount} ${unit}`).toBe(OCCURRENCES);
      assertInvariants(w, `${date} ${hm} +${amount} ${unit}`);
    };
    one("2026-10-24", "07:00", 3, "days");
    for (const hm of ["07:00", "09:30", "13:30", "18:00"])
      for (const [n, unit] of [[45, "minutes"], [12, "hours"], [1, "days"], [3, "days"]] as [number, ShiftUnit][])
        for (const date of ["2026-10-20", "2026-10-24"]) one(date, hm, n, unit);
  }, 120_000);
});

// ---------------------------------------------------------------- the seeded property test

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

describe("P7 invariants over random generate + shift sequences", () => {
  const configs: [string, number][] = [
    ["Europe/Paris", 7],
    ["Europe/Paris", 28],
    ["Europe/Paris", 90],
    ["Africa/Tunis", 7],
    ["Africa/Tunis", 28],
    ["Africa/Tunis", 90],
  ];
  it("300 seeded steps (2 zones x horizons 7/28/90) keep invariants 1-4 and every day invariant", () => {
    const log: string[] = [];
    for (const [tz, horizon] of configs) {
      const rnd = mulberry32(0x7 * horizon + tz.length);
      const w = new World(REAL, tz, horizon, `2026-09-28T07:30:00+0${tz === "Europe/Paris" ? 2 : 1}:00`);
      assertInvariants(w, `${tz}/${horizon} start`);
      for (let n = 0; n < 50; n++) {
        const r = rnd();
        const pool = w.plan(w.today).flatMap((d) => tasksOf(d));
        const pick = <T,>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(rnd() * xs.length)] : undefined);
        let op = "";
        if (r < 0.3) {
          const it = pick(pool.filter((i) => i.status === "pending"));
          if (it) {
            const status = pick(["done", "done", "skipped"] as ItemStatus[])!;
            op = `item ${it.key} ${status}`;
            w.setItemStatus(it, status);
          }
        } else if (r < 0.42) {
          const it = pick([...pool, ...w.checked].filter((i) => i.status !== "pending"));
          if (it) {
            op = `undo item ${it.key}`;
            w.setItemStatus(it, "pending");
          }
        } else if (r < 0.55) {
          const uid = pick([...TASKS.keys()].filter((u) => !isDaily(u)))!;
          const status = pick(["done", "skipped", "pending"] as ItemStatus[])!;
          op = `task ${uid} ${status}`;
          w.setTaskStatus(uid, status);
        } else if (r < 0.62) {
          const date = pick(w.plan(w.today).filter((d) => d.items.some((i) => i.taskUid === LESSONS)).map((d) => d.date));
          if (date) {
            const status = pick(["done", "skipped", "pending"] as ItemStatus[])!;
            op = `daily ${LESSONS}@${date} ${status}`;
            w.setTaskStatus(LESSONS, status, date);
          }
        } else if (r < 0.85) {
          const unit = pick(["minutes", "minutes", "hours", "days"] as ShiftUnit[])!;
          const amount = unit === "minutes" ? 5 + Math.floor(rnd() * 200) : unit === "hours" ? 1 + Math.floor(rnd() * 6) : 1 + Math.floor(rnd() * 3);
          if (w.plan(w.today).flatMap((d) => d.items).some((i) => ms(i.start) >= w.nowMs)) {
            op = `shift ${amount} ${unit}`;
            w.shift(amount, unit);
          }
        } else if (r < 0.93) {
          const from = rnd() < 0.5 ? w.today : addDays(w.today, 1 + Math.floor(rnd() * 3));
          const clear = rnd() < 0.5;
          op = `regenerate ${from}${clear ? " (clears days off)" : ""}`;
          w.regen(from, clear);
        } else {
          const minutes = 30 + Math.floor(rnd() * 900);
          op = `advance ${minutes}m`;
          w.advance(minutes);
        }
        if (!op) continue;
        log.push(`${tz}/${horizon} ${op}`);
        assertInvariants(w, `${tz}/${horizon} step ${n} (${op}); log: ${log.slice(-6).join(" | ")}`);
      }
    }
    expect(log.length).toBeGreaterThanOrEqual(250);
  }, 600_000);
});
