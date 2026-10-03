/**
 * Plan orchestration on top of the store: materialization, midnight rollover, status changes and
 * shifts, following docs/PLAN.md "Derived rules". Used by the API; the daemon reuses
 * `ensureCurrent()` for the rollover. HTTP-agnostic: failures throw PlannerError with a code.
 *
 * Each stored day is a timeline (`items`) plus a `checked` list: done/skipped items that lost their
 * timeline slot (see closed.ts). A pending item is never off the timeline.
 */
import {
  DEFAULT_ACTIVE_HOURS,
  MAX_SHIFT_MS,
  SLOT_RANK,
  checkActiveHours,
  addDays,
  carryInFor,
  checkShiftAmount,
  daysBetween,
  generatePlan,
  localDate,
  loadTaskFiles,
  partTitle,
  projectedProgress,
  resolveConfig,
  TASK_TYPES,
  zonedMs,
  shiftPlan,
  ShiftError,
  statusKey,
  toIso,
  type FirstDay,
  type GenerateInput,
  type ItemStatus,
  type ParseIssue,
  type PlanDay,
  type PlanItem,
  type ActiveHours,
  type ScheduleConfig,
  type ShiftAmountUnit,
  type ShiftUnit,
  type Task,
  type TaskFile,
  type TaskProgress,
} from "@planner/core";
import type { Clock } from "./clock.ts";
import { ITEM_STATUSES, type PlannerStore, type StoredDay } from "./db.ts";
import { REPO_ROOT } from "./paths.ts";
import { byStart, toChecked, withPlanned, type StoredItem } from "./closed.ts";

export type PlannerErrorCode = "INVALID_INPUT" | "UNKNOWN_TASK" | "UNKNOWN_ITEM" | "CONFLICT" | "PAUSED" | "TASK_FILE_ERRORS";

export class PlannerError extends Error {
  constructor(
    readonly code: PlannerErrorCode,
    message: string,
    readonly hint: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PlannerError";
  }
}

const META_PLAN_TO = "plan_to";
/** Last day off created by a days-shift; regeneration of later days never refills days up to it. */
const META_OFF_UNTIL = "off_until";
/** `${date}|${iso}`: after a minute/hour shift, new work that day never starts before this. */
const META_RESUME_AT = "resume_at";
/** The owner's active hours, as JSON. Absent = the defaults (08:00, 24:00, 480). */
const META_ACTIVE_HOURS = "active_hours";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN = 60_000;

export const isDate = (s: unknown): s is string => typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const minutesOf = (it: PlanItem) => (Date.parse(it.end) - Date.parse(it.start)) / MIN;
const enc = encodeURIComponent;

/** Levenshtein distance (case-insensitive). */
export function editDistance(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

export function closest(input: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(input, c);
    if (d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

export interface LoadedTasks {
  files: TaskFile[];
  tasks: Task[];
  errors: ParseIssue[];
  skipped: string[];
}

/** Load resources/**\/*.md (paths relative to the repo root). */
export function loadResources(dir: string, base = REPO_ROOT): LoadedTasks {
  return loadTaskFiles([dir], base);
}

export interface PlanServiceOptions {
  store: PlannerStore;
  clock: Clock;
  timeZone: string;
  /** Horizon in days (default 7). */
  horizon?: number;
  files: TaskFile[];
}

export interface ShiftSummary {
  moved: number;
  carried: number;
  /** Pending daily items pushed past midnight (not carried; tomorrow has its own instance). */
  dropped: number;
  regenerated: string[];
  endOfDay: string | null;
  /** Today after the shift. */
  day: StoredDay;
}

/**
 * The pause (docs/PLAN.md, P8), as `GET /health` and `GET /today` report it. `since` carries
 * milliseconds, and `elapsedSec` is seconds with a fractional part, measured when it is read.
 */
export interface PausedView {
  since: string;
  elapsedSec: number;
}

export interface PauseResult {
  paused: { since: string };
}

/** `pausedSec` is the exact elapsed time in seconds, with a fractional part (45.317). */
export interface ResumeResult {
  pausedSec: number;
  moved: number;
  endOfDay: string | null;
  day: StoredDay;
}

export interface TodayView {
  date: string;
  now: string;
  day: StoredDay;
  current: PlanItem | null;
  next: PlanItem | null;
  /** The pending task item in progress (null when idle, on a rest, or when the current item is checked). */
  currentTask: PlanItem | null;
  /** The first pending task item that starts after now. */
  nextTask: PlanItem | null;
  progress: { done: number; total: number; taskMinDone: number; taskMinTotal: number; checkedMin: number };
  upcoming: { date: string; firstTitle: string } | null;
  /** The pause, or null when the plan is running (P8). */
  paused: PausedView | null;
}

/**
 * A task as the API returns it. `progress` is the durable P7 state: `remainingMin = durationMin -
 * doneMin` for a one-off task (it is scheduled iff `status` is pending and this is > 0), and
 * `sessionsHeld` for a daily one (sessions held count toward `occurrences`).
 */
export type TaskView = Task & {
  status: ItemStatus;
  scheduledOn: string[];
  progress: { doneMin: number; partsDone: number; remainingMin: number; sessionsHeld?: number };
};

export class PlanService {
  readonly store: PlannerStore;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly horizon: number;
  private _files: TaskFile[] = [];
  private byUid = new Map<string, Task>();

  constructor(opts: PlanServiceOptions) {
    this.store = opts.store;
    this.clock = opts.clock;
    this.timeZone = opts.timeZone;
    this.horizon = opts.horizon ?? 7;
    if (!Number.isInteger(this.horizon) || this.horizon < 1 || this.horizon > 366) throw new RangeError(`horizon must be 1..366 days, got ${this.horizon}`);
    this.setFiles(opts.files);
    this.store.transaction(() => {
      this.store.setTimeZone(this.timeZone);
      this.store.setHorizon(this.horizon);
    });
  }

  // ------------------------------------------------------------------ basics

  get files(): readonly TaskFile[] {
    return this._files;
  }
  get tasks(): Task[] {
    return [...this.byUid.values()];
  }
  task(uid: string): Task | undefined {
    return this.byUid.get(uid);
  }
  setFiles(files: TaskFile[]): void {
    this._files = files;
    this.byUid = new Map();
    for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) for (const t of f.tasks) if (!this.byUid.has(t.uid)) this.byUid.set(t.uid, t);
  }

  // ----------------------------------------------------------- active hours

  /**
   * The owner's active hours: when a day may start, when it must stop, and how much task time it
   * holds. Stored in `meta`, so both processes see the same answer and it survives a restart.
   *
   * **The one place the scheduler's config comes from.** Every call that builds a `ScheduleConfig`
   * goes through `config()` below, so the API, the daemon, the shift and the regeneration cannot
   * disagree about when the day runs - which would show up as items at impossible times rather than
   * as an error.
   */
  activeHours(): ActiveHours {
    // Read live, never cached: the daemon and the API each hold their own PlanService, and a cache
    // here would let one of them keep planning with hours the other has already changed.
    const raw = this.store.getMeta(META_ACTIVE_HOURS);
    let parsed: Partial<ActiveHours> = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Partial<ActiveHours>;
      } catch {
        // Unreadable settings must not take the planner down; the defaults are always valid.
        parsed = {};
      }
    }
    const hours = { ...DEFAULT_ACTIVE_HOURS, ...parsed };
    try {
      checkActiveHours(hours);
    } catch {
      // Stored values that no longer validate (a hand-edited row, a downgrade) fall back rather
      // than making every read throw. `PATCH /settings` is the way to fix them.
      return { ...DEFAULT_ACTIVE_HOURS };
    }
    return hours;
  }

  /**
   * Validate and store the active hours. Returns the new value and whether anything changed, so the
   * caller can skip a pointless regeneration. Throws `INVALID_INPUT` for a window that cannot work.
   */
  /**
   * The active hours a patch would produce, validated and nothing stored. A UI can call this to
   * check a window before committing to it, and `setActiveHours` uses it so the two can never
   * disagree about what is allowed.
   */
  validateActiveHours(patch: Partial<ActiveHours>): ActiveHours {
    const known = Object.keys(DEFAULT_ACTIVE_HOURS);
    for (const k of Object.keys(patch))
      if (!known.includes(k))
        throw new PlannerError("INVALID_INPUT", `unknown setting "${k}"`, `Active hours are ${known.join(", ")}. Nothing was changed.`);
    const next: ActiveHours = { ...this.activeHours(), ...patch };
    // A number arriving as a string from a form or a query is the one coercion worth doing.
    if (typeof next.dailyTaskMin === "string" && /^\d+$/.test(next.dailyTaskMin)) next.dailyTaskMin = Number(next.dailyTaskMin);
    for (const k of ["dayStart", "dayEnd"] as const)
      if (typeof next[k] !== "string") throw new PlannerError("INVALID_INPUT", `${k} must be a string "HH:MM"; got ${JSON.stringify(next[k])}`, 'For example "08:00".');
    try {
      checkActiveHours(next);
    } catch (e) {
      throw new PlannerError(
        "INVALID_INPUT",
        (e as Error).message,
        'dayStart and dayEnd are "HH:MM" (dayEnd may be "24:00"), dayEnd must be after dayStart, and dailyTaskMin is whole minutes of task time. Nothing was changed.',
      );
    }
    return next;
  }

  /** Validate and store the active hours. `changed` is false when the patch asks for what is already set. */
  setActiveHours(patch: Partial<ActiveHours>): { hours: ActiveHours; changed: boolean } {
    const current = this.activeHours();
    const next = this.validateActiveHours(patch);
    const changed = next.dayStart !== current.dayStart || next.dayEnd !== current.dayEnd || next.dailyTaskMin !== current.dailyTaskMin;
    if (changed) this.store.setSetting(META_ACTIVE_HOURS, JSON.stringify(next));
    return { hours: next, changed };
  }

  /** The scheduler config for every call: the planner's zone plus the owner's active hours. */
  config(): Partial<ScheduleConfig> {
    return { timeZone: this.timeZone, ...this.activeHours() };
  }

  nowMs(): number {
    return this.clock.now();
  }
  nowIso(): string {
    return toIso(this.clock.now(), this.timeZone);
  }
  today(): string {
    return localDate(this.clock.now(), this.timeZone);
  }
  anchor(): string {
    return this.store.getAnchor() ?? this.today();
  }
  /** Last materialized date (at least today + horizon - 1). */
  horizonEnd(): string {
    const target = addDays(this.today(), this.horizon - 1);
    const to = this.store.getMeta(META_PLAN_TO);
    return to && to > target ? to : target;
  }
  dayStartMs(date: string): number {
    const [h, m] = resolveConfig(this.config()).dayStart.split(":").map(Number);
    return zonedMs(date, h! * 60 + m!, this.timeZone);
  }
  private statusOf(key: string): ItemStatus {
    return this.store.getStatus(key)?.status ?? "pending";
  }
  private isDaily(uid: string | undefined): boolean {
    return !!uid && this.byUid.get(uid)?.repeat === "daily";
  }
  /** Status key of the task an item stands for (daily tasks: per date). */
  private keyOf(it: PlanItem): string {
    return statusKey(it.taskUid!, this.isDaily(it.taskUid) ? it.date : undefined);
  }
  /** Last day off after a days-shift, if it is still today or later. */
  offUntil(): string | undefined {
    const v = this.store.getMeta(META_OFF_UNTIL);
    return v && v >= this.today() ? v : undefined;
  }

  // ------------------------------------------------------------------ pause (P8)

  /** The pause instant in epoch ms, or undefined. Durable: it survives a restart of either process. */
  pausedSinceMs(): number | undefined {
    return this.store.pausedSince();
  }

  /** The pause as the API reports it, measured now, or null when the plan is running. */
  paused(): PausedView | null {
    const since = this.store.pausedSince();
    if (since === undefined) return null;
    return { since: toIso(since, this.timeZone), elapsedSec: Math.max(0, this.nowMs() - since) / 1000 };
  }

  /**
   * A pause the exact path can no longer apply (longer than 24 h). It keeps being reported, but it no
   * longer freezes the plan: otherwise the owner could neither resume (400, rule 7) nor shift (409,
   * rule 4) and would be stuck. The day shift rule 7 points at is then allowed, and it clears the pause.
   */
  private pauseIsStale(): boolean {
    return this.store.pausedSince() !== undefined && this.livePausedSince() === undefined;
  }

  /**
   * The pause instant while the pause is still live, straight from the store's single definition
   * (`freshPausedSince`), which the daemon's scanner reads too. Nothing here may re-derive the rule.
   */
  private livePausedSince(): number | undefined {
    return this.store.freshPausedSince(this.nowMs());
  }

  /** Throw `409 PAUSED` when the plan is frozen (P8 rule 4). Callers validate the request first. */
  private refuseIfPaused(action: string): void {
    if (this.livePausedSince() === undefined) return;
    const p = this.paused()!;
    throw new PlannerError(
      "PAUSED",
      `the plan is paused since ${p.since} (${p.elapsedSec.toFixed(3)} s ago), so ${action} is refused`,
      "Nothing on the plan moves while it is paused. POST /plan/resume first - it shifts the plan forward by exactly the time the pause ran - then try again.",
      { paused: p },
    );
  }

  /** Freeze the plan at this instant. Nothing on the plan moves. */
  pause(): PauseResult {
    const existing = this.paused();
    if (existing)
      throw new PlannerError("CONFLICT", `the plan is already paused since ${existing.since}`, "POST /plan/resume shifts the plan by the elapsed time and clears the pause.", {
        paused: existing,
      });
    this.ensureCurrent();
    const now = this.nowMs();
    this.store.setPausedSince(now);
    return { paused: { since: toIso(now, this.timeZone) } };
  }

  /**
   * Measure `now - since` in milliseconds, shift the plan forward by exactly that, and clear the pause
   * in the same transaction as the shift. A pause longer than 24 h is `400 INVALID_INPUT` and is KEPT.
   */
  resume(): ResumeResult {
    const since = this.store.pausedSince();
    if (since === undefined)
      throw new PlannerError("CONFLICT", "the plan is not paused, so there is nothing to resume", "POST /plan/pause freezes the plan; GET /health and GET /today report the pause.", {
        paused: null,
      });
    const now = this.nowMs();
    const elapsedMs = now - since;
    if (elapsedMs > MAX_SHIFT_MS) {
      const days = Math.max(1, Math.round(elapsedMs / 86_400_000));
      throw new PlannerError(
        "INVALID_INPUT",
        `the pause has run for ${(elapsedMs / 3_600_000).toFixed(1)} h, which is longer than the 24 h a resume may move the plan`,
        `Shift whole days instead ({ "amount": ${days}, "unit": "days" }); that clears the pause. The pause is kept until then, so nothing is lost.`,
        { paused: this.paused() },
      );
    }
    // The cut point is the PAUSE instant, not this moment (P8 rule 2): nothing that had not begun when
    // the owner paused is allowed to run while they are away, so a task that was due to start during
    // the pause moves by the whole pause instead of being treated as already under way. Only the one
    // item in progress AT THE PAUSE INSTANT keeps its times, which is what keeps every duration intact.
    // The delta stays the exact elapsed milliseconds, so cut and delta are independent.
    this.ensureCurrent(); // settle the rollover first, so `today` below is the day the cut must land in
    // A pause that crossed local midnight is cut at midnight: the cut has to be inside today, and
    // every item of the new day was still to come when the owner paused anyway.
    const cut = Math.max(since, zonedMs(this.today(), 0, this.timeZone));
    const r = this.applyShift(elapsedMs, "ms", { noopOk: true, cutMs: cut, onCommit: () => this.store.clearPausedSince() });
    return { pausedSec: Math.max(0, elapsedMs) / 1000, moved: r.moved, endOfDay: r.endOfDay, day: r.day };
  }

  // ------------------------------------------------------------------ generation

  /** Durable progress of one task (P7): `remaining = durationMin - doneMin`. */
  progressOf(uid: string): TaskProgress {
    return this.store.getTaskProgress(uid);
  }
  /** Minutes of this task still to place. A one-off task is scheduled iff pending and this is > 0. */
  remainingOf(uid: string): number {
    const t = this.byUid.get(uid);
    return t && t.repeat !== "daily" ? t.durationMin - this.progressOf(uid).doneMin : 0;
  }

  /**
   * A session of a daily task is held on a date that ran: it is in the past (whatever its status), or
   * its status closed it (done **or** skipped - a skipped session was still that date's session).
   * Recorded durably, so no later shift or rebuild can lose it or hand out a second one.
   */
  private harvestSessions(): void {
    const today = this.today();
    for (const t of this.byUid.values()) {
      if (t.repeat !== "daily") continue;
      for (const i of this.store.itemsForTask(t.uid)) if (i.date < today || i.status !== "pending") this.store.holdSession(t.uid, i.date);
    }
  }

  /**
   * History is immutable, and it holds only what happened: a pending item before today never happened.
   * It is deleted, and a one-off task's minutes are re-placed with fresh part numbers (P7). A daily
   * slot goes too - `harvestSessions` runs first, so its session is already recorded and cannot be
   * handed out twice.
   */
  private purgePast(): void {
    this.store.deletePendingBefore(this.today());
  }

  /** Sessions held before `from`: a recorded date, or a date the stored plan holds one on. */
  private sessionsHeldFor(from: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const t of this.byUid.values()) {
      if (t.repeat !== "daily" || t.occurrences === undefined) continue;
      const dates = new Set(this.store.heldSessionDates(t.uid).filter((d) => d < from));
      for (const i of this.store.itemsForTask(t.uid)) if (i.date < from) dates.add(i.date);
      out.set(t.uid, dates.size);
    }
    return out;
  }

  /**
   * Per daily task: every date whose session is held outside the timeline (a recorded row or a checked
   * item). `shiftPlan` adds the dates its own timeline still holds, so no date is counted twice.
   */
  private heldDates(): Map<string, string[]> {
    const rows = this.store.allHeldSessions();
    const out = new Map<string, string[]>();
    for (const t of this.byUid.values()) {
      if (t.repeat !== "daily") continue;
      const dates = new Set(rows.get(t.uid) ?? []);
      for (const i of this.store.itemsForTask(t.uid, "checked")) dates.add(i.date);
      out.set(t.uid, [...dates].sort());
    }
    return out;
  }

  /** Items the rebuild keeps: everything stored from today up to (not including) `from`, plus `extra`. */
  private keptBefore(from: string, extra: readonly PlanItem[] = []): PlanItem[] {
    const today = this.today();
    const stored = from > today ? this.store.getItemsBetween(today, addDays(from, -1), "timeline") : [];
    return [...stored, ...extra];
  }

  /**
   * Everything the generator needs, straight from the store: `task_progress` and `sessions_held`.
   * The minutes of the kept window are projected in (`projectedProgress`) so nothing is placed twice,
   * and `carryIn` only says which tasks continue first.
   */
  private genInput(from: string, to: string, opts: { kept?: readonly PlanItem[]; assumeDone?: string[]; firstDay?: FirstDay } = {}): GenerateInput {
    const kept = opts.kept ?? this.keptBefore(from);
    const progress = projectedProgress(this.store.getProgress(), kept, (u) => this.isDaily(u));
    return {
      files: this._files,
      from,
      days: daysBetween(from, to) + 1,
      anchor: this.anchor(),
      config: this.config(),
      status: this.store.statusLookup(),
      progress,
      sessionsHeld: this.sessionsHeldFor(from),
      carryIn: carryInFor(progress, kept, (u) => this.byUid.get(u)?.durationMin, (u) => this.isDaily(u)),
      ...(opts.assumeDone ? { assumeDone: opts.assumeDone } : {}),
      ...(opts.firstDay ? { firstDay: opts.firstDay } : {}),
    };
  }

  private generate(from: string, to: string): PlanDay[] {
    return generatePlan(this.genInput(from, to));
  }

  /**
   * Checked items stored on dates >= `from` that the new timeline no longer holds (same key) go to
   * their date's `checked` list, so a regeneration never deletes a checked item.
   */
  private withChecked(from: string, days: PlanDay[]): StoredDay[] {
    const out = new Map<string, StoredDay>(days.map((d) => [d.date, { date: d.date, items: [...d.items], checked: [] }]));
    const keys = new Set(days.flatMap((d) => d.items.map((i) => i.key)));
    const lost = (placed: boolean) =>
      this.store
        .getItemsBetween(from, "9999-12-31", placed ? "timeline" : "checked")
        .filter((i) => i.kind === "task" && i.status !== "pending" && !keys.has(i.key))
        .map((i) => toChecked(i, placed));
    for (const c of [...lost(true), ...lost(false)]) {
      const day = out.get(c.date) ?? { date: c.date, items: [], checked: [] };
      day.checked.push(c);
      out.set(c.date, day);
    }
    return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  /** Rebuild and store every date from `from` through `to` (default: horizon end). Returns the dates. */
  regenerateFrom(from: string, to = this.horizonEnd()): string[] {
    if (to < from) return [];
    return this.store.transaction(() => {
      this.harvestSessions();
      this.purgePast();
      const days = this.withChecked(from, this.generate(from, to));
      this.store.replaceFrom(from, days, { keepStatus: true });
      this.store.setMeta(META_PLAN_TO, to);
      this.renumber(days.flatMap((d) => [...d.items, ...d.checked].flatMap((i) => (i.kind === "task" && i.taskUid ? [i.taskUid] : []))));
      return days.filter((d) => d.date <= to).map((d) => d.date);
    });
  }

  /**
   * P7: every status change and undo re-plans through this. `from` <= today rebuilds the rest of today
   * (see `regenerateToday`), a later date rebuilds from there. **It never clears a day off**: a rebuild
   * that would land on one starts after it instead. Only `POST /plan/regenerate` clears days off.
   */
  replan(from: string): string[] {
    const start = this.replanStart(from);
    return start === null ? this.regenerateToday() : this.regenerateFrom(start);
  }

  /**
   * Where `replan(from)` actually begins, or `null` when it rebuilds the rest of today. Reads
   * nothing but the days off, and writes nothing, so a caller can ask what a replan *would* touch
   * (P9 dry runs) without one place deriving the rule and another re-deriving it.
   */
  private replanStart(from: string): string | null {
    const today = this.today();
    const off = this.offUntil();
    if (from > today) return off && off >= from ? addDays(off, 1) : from;
    if (off && off >= today) return addDays(off, 1);
    return null;
  }

  /**
   * Re-derive what a task's already-placed items *show* - title (with the item's own part numbering),
   * links, type and track - from the task as the files now describe it. Times, keys, parts, status
   * and placement are untouched, so this is not a re-plan: it is how a rename reaches today's
   * calendar event without re-timing a day that is already under way (docs/PLAN.md, P9). Only today
   * and later are touched, because past items are history and the calendar window starts today.
   * Returns the dates whose items changed.
   */
  restyleTask(uid: string): string[] {
    const task = this.byUid.get(uid);
    if (!task) return [];
    const today = this.today();
    const dates = new Set<string>();
    this.store.transaction(() => {
      for (const it of this.store.itemsForTask(uid)) {
        if (it.date < today) continue;
        const title = it.part ? partTitle(task.title, it.part.index, it.part.total) : task.title;
        const links = task.links.map((l) => ({ ...l }));
        if (it.title === title && it.type === task.type && it.track === task.track && JSON.stringify(it.links ?? []) === JSON.stringify(links)) continue;
        if (this.store.patchItem(it.key, { title, links, type: task.type, track: task.track })) dates.add(it.date);
      }
    });
    return [...dates].sort();
  }

  /** Days after today, assuming today's still-pending items get done. Today is never touched. */
  regenerateFuture(): string[] {
    return this.replan(addDays(this.today(), 1));
  }

  /**
   * The dates `replan(from)` would rewrite, computed without touching the store. Used by the P9
   * dry runs, which have to report what a write would regenerate while writing nothing. For a
   * rebuild of today the answer is today through the horizon, because that is what the generator
   * may lay out again; for a future date it is exactly the dates `regenerateFrom` returns.
   */
  wouldReplan(from: string = addDays(this.today(), 1)): string[] {
    const start = this.replanStart(from) ?? this.today();
    const to = this.horizonEnd();
    if (to < start) return [];
    return Array.from({ length: daysBetween(start, to) + 1 }, (_, i) => addDays(start, i));
  }

  /**
   * Rebuild the rest of today from now (POST /plan/regenerate with from = today). Past and in-progress
   * items keep their times (a checked item still in progress ends now); checked items that had not
   * started leave the timeline. The core lays out the remaining work (firstDay) from the end of the
   * task in progress + its rest (or when the rest in progress ends, or now when idle), never before
   * 08:00 nor before the resume point of an earlier minute/hour shift, with the task minutes already
   * on today counting toward the 240/480 marks, and the same fill/no-fragment rules as any day.
   * What does not fit before midnight moves to the next days, which are regenerated.
   */
  private regenerateToday(): string[] {
    const today = this.today();
    this.store.transaction(() => {
      this.harvestSessions();
      this.purgePast();
    });
    const tz = this.timeZone;
    const cfg = resolveConfig(this.config());
    const now = this.nowMs();
    const nowMin = Math.ceil(now / MIN) * MIN;
    const dayStart = this.dayStartMs(today);
    const midnight = zonedMs(addDays(today, 1), 0, tz);
    const old = this.store.getDay(today);
    const kept: PlanItem[] = [];
    const leaving: StoredItem[] = [];
    for (const it of old.items) {
      if (Date.parse(it.start) < now) {
        const finishedEarly = it.kind === "task" && it.status !== "pending" && Date.parse(it.end) > now;
        kept.push(finishedEarly ? { ...withPlanned(it), end: toIso(Math.max(nowMin, Date.parse(it.start) + MIN), tz) } : it);
      } else if (it.kind === "task" && it.status !== "pending") leaving.push(toChecked(it, true));
    }
    const checked: StoredItem[] = [...old.checked, ...leaving];
    const spent = kept.filter((i) => i.kind === "task").reduce((n, i) => n + minutesOf(i), 0);

    // Where new work may start.
    let taskMin = spent;
    const needLong = () => taskMin > 0 && taskMin % cfg.blockMin === 0;
    const lastKept = [...kept].sort((a, b) => Date.parse(a.end) - Date.parse(b.end)).at(-1);
    let restFrom: number | undefined;
    let startAt: number;
    if (!lastKept) startAt = Math.max(nowMin, dayStart);
    else if (lastKept.kind === "rest") startAt = Math.max(nowMin, Date.parse(lastKept.end));
    else {
      // The rest after it starts when it ended, however late `now` is: the gap between two tasks is
      // rest time, never an unlabelled hole.
      const e = Date.parse(lastKept.end);
      restFrom = e;
      startAt = Math.max(nowMin, e + (needLong() ? cfg.longRestMin : cfg.shortRestMin) * MIN);
    }
    // Hard rule 6: the day's order never goes backwards. Once a fixed slot has run, the rest of the
    // day may only hold slots at or after it; capacity left over stays unused (the rule is "<= 480").
    const kindOf = new Map(this._files.map((f) => [f.meta.track, f.meta.kind]));
    const lastTask = kept.filter((i) => i.kind === "task").sort((a, b) => Date.parse(a.end) - Date.parse(b.end)).at(-1);
    const minSlotRank = lastTask ? SLOT_RANK[kindOf.get(lastTask.track ?? "") ?? "prep"] : 0;
    const resume = this.store.getMeta(META_RESUME_AT)?.split("|");
    if (resume?.[0] === today && resume[1]) startAt = Math.max(startAt, Date.parse(resume[1]));
    startAt = Math.max(startAt, dayStart);

    // What is already on today counts as placed (projected through `progress`), and the daily sessions
    // it holds are treated as held, so nothing is laid out twice.
    const placedToday = [...kept.filter((i) => i.kind === "task"), ...checked];
    const dailyToday = [...new Set(placedToday.filter((i) => this.isDaily(i.taskUid)).map((i) => statusKey(i.taskUid!, today)))];
    // The whole horizon is generated in one call, so the days after today see today's new layout and
    // the session count covers every date (a closed session on a later date is reserved, not re-placed).
    const end = this.horizonEnd();
    let gen: PlanDay[] = [];
    let items: PlanItem[] = [];
    // The day's end is the core's business now: `dayEnd` (the owner's active hours, at most 24:00)
    // is enforced for every day inside `generatePlan`, so the loop that used to live here - generate,
    // see if it ran past midnight, lower the cap, retry - would be the same rule written twice.
    const firstDay: FirstDay = { startAt, taskMinSpent: spent, minSlotRank };
    gen = generatePlan(this.genInput(today, end, { kept: placedToday, assumeDone: dailyToday, firstDay }));
    items = gen[0]!.items;
    if (startAt >= midnight) items = [];

    // The rest between the last kept task and the new work spans the whole gap, whatever moved
    // `startAt` later (an earlier minute/hour shift's resume point): a shift never leaves a hole.
    const added: PlanItem[] = [];
    const first = items.find((i) => i.kind === "task");
    if (restFrom !== undefined && first) {
      const long = needLong();
      const nominal = (long ? cfg.longRestMin : cfg.shortRestMin) * MIN;
      const end = Math.max(restFrom + nominal, Date.parse(first.start));
      // Its kind and its place after 240 task minutes do not change, but a rest that covers hours is
      // not the 10-minute rest and must not read like one.
      const stretched = end > restFrom + nominal;
      added.push({
        key: `${today}|rest|0`,
        date: today,
        kind: "rest",
        start: toIso(restFrom, tz),
        end: toIso(end, tz),
        title: (long ? "Long rest" : "Rest") + (stretched ? " (extended)" : ""),
        restKind: long ? "long" : "short",
        status: "pending",
      });
    }
    let n = 0;
    const merged = [...kept, ...added, ...items].sort(byStart);
    // Never end the day with a rest that has nothing after it.
    while (merged.length && merged.at(-1)!.kind === "rest") merged.pop();
    const timeline = merged.map((i) => (i.kind === "rest" ? { ...i, key: `${today}|rest|${++n}` } : i));
    return this.store.transaction(() => {
      const days = this.withChecked(today, [{ date: today, items: timeline }, ...gen.slice(1)]);
      this.store.replaceFrom(today, days, { keepStatus: true });
      this.store.setMeta(META_PLAN_TO, end);
      this.renumber(days.flatMap((d) => [...d.items, ...d.checked].flatMap((i) => (i.kind === "task" && i.taskUid ? [i.taskUid] : []))));
      return days.filter((d) => d.date <= end).map((d) => d.date);
    });
  }

  /**
   * Recompute part {index,total} and "(part i/n)" titles of the given tasks.
   *
   * Part labels follow the timeline: the pieces of a task are numbered 1..n in the order they are
   * planned, over every stored item of it (a checked one included). Marking a later part done can pull
   * the remainder to an earlier date, and without this the remainder would keep the number the
   * generator gave it and read "part 2/2" above "part 1/2". A total the generator computed with parts
   * beyond the horizon is kept. Only the label moves; keys never do.
   */
  private renumber(uids: Iterable<string>): void {
    for (const uid of new Set(uids)) {
      const task = this.byUid.get(uid);
      if (!task) continue;
      const rows = this.store.itemsForTask(uid); // timeline + checked, chronological
      const groups = task.repeat === "daily" ? [...new Set(rows.map((i) => i.date))].map((d) => rows.filter((i) => i.date === d)) : [rows];
      for (const g of groups) {
        const total = Math.max(g.length, ...g.map((i) => i.part?.total ?? 1));
        g.forEach((it, i) => {
          const index = i + 1;
          const split = total > 1;
          const next: PlanItem = { ...it, title: split ? partTitle(task.title, index, total) : task.title };
          if (split) next.part = { index, total };
          else next.part = undefined; // explicit, so the merge in setItemStatus clears it
          if (JSON.stringify(next) !== JSON.stringify(it)) this.store.setItemStatus(it.key, it.status, next);
        });
      }
    }
  }

  /**
   * Explicit rebuild from `from` (POST /plan/regenerate). This is the ONE action that may clear days
   * off, and it reports the dates it cleared (P7). Every other path re-plans through `replan`.
   */
  regenerate(from: string): { regenerated: string[]; clearedDaysOff: string[] } {
    const today = this.today();
    if (!isDate(from)) throw new PlannerError("INVALID_INPUT", `from must be YYYY-MM-DD; got ${JSON.stringify(from)}`, `For example "${addDays(today, 1)}".`);
    if (from < today) throw new PlannerError("INVALID_INPUT", `from (${from}) is before today (${today})`, "Past days are history and are never rebuilt; use today or later.");
    const end = this.horizonEnd();
    if (from > end) throw new PlannerError("INVALID_INPUT", `from (${from}) is after the plan's last day (${end})`, `Use a date from ${today} to ${end}.`);
    // The request is valid first, then the plan's state: while paused the plan is frozen (P8 rule 4).
    this.refuseIfPaused("rebuilding the plan");
    const stalePause = this.pauseIsStale();
    this.ensureCurrent();
    return this.store.transaction(() => {
      if (stalePause) this.store.clearPausedSince();
      const off = this.offUntil();
      // A day off is a date the days-shift left without work to do. Today counts as one when nothing
      // is still ahead of `now` on it.
      const now = this.nowMs();
      const idle = (d: string) =>
        !this.store.getDay(d).items.some((i) => i.kind === "task" && i.status === "pending" && (d > today || Date.parse(i.start) >= now));
      const candidates: string[] = [];
      if (off && off >= from) {
        for (let d = from; d <= off; d = addDays(d, 1)) if (idle(d)) candidates.push(d);
        if (from > today) this.store.setMeta(META_OFF_UNTIL, addDays(from, -1));
        else this.store.deleteMeta(META_OFF_UNTIL);
      }
      const regenerated = from === today ? this.regenerateToday() : this.regenerateFrom(from, end);
      return { regenerated, clearedDaysOff: candidates.filter((d) => !idle(d)) };
    });
  }

  /**
   * Materialize the plan if needed: first start (sets the anchor), midnight rollover (the stored plan
   * was generated from an earlier day: regenerate from today with actual status, so unfinished work
   * comes back first), or a horizon that no longer reaches today + horizon - 1.
   * Safe to call from several processes. Returns the regenerated dates, or null if nothing changed.
   */
  ensureCurrent(): string[] | null {
    const check = () => {
      const today = this.today();
      const target = addDays(today, this.horizon - 1);
      const planFrom = this.store.getPlanFrom();
      const planTo = this.store.getMeta(META_PLAN_TO);
      if (!planFrom || planFrom < today || !planTo || planTo < today) return { from: today, today };
      if (planTo < target) return { from: addDays(planTo, 1), today };
      return null;
    };
    if (!check()) return null;
    return this.store.transaction(() => {
      const need = check(); // re-check under the write lock (the other process may have done it)
      if (!need) return null;
      if (!this.store.getAnchor()) this.store.setAnchor(need.today);
      const target = addDays(need.today, this.horizon - 1);
      const planTo = this.store.getMeta(META_PLAN_TO);
      let from = need.from;
      let end = target;
      if (from === need.today) {
        // Rollover: keep an extension made by a days-shift, and do not refill remaining days off.
        if (planTo && planTo > end) end = planTo;
        const off = this.offUntil();
        if (off) {
          const stale = this.store.getItemsBetween(need.today, off, "timeline").filter((i) => i.status === "pending");
          this.store.applyChanges({ remove: stale.map((i) => i.key) });
          from = addDays(off, 1);
          if (from > end) end = addDays(from, this.horizon - 1);
        }
      }
      const dates = this.regenerateFrom(from, end);
      this.store.setPlanFrom(need.today);
      return dates;
    });
  }

  /** Stored days, with dates past the materialized horizon projected (not stored). */
  range(from: string, days: number): StoredDay[] {
    this.ensureCurrent();
    const stored = this.store.getRange(from, days);
    const to = addDays(from, days - 1);
    const planTo = this.horizonEnd();
    if (to <= planTo) return stored;
    // Always project from the day after the stored plan, so no unstored date counts as a lost session.
    const projected = new Map(this.generate(addDays(planTo, 1), to).map((d) => [d.date, { ...d, checked: [] as PlanItem[] }]));
    return stored.map((d) => projected.get(d.date) ?? d);
  }

  // ------------------------------------------------------------------ status

  /** Resolve a key; a key whose date + uid match exactly one item of that task on that date also resolves. */
  private resolveItem(key: string): { item: PlanItem; placed: boolean } | undefined {
    const row = this.store.getItemRow(key);
    if (row) return row;
    const [date, uid] = key.split("|");
    if (!date || !uid || uid === "rest") return undefined;
    const same = this.store.itemsForTask(uid).filter((i) => i.date === date);
    return same.length === 1 ? this.store.getItemRow(same[0]!.key) : undefined;
  }

  private unknownItem(key: string): PlannerError {
    const parts = key.split("|");
    const [date, uid] = parts;
    const msg = `No plan item ${key}`;
    if (parts.length === 1) {
      if (this.byUid.has(key)) return new PlannerError("UNKNOWN_ITEM", msg, `"${key}" is a task uid, not an item key; use POST /tasks/${enc(key)}/status.`);
      const g = closest(key, this.byUid.keys());
      return new PlannerError("UNKNOWN_ITEM", msg, `Item keys look like YYYY-MM-DD|track/id|part (see GET /today).${g && key.includes("/") ? ` For a task uid, did you mean ${g}?` : ""}`);
    }
    if (uid === "rest") {
      const g = closest(key, this.store.getDay(date ?? "").items.filter((i) => i.kind === "rest").map((i) => i.key));
      return new PlannerError("UNKNOWN_ITEM", msg, g ? `Did you mean ${g}? (rests have no status)` : `There is no rest with this key on ${date}; see GET /plan?from=${date}&days=1.`);
    }
    if (uid && this.byUid.has(uid)) {
      const today = this.today();
      const end = this.horizonEnd();
      const on = [...new Set(this.store.itemsForTask(uid, "timeline").filter((i) => i.date >= today).map((i) => i.date))];
      const where = on.length ? ` It is on ${on.slice(0, 7).join(", ")}${on.length > 7 ? ", ..." : ""} (GET /tasks/${enc(uid)}).` : "";
      // A date the plan does not reach yet is not the same as a date the task is not scheduled on.
      if (date && date > end)
        return new PlannerError("UNKNOWN_ITEM", msg, `${date} is past the stored plan, which ends on ${end}; no item exists there yet.${where}`);
      if (date && date < today)
        return new PlannerError("UNKNOWN_ITEM", msg, `${date} is in the past and holds no item of ${uid}; history is never rebuilt.${where}`);
      return new PlannerError(
        "UNKNOWN_ITEM",
        msg,
        on.length ? `${uid} is not scheduled on ${date};${where.replace(" It is on", " it is on")}` : `${uid} is not in the stored horizon; use POST /tasks/${enc(uid)}/status.`,
      );
    }
    const g = uid ? closest(uid, this.byUid.keys()) : undefined;
    return new PlannerError("UNKNOWN_ITEM", msg, g ? `No task ${uid}; did you mean ${g}? (GET /tasks/${enc(g)} lists its items.)` : "See GET /today for item keys.");
  }

  unknownTask(uid: string): PlannerError {
    const guess = closest(uid, this.byUid.keys());
    return new PlannerError("UNKNOWN_TASK", `No task ${uid}`, guess ? `Did you mean ${guess}?` : "No tasks are loaded; check resources/ and POST /reload.");
  }

  private checkStatus(status: unknown): asserts status is ItemStatus {
    if (!ITEM_STATUSES.includes(status as ItemStatus))
      throw new PlannerError("INVALID_INPUT", `status must be one of ${ITEM_STATUSES.join(", ")}; got ${JSON.stringify(status)}`, 'Send { "status": "done" }.');
  }

  /**
   * Re-plan after items of `dates` went back to pending (undo). The task's remaining minutes just
   * grew, so the re-plan starts at the earliest day that may take them - the rest of today when the
   * change touches today or the past, otherwise tomorrow - never only from the item's own date, which
   * would leave the days before it holding the plan made while the task looked finished.
   * Days off stay off (P7 invariant 6).
   */
  private replanFrom(dates: string[]): string[] {
    const today = this.today();
    const first = [...dates].sort()[0];
    return this.replan(!first || first <= today ? today : addDays(today, 1));
  }

  /**
   * Status of the task an item stands for. A daily task changes for that date only. For a split task
   * only the last part changes the task status; earlier parts are marked on the item only.
   * Today is never reshuffled; days after today are regenerated, and a future item whose task is now
   * done/skipped moves to its day's `checked` list. Undo (pending) of a checked item removes it from
   * the list and re-plans the task: from now if it is today's, from its date otherwise.
   */
  setItemStatus(key: string, status: ItemStatus): { item: PlanItem | null; regenerated: string[]; replanned?: boolean } {
    this.checkStatus(status);
    this.ensureCurrent();
    const row = this.resolveItem(key);
    if (!row) throw this.unknownItem(key);
    const item = row.item;
    if (item.kind !== "task" || !item.taskUid)
      throw new PlannerError("CONFLICT", `${key} is a ${item.restKind === "long" ? "long " : ""}rest; rests have no status`, "Set the status of a task item instead.");
    const uid = item.taskUid;
    const off = this.offUntil();
    const past = item.date < this.today();
    // A date the owner pushed past holds no work to do, so an undo there must not put any back.
    const dayOff = !!off && item.date <= off;
    // Undo of an item that is off the timeline, of one on a past date, or of one on a day off: the item
    // never happened, so it is removed and the work re-planned after the days off. A past item's status
    // is NEVER rewritten - history is immutable.
    if (status === "pending" && (!row.placed || past || dayOff))
      return this.store.transaction(() => {
        this.itemProgress(item, "pending");
        this.store.applyChanges({ remove: [item.key] });
        this.store.setStatus(this.keyOf(item), "pending", this.nowIso());
        const regenerated = this.replanFrom([past ? this.today() : item.date]);
        const back =
          this.store.itemsForTask(uid, "timeline").find((i) => i.date === item.date && i.status === "pending") ??
          this.store.itemsForTask(uid, "timeline").find((i) => i.date >= this.today() && i.status === "pending") ??
          null;
        return { item: back, regenerated, replanned: true };
      });
    return this.store.transaction(() => {
      this.itemProgress(item, status);
      const updated = this.store.setItemStatus(item.key, status, withPlanned(item))!;
      if (status === "pending") this.store.setStatus(this.keyOf(item), "pending", this.nowIso());
      // P7: a task closes only when every minute of it is done. The part label never decides stored
      // state - it is recomputed from the timeline, and the last part carries only its own minutes.
      else if (status === "skipped" || this.remainingOf(uid) <= 0) this.store.setStatus(this.keyOf(item), status, this.nowIso());
      // The remaining minutes changed, so every later day must be re-planned.
      const regenerated = status === "pending" ? this.replanFrom([item.date]) : this.regenerateFuture();
      return { item: this.store.getItem(item.key) ?? updated, regenerated };
    });
  }

  /**
   * P7's transition table for one item, by delta: a part that becomes done adds its minutes and one
   * part; a part that stops being done takes them back. Daily tasks keep sessions, never minutes.
   */
  private itemProgress(item: PlanItem, next: ItemStatus): void {
    const uid = item.taskUid!;
    if (this.isDaily(uid)) {
      if (next === "done") this.store.holdSession(uid, item.date);
      else if (next === "pending") this.store.releaseSession(uid, item.date);
      return;
    }
    const task = this.byUid.get(uid);
    if (!task) return;
    const was = item.status;
    if (was === "done" && next !== "done") this.store.addTaskProgress(uid, -minutesOf(item), -1, task.durationMin);
    else if (was !== "done" && next === "done") this.store.addTaskProgress(uid, minutesOf(item), 1, task.durationMin);
  }

  /** Task-level status by uid (`date` required for daily tasks). Applies to the task's stored items. */
  setTaskStatus(uid: string, status: ItemStatus, date?: string): { task: TaskView; items: PlanItem[]; regenerated: string[] } {
    this.checkStatus(status);
    const task = this.byUid.get(uid);
    if (!task) throw this.unknownTask(uid);
    const daily = task.repeat === "daily";
    if (date !== undefined && !isDate(date)) throw new PlannerError("INVALID_INPUT", `date must be YYYY-MM-DD; got ${JSON.stringify(date)}`, `For example "${this.today()}".`);
    if (daily && !date)
      throw new PlannerError("INVALID_INPUT", `date is required: ${uid} repeats daily and its status is tracked per date`, `Send { "status": "${status}", "date": "${this.today()}" }.`);
    this.ensureCurrent();
    if (date !== undefined && !this.store.itemsForTask(uid).some((i) => i.date === date)) {
      const on = [...new Set(this.store.itemsForTask(uid, "timeline").filter((i) => i.date >= this.today()).map((i) => i.date))];
      throw new PlannerError(
        "CONFLICT",
        `${uid} has no item on ${date}`,
        (on.length ? `It is scheduled on ${on.slice(0, 7).join(", ")}${on.length > 7 ? ", ..." : ""}.` : "It is not scheduled on any upcoming day.") +
          (daily ? "" : ` ${uid} is a one-off task: omit "date".`),
      );
    }
    return this.store.transaction(() => {
      const today = this.today();
      this.store.setStatus(statusKey(uid, daily ? date : undefined), status, this.nowIso());
      const mine = (i: PlanItem) => !daily || i.date === date;
      const timeline = this.store.itemsForTask(uid, "timeline").filter(mine);
      const checked = this.store.itemsForTask(uid, "checked").filter(mine);
      // P7: the whole task is done (every minute of it) / skipped (no minutes) / untouched again.
      if (!daily) {
        if (status === "done") this.store.setTaskProgress(uid, { doneMin: task.durationMin, partsDone: Math.max(1, timeline.length + checked.length) });
        else if (status === "pending") this.store.clearTaskProgress(uid);
      } else if (date) {
        if (status === "done") this.store.holdSession(uid, date);
        else if (status === "pending") this.store.releaseSession(uid, date);
      }
      // A past item's status is never rewritten; an undone one is removed instead of going pending.
      for (const it of timeline)
        if (it.date >= today) this.store.setItemStatus(it.key, status, withPlanned(it));
        else if (status === "pending") this.store.applyChanges({ remove: [it.key] });
      let regenerated: string[];
      if (status === "pending") {
        if (checked.length) this.store.applyChanges({ remove: checked.map((i) => i.key) });
        regenerated = this.replanFrom([...timeline, ...checked].map((i) => (i.date < today ? today : i.date)));
      } else {
        for (const it of checked) this.store.setItemStatus(it.key, status);
        regenerated = this.regenerateFuture();
      }
      const after = this.store.itemsForTask(uid).filter((i) => mine(i) && i.date >= this.today());
      return { task: this.taskView(task, daily ? date : undefined), items: after, regenerated };
    });
  }

  // ------------------------------------------------------------------ shift

  shift(amount: unknown, unit: unknown, opts: { dryRun?: boolean } = {}): ShiftSummary {
    if (unit !== "minutes" && unit !== "hours" && unit !== "days")
      throw new PlannerError("INVALID_INPUT", `unit must be "minutes", "hours" or "days"; got ${JSON.stringify(unit)}`, 'Send { "amount": 30, "unit": "minutes" }.');
    if (typeof amount !== "number" || !Number.isFinite(amount))
      throw new PlannerError("INVALID_INPUT", `amount must be a finite positive whole number; got ${JSON.stringify(amount)}`, 'Send a whole number, e.g. { "amount": 30, "unit": "minutes" }.');
    // The answer to an invalid amount must not depend on what today still holds, so every check on
    // the request itself runs before `ensureCurrent` and before the "nothing left to shift" CONFLICT.
    try {
      checkShiftAmount(amount, unit);
    } catch (e) {
      if (e instanceof ShiftError) throw new PlannerError("INVALID_INPUT", e.message, e.hint);
      throw e;
    }
    const max = { minutes: 1440, hours: 24, days: 365 }[unit];
    if (amount > max)
      throw new PlannerError(
        "INVALID_INPUT",
        `amount must be at most ${max} ${unit}; got ${amount}`,
        unit === "days"
          ? "Shift by at most 365 days."
          : `A minute or hour shift only moves today; use { "amount": ${Math.max(1, Math.round(amount / (unit === "hours" ? 24 : 1440)))}, "unit": "days" } for whole days.`,
      );
    // The request is valid: now the plan's state may answer. While paused nothing moves (P8 rule 4),
    // and only then can `409 CONFLICT` mean "nothing left to shift".
    this.refuseIfPaused("shifting the plan");
    return this.applyShift(amount, unit as ShiftUnit, {
      ...opts,
      // A stale pause (> 24 h) no longer freezes the plan, and the day shift rule 7 asks for clears it.
      ...(this.pauseIsStale() ? { onCommit: () => this.store.clearPausedSince() } : {}),
    });
  }

  /**
   * The shift itself, with the request already validated. `noopOk` turns the "nothing left to shift"
   * `CONFLICT` into a no-op summary (a resume always succeeds), and `onCommit` runs inside the same
   * transaction as the shift, so clearing the pause is atomic with moving the plan.
   *
   * `cutMs` is the instant the shift is measured FROM - items starting at or after it move, the one in
   * progress keeps its times. It defaults to now, which is what a manual shift wants; a resume passes
   * the pause instant instead. It is independent of `amount`, the delta.
   */
  private applyShift(amount: number, unit: ShiftAmountUnit, opts: { dryRun?: boolean; noopOk?: boolean; cutMs?: number; onCommit?: () => void } = {}): ShiftSummary {
    this.ensureCurrent();
    this.store.transaction(() => {
      this.harvestSessions();
      this.purgePast();
    });
    const today = this.today();
    const end = this.horizonEnd();
    const cutMs = opts.cutMs ?? this.nowMs();
    const stored = this.store.getRange(today, daysBetween(today, end) + 1);
    const plan: PlanDay[] = stored.map((d) => ({ date: d.date, items: d.items }));
    const movable = unit === "days" ? plan.flatMap((d) => d.items) : (plan[0]?.items ?? []);
    if (amount <= 0 || !movable.some((it) => Date.parse(it.start) >= cutMs)) {
      if (!opts.noopOk)
        throw new PlannerError(
          "CONFLICT",
          unit === "days" ? "Nothing in the plan starts after now, so there is nothing to shift" : "Every item of today has already started or ended; there is nothing left to shift today",
          unit === "days" ? "POST /plan/regenerate rebuilds the plan from task files." : 'Shift by days instead ({ "amount": 1, "unit": "days" }), or mark items done.',
        );
      if (!opts.dryRun && opts.onCommit) this.store.transaction(opts.onCommit);
      const day = this.store.getDay(today);
      return { moved: 0, carried: 0, dropped: 0, regenerated: [], endOfDay: day.items.at(-1)?.end ?? null, day };
    }
    let r;
    try {
      r = shiftPlan({
        files: this._files,
        anchor: this.anchor(),
        plan,
        now: cutMs,
        amount,
        unit,
        config: this.config(),
        status: this.store.statusLookup(),
        days: daysBetween(today, end) + 1,
        progress: this.store.getProgress(),
        heldDates: this.heldDates(),
        ...(this.offUntil() ? { offUntil: this.offUntil() } : {}),
      });
    } catch (e) {
      if (e instanceof ShiftError) throw new PlannerError("INVALID_INPUT", e.message, e.hint);
      throw e;
    }
    // Checked items the shift took off the timeline (pushed past midnight, or their day was rebuilt)
    // go to their date's checked list with their original times.
    const newKeys = new Set(r.days.flatMap((d) => d.items.map((i) => i.key)));
    const removed = new Set(r.removedKeys);
    const leaving = plan
      .flatMap((d) => d.items)
      .filter((i) => i.kind === "task" && i.status !== "pending" && removed.has(i.key) && !newKeys.has(i.key))
      .map((i) => toChecked(i, true));
    const leavingKeys = new Set(leaving.map((i) => i.key));
    const todayItems = [...(r.days.find((d) => d.date === today)?.items ?? [])];
    const todayDay: StoredDay = {
      date: today,
      items: todayItems,
      checked: [...(stored[0]?.checked ?? []), ...leaving.filter((i) => i.date === today)].sort(byStart),
    };
    const summary: ShiftSummary = {
      moved: unit === "days" ? movable.filter((it) => Date.parse(it.start) >= cutMs).length : r.moved.length,
      carried: r.carryIn.length,
      dropped: r.dropped.filter((i) => i.status === "pending").length,
      regenerated: r.regeneratedDates,
      endOfDay: todayItems.at(-1)?.end ?? null,
      day: todayDay,
    };
    if (!opts.dryRun)
      this.store.transaction(() => {
        this.store.applyChanges({ upsert: [...r.moved, ...r.added], remove: r.removedKeys.filter((k) => !leavingKeys.has(k)), checked: leaving });
        const last = r.days.at(-1)?.date;
        if (last && last > (this.store.getMeta(META_PLAN_TO) ?? "")) this.store.setMeta(META_PLAN_TO, last);
        if (unit === "days") {
          // The days off are the ones the shift actually emptied: everything up to the day the work
          // landed on, which the core already computed. Taking `amount` instead would under-record the
          // range whenever today had nothing left to move, and the next replan would refill it.
          // A replan keeps them off; +1 then +1 = +2.
          const firstNew = r.regeneratedDates[0];
          const off = firstNew ? addDays(firstNew, -1) : addDays(today, amount - 1);
          if (off > (this.offUntil() ?? "")) this.store.setMeta(META_OFF_UNTIL, off);
        }
        if (unit !== "days") {
          const first = todayItems.find((i) => i.kind === "task" && i.status === "pending" && Date.parse(i.start) >= cutMs);
          if (first) this.store.setMeta(META_RESUME_AT, `${today}|${first.start}`);
        }
        this.store.renumberRests(r.days.map((d) => d.date));
        this.harvestSessions();
        // Atomic with the shift: a resume clears the pause here, so a crash can never leave the plan
        // moved with the pause still in place (or the other way round).
        opts.onCommit?.();
      });
    return summary;
  }

  // ------------------------------------------------------------------ read models

  todayView(): TodayView {
    this.ensureCurrent();
    const now = this.nowMs();
    const date = this.today();
    const day = this.store.getDay(date);
    // "Where am I" is answered from the pause instant while the plan is frozen (P8 rule 2): nothing
    // that had not begun by then has begun, and everything still to come is about to move by the whole
    // pause. Reading it live would claim the owner is on a task they have not started. `now` and
    // `paused.elapsedSec` stay live, and a stale pause (> 24 h) no longer freezes anything.
    const at = this.store.freshPausedSince(now) ?? now;
    const current = day.items.find((it) => Date.parse(it.start) <= at && at < Date.parse(it.end)) ?? null;
    const next = day.items.find((it) => Date.parse(it.start) > at) ?? null;
    const currentTask = day.items.find((it) => it.kind === "task" && it.status === "pending" && Date.parse(it.start) <= at && at < Date.parse(it.end)) ?? null;
    const nextTask = day.items.find((it) => it.kind === "task" && it.status === "pending" && Date.parse(it.start) > at) ?? null;
    const tasks = day.items.filter((it) => it.kind === "task");
    const closedItems = tasks.filter((it) => it.status !== "pending");
    const checkedMin = day.checked.reduce((s, it) => s + minutesOf(it), 0);
    let upcoming: TodayView["upcoming"] = null;
    for (const d of this.store.getRange(addDays(date, 1), daysBetween(date, this.horizonEnd()))) {
      const first = d.items.find((it) => it.kind === "task");
      if (first) {
        upcoming = { date: d.date, firstTitle: first.title };
        break;
      }
    }
    return {
      date,
      now: toIso(now, this.timeZone),
      day,
      current,
      next,
      currentTask,
      nextTask,
      progress: {
        done: closedItems.length + day.checked.length,
        total: tasks.length + day.checked.length,
        taskMinDone: closedItems.reduce((s, it) => s + minutesOf(it), 0) + checkedMin,
        taskMinTotal: tasks.reduce((s, it) => s + minutesOf(it), 0) + checkedMin,
        checkedMin,
      },
      upcoming,
      paused: this.paused(),
    };
  }

  /** Daily tasks report their status for `date` (default today). `scheduledOn`: timeline dates from today. */
  taskView(task: Task, date = this.today()): TaskView {
    const daily = task.repeat === "daily";
    const today = this.today();
    const scheduledOn = [...new Set(this.store.itemsForTask(task.uid, "timeline").filter((it) => it.date >= today).map((it) => it.date))];
    const p = daily ? { doneMin: 0, partsDone: 0 } : this.progressOf(task.uid);
    return {
      ...task,
      status: this.statusOf(statusKey(task.uid, daily ? date : undefined)),
      scheduledOn,
      progress: {
        ...p,
        remainingMin: daily ? task.durationMin : Math.max(0, task.durationMin - p.doneMin),
        ...(daily ? { sessionsHeld: this.store.heldSessionDates(task.uid).length } : {}),
      },
    };
  }

  listTasks(filter: { track?: string; status?: string; type?: string } = {}): TaskView[] {
    this.ensureCurrent();
    if (filter.status !== undefined && !ITEM_STATUSES.includes(filter.status as ItemStatus))
      throw new PlannerError("INVALID_INPUT", `status must be one of ${ITEM_STATUSES.join(", ")}; got "${filter.status}"`, "Omit status to list every task.");
    const tracks = new Set(this.tasks.map((t) => t.track));
    if (filter.track && !tracks.has(filter.track)) {
      const g = closest(filter.track, tracks);
      throw new PlannerError("INVALID_INPUT", `unknown track "${filter.track}"`, g ? `Did you mean ${g}? Tracks: ${[...tracks].join(", ")}.` : "No tracks are loaded.");
    }
    if (filter.type && !(TASK_TYPES as readonly string[]).includes(filter.type))
      throw new PlannerError("INVALID_INPUT", `unknown type "${filter.type}"`, `Did you mean ${closest(filter.type, TASK_TYPES)}? Types: ${TASK_TYPES.join(", ")}.`);
    return this.tasks
      .filter((t) => (!filter.track || t.track === filter.track) && (!filter.type || t.type === filter.type))
      .map((t) => this.taskView(t))
      .filter((t) => !filter.status || t.status === filter.status);
  }

  getTask(uid: string): TaskView & { items: PlanItem[] } {
    this.ensureCurrent();
    const task = this.byUid.get(uid);
    if (!task) throw this.unknownTask(uid);
    return { ...this.taskView(task), items: this.store.itemsForTask(uid) };
  }

  tracks() {
    this.ensureCurrent();
    const today = this.today();
    const todayTracks = new Set(this.store.getDay(today).items.flatMap((it) => (it.kind === "task" && it.track ? [it.track] : [])));
    const out = new Map<
      string,
      { track: string; kind: string; priority: number | null; title: string; total: number; done: number; skipped: number; remainingMin: number; active: boolean }
    >();
    for (const f of [...this._files].sort((a, b) => (a.meta.priority ?? 99) - (b.meta.priority ?? 99) || (a.path < b.path ? -1 : 1))) {
      const t =
        out.get(f.meta.track) ??
        { track: f.meta.track, kind: f.meta.kind, priority: f.meta.priority ?? null, title: f.meta.title, total: 0, done: 0, skipped: 0, remainingMin: 0, active: todayTracks.has(f.meta.track) };
      for (const task of f.tasks) {
        if (this.byUid.get(task.uid) !== task) continue;
        const s = this.statusOf(statusKey(task.uid, task.repeat === "daily" ? today : undefined));
        t.total++;
        if (s === "done") t.done++;
        else if (s === "skipped") t.skipped++;
        else t.remainingMin += task.repeat === "daily" ? task.durationMin : this.remainingOf(task.uid);
      }
      out.set(f.meta.track, t);
    }
    return [...out.values()];
  }
}
