/**
 * Shared plan contract. Every part (scheduler, store/API, calendar sync, notifier, web UI)
 * codes against these types. Change them only with a note in docs/PLAN.md.
 *
 * Times are ISO-8601 strings WITH the local UTC offset (e.g. "2026-09-28T08:00:00+01:00").
 * Plan dates are local calendar dates "YYYY-MM-DD".
 */

export type ItemKind = "task" | "rest";
export type RestKind = "short" | "long"; // short = 10 min between tasks, long = 1 h after 4 h of task time
export type ItemStatus = "pending" | "done" | "skipped";

export interface PlanItem {
  /**
   * Stable identity used by the store, calendar events (extendedProperties.private.plannerKey)
   * and notification de-duplication. Tasks: `${date}|${taskUid}|${partIndex}`.
   * Rests: `${date}|rest|${n}`. Shifting an item changes its times, never its key,
   * except a 1-day shift which moves it to another date and therefore re-keys it.
   */
  key: string;
  date: string;
  kind: ItemKind;
  start: string;
  end: string;
  /** Task items only. */
  taskUid?: string;
  track?: string;
  /** Task title from the task file, plus " (part i/n)" when split (`partTitle`). Rest: "Rest" / "Long rest". */
  title: string;
  restKind?: RestKind;
  /** 1-based part index and total parts when a task is split across the 4 h boundary or across days. */
  part?: { index: number; total: number };
  links?: { label: string; url: string }[];
  type?: string;
  status: ItemStatus;
}

/**
 * The title a split task's item carries: the heading text plus its part label. The **one** definition
 * of that format - the generator writes it, and the store rewrites it in place when a task is renamed
 * (P9 `restyleTask`). Two spellings of it would let a rename put a stale label in a calendar event.
 */
export const partTitle = (title: string, index: number, total: number): string => `${title} (part ${index}/${total})`;

export interface PlanDay {
  date: string;
  items: PlanItem[]; // chronological
}

/**
 * The owner's **active hours**: when a day may begin, when it must stop, and how much task time it
 * holds. The three are independent, and whichever binds first wins:
 *
 * - `dayStart`/`dayEnd` are the fence. Nothing is placed before the start or past the end, and work
 *   that does not fit before `dayEnd` moves to the next day, exactly as it already does at midnight.
 * - `dailyTaskMin` is the budget: how many minutes of *task time* (rests excluded) a day holds.
 *
 * The rest rules are not affected by any of them: a short rest between consecutive tasks, and a long
 * rest after every `blockMin` of task time. So raising `dailyTaskMin` to 600 does not make a longer
 * block - it makes a third block, with a long rest at 240 and another at 480.
 */
export interface ScheduleConfig {
  dayStart: string; // "08:00"
  /**
   * Hard stop, as a clock time. `"24:00"` (the default) means midnight, i.e. no fence beyond the one
   * the calendar day already imposes - so the default behaves exactly as it did before active hours
   * existed. A window must lie inside one calendar day: `dayStart` < `dayEnd` <= `"24:00"`.
   */
  dayEnd: string; // "24:00"
  shortRestMin: number; // 10
  blockMin: number; // 240 (4 h of task time): a long rest comes after every one of these
  longRestMin: number; // 60
  /** Task minutes per day, rests excluded. 480 = the 4 h + 4 h the owner's rules describe. */
  dailyTaskMin: number; // 480
  timeZone: string; // IANA, e.g. "Africa/Tunis"; default: system zone
  minPartMin?: number; // 15: no generated part is shorter (see "No fragments" in docs/PLAN.md)
  minCarryPieceMin?: number; // 45: a task split across days keeps each day's piece at least this long
}

export const DEFAULT_CONFIG: Omit<ScheduleConfig, "timeZone"> = {
  dayStart: "08:00",
  dayEnd: "24:00",
  shortRestMin: 10,
  blockMin: 240,
  longRestMin: 60,
  dailyTaskMin: 480,
  minPartMin: 15,
  minCarryPieceMin: 45,
};

/**
 * What to do when a task's slot goes by and it is still pending.
 *
 * - `reflow` (the default): take the work back and lay the rest of the day out again from now, so a
 *   late start slides the day instead of stranding the task. A notification says what moved.
 * - `notify`: change nothing; just say so, and let the owner decide - do it, skip it, or leave it to
 *   roll over tonight. The plan is never touched behind their back.
 *
 * Either way the work is never lost: whatever is still pending at midnight carries to the next day.
 */
export type MissedPolicy = "reflow" | "notify";
export const MISSED_POLICIES: readonly MissedPolicy[] = ["reflow", "notify"];

/** The active-hours fields, the subset an owner sets. The rest of `ScheduleConfig` is not settable. */
export interface ActiveHours {
  /** "HH:MM". The earliest a day may start. */
  dayStart: string;
  /** "HH:MM", up to "24:00". Nothing runs past it. */
  dayEnd: string;
  /** Minutes of task time per day, rests excluded. */
  dailyTaskMin: number;
  /** What happens when a task's slot passes while it is still pending. */
  onMissed: MissedPolicy;
}

export const DEFAULT_ACTIVE_HOURS: ActiveHours = {
  dayStart: DEFAULT_CONFIG.dayStart,
  dayEnd: DEFAULT_CONFIG.dayEnd,
  dailyTaskMin: DEFAULT_CONFIG.dailyTaskMin,
  onMissed: "reflow",
};

/** Longest day the fence allows: 24 h of clock. A budget above this could never be placed. */
export const MAX_DAILY_TASK_MIN = 24 * 60;

/**
 * What a calendar the planner creates is called, before the owner renames it.
 *
 * It lives here because `packages/store` holds the setting and `packages/calendar` writes it to
 * Google, neither depends on the other, and both must agree on the default - two copies of the
 * string would drift the moment one changed.
 */
export const DEFAULT_CALENDAR_NAME = "Daymark";

/** The units `POST /plan/shift` accepts. Whole numbers only. */
export type ShiftUnit = "minutes" | "hours" | "days";

/**
 * Units `shiftPlan` accepts. `ms` is the exact path pause/resume uses (docs/PLAN.md, P8): a whole
 * number of milliseconds, applied as given and never rounded to a minute. It is not an HTTP unit.
 */
export type ShiftAmountUnit = ShiftUnit | "ms";

/** Longest exact shift: a pause longer than this must be handled with a day shift (P8 rule 7). */
export const MAX_SHIFT_MS = 24 * 60 * 60_000;
