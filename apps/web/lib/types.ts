/**
 * Mirror of packages/core/src/schedule/types.ts (PlanItem / PlanDay) plus the /today payload of
 * docs/API.md. The web app only talks HTTP, so it keeps its own copy instead of importing core.
 */
export type ItemKind = "task" | "rest";
export type RestKind = "short" | "long";
export type ItemStatus = "pending" | "done" | "skipped";

export interface PlanItem {
  key: string;
  date: string;
  kind: ItemKind;
  start: string;
  end: string;
  taskUid?: string;
  track?: string;
  title: string;
  restKind?: RestKind;
  part?: { index: number; total: number };
  links?: { label: string; url: string }[];
  type?: string;
  status: ItemStatus;
  /** Original slot, captured at the first status change (checked items show these). */
  plannedStart?: string;
  plannedEnd?: string;
  /** Last slot the item had on the timeline. */
  lastStart?: string;
  lastEnd?: string;
}

export interface PlanDay {
  date: string;
  /** The timeline only. */
  items: PlanItem[];
  /** Done/skipped items that lost their timeline slot (shift, regenerate). Never pending. */
  checked?: PlanItem[];
}

/**
 * A pause freezes the plan (docs/PLAN.md, P8). `since` is the instant it started, to the
 * millisecond; `elapsedSec` is the server's own reading of how long it has run. The UI counts from
 * `since` against its server-aligned clock, so the counter ticks without polling.
 */
export interface PausedState {
  since: string;
  elapsedSec: number;
}

export interface TodayResponse {
  date: string;
  now: string;
  day: PlanDay;
  /** Absent or null when the plan is running. */
  paused?: PausedState | null;
  current: PlanItem | null;
  next: PlanItem | null;
  currentTask?: PlanItem | null;
  nextTask?: PlanItem | null;
  /** Counts timeline task items and checked items; done includes skipped. */
  progress: { done: number; total: number; taskMinDone: number; taskMinTotal: number; checkedMin?: number };
  upcoming: { date: string; firstTitle: string } | null;
}

export type ShiftUnit = "minutes" | "hours" | "days";
export interface ShiftBody {
  amount: number;
  unit: ShiftUnit;
}
export interface ShiftResult {
  moved: number;
  carried: number;
  /** Pending daily items a minute/hour shift pushed past midnight. */
  dropped?: number;
  day?: PlanDay;
  regenerated: string[];
  endOfDay: string | null;
}

/** `POST /plan/pause` */
export interface PauseResult {
  paused: { since: string };
}

/** `POST /plan/resume`. `pausedSec` is seconds with a fractional part (45.317), never rounded. */
export interface ResumeResult {
  pausedSec: number;
  moved: number;
  endOfDay: string | null;
  day?: PlanDay;
}

export interface ApiErrorBody {
  error: { code: string; message: string; hint?: string };
}

export interface TrackInfo {
  track: string;
  kind: string;
  priority?: number;
  title: string;
  total: number;
  done: number;
  skipped: number;
  remainingMin: number;
  active: boolean;
}

/** The owner's working window (docs/PLAN.md, "Active hours"). One setting for every day. */
export interface ActiveHours {
  /** "HH:MM": the earliest a day may begin. */
  dayStart: string;
  /** "HH:MM" up to "24:00": the hard stop. "24:00" means no fence beyond the calendar day. */
  dayEnd: string;
  /** Minutes of task time a day holds, rests excluded. */
  dailyTaskMin: number;
}

export interface SettingsResponse {
  activeHours: ActiveHours;
  defaults: ActiveHours;
  timeZone: string;
  /**
   * What the window actually grants, which is not always what was asked for: every 4 h of task time
   * buys an hour of long rest, so the clock a day needs grows in steps. `boundBy` says which of the
   * two settings is the limit.
   */
  effective: { dailyTaskMin: number | null; boundBy: "window" | "budget"; lastEnd: string | null };
}

export interface SettingsResult {
  activeHours: ActiveHours;
  regenerated: string[];
  changed?: boolean;
  dryRun?: true;
  sync?: string;
}
