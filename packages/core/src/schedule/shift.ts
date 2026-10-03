import type { Task, TaskFile } from "../taskfile/types.ts";
import { carryInFor, generatePlan, projectedProgress, resolveConfig, type GenerateInput } from "./generate.ts";
import { addDays, daysBetween, localDate, parseInstant, toIso, zonedMs } from "./time.ts";
import { MAX_SHIFT_MS, type PlanDay, type PlanItem, type ShiftAmountUnit } from "./types.ts";

export type ShiftErrorCode = "INVALID_AMOUNT" | "INVALID_UNIT" | "INVALID_NOW";

export class ShiftError extends Error {
  readonly code: ShiftErrorCode;
  readonly hint: string;
  constructor(code: ShiftErrorCode, message: string, hint: string) {
    super(message);
    this.name = "ShiftError";
    this.code = code;
    this.hint = hint;
  }
}

export interface ShiftInput extends Omit<GenerateInput, "from" | "days" | "carryIn" | "sessionsHeld"> {
  /** The materialized plan. Days before today are ignored and not returned. */
  plan: readonly PlanDay[];
  now: string | number | Date;
  amount: number;
  /**
   * `minutes` / `hours` / `days` take a whole number. `ms` takes a whole number of milliseconds and is
   * applied EXACTLY as given, never rounded to a minute: it is the path pause/resume uses (P8). It
   * follows the same rules as a minute shift in every other respect.
   */
  unit: ShiftAmountUnit;
  /** Horizon in days from today. Default: today through the plan's last date. */
  days?: number;
  /**
   * Dates up to and including this one are days off (an earlier days shift left them empty) and must
   * stay off: the regeneration starts after it. Without it, a `+1 day` shift could land the work it
   * moves on a day the owner already pushed past.
   */
  offUntil?: string;
  /**
   * Per daily task uid: the dates whose session is already held OUTSIDE the timeline it is given
   * (the store's `sessions_held` rows and its `checked` items). Sessions the shifted plan still holds
   * before the regeneration date are added to these, without counting a date twice.
   */
  heldDates?: ReadonlyMap<string, readonly string[]>;
}

export interface ShiftResult {
  today: string;
  /** The whole new plan from today on, one entry per date, chronological. */
  days: PlanDay[];
  /** Same key as before, changed content (times, title, part). */
  moved: PlanItem[];
  /** Keys that did not exist before: re-keyed items (days shift) and regenerated items. */
  added: PlanItem[];
  /** Keys that no longer exist. */
  removedKeys: string[];
  /** Dates rebuilt by the generator. */
  regeneratedDates: string[];
  /** Uids handed to the first regenerated day's prep slot, in order. Ordering only. */
  carryIn: string[];
  /** Daily-task items that left today and were not carried (tomorrow has its own instance). */
  dropped: PlanItem[];
}

const MIN = 60_000;

/**
 * Validate the shift itself, with no plan in hand, so a caller can reject a bad request before it
 * looks at the plan: the answer to an invalid amount must not depend on what today still holds.
 */
export function checkShiftAmount(amount: number, unit: ShiftAmountUnit): void {
  if (unit !== "minutes" && unit !== "hours" && unit !== "days" && unit !== "ms")
    throw new ShiftError("INVALID_UNIT", `unknown shift unit "${String(unit)}"`, 'use "minutes", "hours" or "days"');
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0)
    throw new ShiftError("INVALID_AMOUNT", `shift amount must be positive, got ${String(amount)}`, "shifts only move the plan later; pass a positive amount");
  if (!Number.isInteger(amount))
    throw new ShiftError(
      "INVALID_AMOUNT",
      `shift amount must be a whole number of ${unit === "ms" ? "milliseconds" : unit}, got ${amount}`,
      unit === "hours" ? "use minutes for fractions of an hour" : unit === "ms" ? "milliseconds are the smallest step; round the amount" : "round the amount",
    );
  // The exact path is bounded here, because nothing downstream re-derives minutes from it.
  if (unit === "ms" && amount > MAX_SHIFT_MS)
    throw new ShiftError(
      "INVALID_AMOUNT",
      `an exact shift may move the plan by at most ${MAX_SHIFT_MS} ms (24 h), got ${amount} ms`,
      'move whole days instead ({ "amount": 1, "unit": "days" })',
    );
}

function validate(amount: number, unit: ShiftAmountUnit, now: ShiftInput["now"]): number {
  checkShiftAmount(amount, unit);
  try {
    return parseInstant(now);
  } catch {
    throw new ShiftError("INVALID_NOW", `invalid "now": ${String(now)}`, "pass an ISO-8601 instant with offset");
  }
}

const ms = (iso: string) => Date.parse(iso);

/** Drop trailing rests, except one in progress at `now`. */
function trimTrailingRests(items: PlanItem[], now: number): PlanItem[] {
  let b = items.length;
  while (b > 0 && items[b - 1]!.kind === "rest" && !(ms(items[b - 1]!.start) < now && now < ms(items[b - 1]!.end))) b--;
  return items.slice(0, b);
}

function taskIndex(files: readonly TaskFile[]): Map<string, Task> {
  const m = new Map<string, Task>();
  for (const f of files) for (const t of f.tasks) if (!m.has(t.uid)) m.set(t.uid, t);
  return m;
}

function diff(before: PlanItem[], after: PlanItem[]) {
  const old = new Map(before.map((it) => [it.key, it]));
  const now = new Set(after.map((it) => it.key));
  const moved: PlanItem[] = [];
  const added: PlanItem[] = [];
  for (const it of after) {
    const o = old.get(it.key);
    if (!o) added.push(it);
    else if (JSON.stringify(o) !== JSON.stringify(it)) moved.push(it);
  }
  const removedKeys = before.filter((it) => !now.has(it.key)).map((it) => it.key);
  return { moved, added, removedKeys };
}

function datesFrom(from: string, to: string): string[] {
  const n = daysBetween(from, to);
  return Array.from({ length: Math.max(0, n + 1) }, (_, i) => addDays(from, i));
}

/**
 * Close every gap between consecutive items of a shifted day with rest time, so the timeline has no
 * holes: the rest next to the gap is stretched (the one after it first); two tasks get a new short rest.
 */
function closeGaps(items: PlanItem[], date: string, tz: string): PlanItem[] {
  const out = items.map((it) => ({ ...it }));
  let restN = Math.max(0, ...out.filter((i) => i.kind === "rest").map((i) => Number(i.key.split("|")[2]) || 0));
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1]!;
    const next = out[i]!;
    if (ms(next.start) <= ms(prev.end)) continue;
    if (next.kind === "rest") next.start = prev.end;
    else if (prev.kind === "rest") prev.end = next.start;
    else {
      const rest: PlanItem = { key: `${date}|rest|${++restN}`, date, kind: "rest", start: prev.end, end: next.start, title: "Rest", restKind: "short", status: "pending" };
      out.splice(i, 0, rest);
    }
  }
  // Re-render through the zone so stretched boundaries keep the canonical ISO form.
  return out.map((it) => ({ ...it, start: toIso(ms(it.start), tz), end: toIso(ms(it.end), tz) }));
}

/**
 * Shift the plan later. Pure: returns the new plan and the changes the caller must store.
 * - minutes/hours/ms: today's items starting at or after `now` move later; an in-progress item keeps its
 *   times and the gap after it becomes rest time. Items whose new start is at/after local midnight leave
 *   today: one-off tasks become carry-in for the next day with work, which is regenerated from
 *   `dayStart` along with the days after it; daily items are returned in `dropped`.
 * - days: today keeps its past and in-progress items (an in-progress rest too). All remaining work
 *   moves N days later than where it is now: the plan is regenerated from (the first date with
 *   remaining work) + N at `dayStart`, today's remaining tasks first. Days off stay off.
 *
 * Minutes are never re-derived: the minutes of the items that STAY are projected into `progress`
 * (`projectedProgress`), so what moves is exactly what is left. A daily session that a shift takes
 * off the plan is simply no longer held, and `occurrences` counts sessions, so it comes back at the
 * end of the plan with no counter to maintain.
 *
 * `unit: "ms"` is the same code path as a minute shift with an exact delta: the gap-to-rest rule,
 * midnight overflow, `offUntil`, `dropped` daily items and every day invariant behave identically. It
 * is what pause/resume uses (docs/PLAN.md, P8), and the delta is never rounded to a minute.
 */
export function shiftPlan(input: ShiftInput): ShiftResult {
  const nowMs = validate(input.amount, input.unit, input.now);
  const cfg = resolveConfig(input.config);
  const tz = cfg.timeZone;
  const today = localDate(nowMs, tz);
  const tasks = taskIndex(input.files);
  const isDaily = (uid: string) => tasks.get(uid)?.repeat === "daily";
  const plan = input.plan.filter((d) => d.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1));
  const lastDate = plan.at(-1)?.date ?? today;
  const horizonEnd = input.days ? addDays(today, input.days - 1) : lastDate;
  let end = horizonEnd < lastDate ? lastDate : horizonEnd;
  const before = plan.flatMap((d) => d.items);
  const todayItems = plan.find((d) => d.date === today)?.items ?? [];
  const future = plan.filter((d) => d.date > today).flatMap((d) => d.items);
  const hasTask = (items: PlanItem[]) => items.some((i) => i.kind === "task");
  const firstFutureWork = plan.find((d) => d.date > today && hasTask(d.items))?.date;
  const daily = (it: PlanItem) => it.kind === "task" && isDaily(it.taskUid ?? "");

  let kept: PlanItem[];
  let leaving: PlanItem[];
  if (input.unit !== "days") {
    // `ms` is taken verbatim, so the elapsed time of a pause is applied to the millisecond (P8 rule 1).
    const delta = input.unit === "ms" ? input.amount : input.amount * (input.unit === "hours" ? 60 : 1) * MIN;
    const midnight = zonedMs(addDays(today, 1), 0, tz);
    kept = [];
    leaving = [];
    for (const it of todayItems) {
      const s = ms(it.start);
      if (s < nowMs) kept.push(it);
      else if (s + delta >= midnight) leaving.push(it);
      else kept.push({ ...it, start: toIso(s + delta, tz), end: toIso(ms(it.end) + delta, tz) });
    }
    kept = closeGaps(trimTrailingRests(kept, nowMs), today, tz);
  } else {
    kept = trimTrailingRests(todayItems.filter((it) => ms(it.start) < nowMs), nowMs);
    leaving = todayItems.filter((it) => ms(it.start) >= nowMs);
  }
  const dropped = leaving.filter(daily);

  // Where regeneration starts. Minutes/hours: the next day with work, only if something must move there.
  // Days: every remaining piece of work moves N days later than where it is now.
  let from: string;
  if (input.unit === "days") {
    from = addDays(hasTask(leaving) ? today : (firstFutureWork ?? addDays(today, 1)), input.amount);
    end = addDays(end, input.amount);
  } else from = firstFutureWork ?? addDays(today, 1);
  // Days off that already exist stay off.
  if (input.offUntil && input.offUntil >= from) from = addDays(input.offUntil, 1);

  // A dropped session of a task with `occurrences` is one fewer session held, so the plan after
  // `from` must be rebuilt for it to come back at the end.
  const lostSession = dropped.some((it) => tasks.get(it.taskUid!)?.occurrences !== undefined && !kept.some((k) => k.taskUid === it.taskUid));
  const regenerate = input.unit === "days" || lostSession || leaving.some((it) => it.kind === "task" && !daily(it));
  if (regenerate && end < from) end = from;

  const byDate = new Map<string, PlanItem[]>([[today, kept]]);
  let regeneratedDates: string[] = [];
  let carryIn: string[] = [];
  if (regenerate) {
    // Sessions held before `from`: the dates the caller knows about, plus the dates the shifted plan
    // still holds before `from` (never the same date twice).
    const sessionsHeld = new Map<string, number>();
    for (const t of tasks.values()) {
      if (t.repeat !== "daily" || t.occurrences === undefined) continue;
      const known = new Set(input.heldDates?.get(t.uid) ?? []);
      let n = 0;
      for (const d of known) if (d < from) n++;
      for (const [date, items] of byDate) if (date < from && !known.has(date) && items.some((i) => i.taskUid === t.uid)) n++;
      sessionsHeld.set(t.uid, n);
    }
    const progress = projectedProgress(input.progress, kept, isDaily);
    // Ordering for the prep slot: continuations first, then what was due earliest. A uid that has
    // nothing left is dropped by the generator, so this list may name more than it moves.
    const seen = new Set<string>();
    for (const uid of carryInFor(progress, kept, (u) => tasks.get(u)?.durationMin, isDaily)) if (!seen.has(uid)) seen.add(uid), carryIn.push(uid);
    for (const it of leaving)
      if (it.kind === "task" && it.taskUid && it.status === "pending" && !isDaily(it.taskUid) && !seen.has(it.taskUid))
        seen.add(it.taskUid), carryIn.push(it.taskUid);
    const gen = generatePlan({
      files: input.files,
      from,
      days: daysBetween(from, end) + 1,
      anchor: input.anchor,
      config: cfg,
      status: input.status,
      progress,
      sessionsHeld,
      carryIn,
      assumeDone: input.assumeDone,
    });
    for (const d of gen) byDate.set(d.date, d.items);
    regeneratedDates = gen.map((d) => d.date);
  } else for (const d of plan) if (d.date > today) byDate.set(d.date, d.items);

  const days = datesFrom(today, end).map((date) => ({ date, items: byDate.get(date) ?? [] }));
  const { moved, added, removedKeys } = diff(before, days.flatMap((d) => d.items));
  return { today, days, moved, added, removedKeys, regeneratedDates, carryIn, dropped };
}
