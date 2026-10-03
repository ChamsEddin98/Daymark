import type { ItemStatus, PlanItem, TodayResponse } from "./types";
import { ms } from "./time";

export type Phase = "empty" | "before" | "task" | "rest" | "gap" | "after";

export interface Derived {
  items: PlanItem[];
  tasks: PlanItem[];
  /** Done/skipped items that lost their timeline slot, with overrides applied. */
  checked: PlanItem[];
  /** Timeline tasks that ended before now and are still pending. */
  missed: PlanItem[];
  /**
   * How to label each late task: "unchecked" during its own trailing rest, "missed" once the
   * next task has started. Keyed by item key; absent for tasks that are not late.
   */
  lateStates: ReadonlyMap<string, "unchecked" | "missed">;
  current: PlanItem | null;
  /** 0..1 progress through the current item */
  currentProgress: number;
  next: PlanItem | null;
  /** first pending task that starts at or after now (used by "starts with …" copy) */
  nextTask: PlanItem | null;
  phase: Phase;
  /** From the API's `progress` (timeline + checked), adjusted for optimistic changes. */
  done: number;
  total: number;
  /** pending task minutes still ahead of now */
  minutesLeft: number;
  /** task minutes done, timeline + checked */
  minutesDone: number;
  dayStart: string | null;
  dayEnd: string | null;
  allDone: boolean;
}

const isDone = (s: ItemStatus) => s !== "pending";

/** Pure: the day as the UI should show it at `now`, with optimistic overrides applied. */
export function derive(
  t: Pick<TodayResponse, "day" | "progress"> | null,
  now: number,
  overrides: ReadonlyMap<string, ItemStatus>,
): Derived {
  const apply = (i: PlanItem) => (overrides.has(i.key) ? { ...i, status: overrides.get(i.key)! } : i);
  const rawItems = t?.day.items ?? [];
  const rawChecked = t?.day.checked ?? [];
  const items = rawItems.map(apply);
  const checked = rawChecked.map(apply);
  const tasks = items.filter((i) => i.kind === "task");
  const current = items.find((i) => ms(i.start) <= now && now < ms(i.end)) ?? null;
  const next = items.find((i) => ms(i.start) > now) ?? null;
  const nextTask = items.find((i) => i.kind === "task" && ms(i.start) >= now && i.status === "pending") ?? null;
  const missed = tasks.filter((i) => i.status === "pending" && ms(i.end) <= now);
  const lateStates = new Map<string, "unchecked" | "missed">();
  for (const late of missed) {
    const after = items.find((i) => i.kind === "task" && ms(i.start) > ms(late.start));
    // Still "unchecked" while its own trailing rest runs; "missed" once the next task has begun.
    lateStates.set(late.key, !after || ms(after.start) <= now ? "missed" : "unchecked");
  }

  // Server counts plus the delta of optimistic overrides not yet confirmed.
  let delta = 0;
  for (const raw of [...rawItems, ...rawChecked]) {
    if (raw.kind !== "task" || !overrides.has(raw.key)) continue;
    const o = overrides.get(raw.key)!;
    if (isDone(o) !== isDone(raw.status)) delta += isDone(o) ? 1 : -1;
  }
  const localDone = [...tasks, ...checked].filter((i) => isDone(i.status)).length;
  const done = t?.progress ? t.progress.done + delta : localDone;
  const total = t?.progress ? t.progress.total : tasks.length + checked.length;

  let minutesLeft = 0;
  let minutesDone = 0;
  for (const x of [...tasks, ...checked]) {
    if (isDone(x.status)) minutesDone += (ms(x.end) - ms(x.start)) / 60_000;
  }
  for (const x of tasks) {
    if (x.status !== "pending") continue;
    const s = Math.max(ms(x.start), now);
    const e = ms(x.end);
    if (e > s) minutesLeft += (e - s) / 60_000;
  }
  const dayStart = items[0]?.start ?? null;
  const dayEnd = items.at(-1)?.end ?? null;
  let phase: Phase;
  if (!items.length) phase = "empty";
  else if (now < ms(items[0]!.start)) phase = "before";
  else if (now >= ms(items.at(-1)!.end)) phase = "after";
  else if (!current) phase = "gap";
  else phase = current.kind === "task" ? "task" : "rest";
  const currentProgress = current
    ? Math.min(1, Math.max(0, (now - ms(current.start)) / (ms(current.end) - ms(current.start))))
    : 0;
  return {
    items,
    tasks,
    checked,
    missed,
    lateStates,
    current,
    currentProgress,
    next,
    nextTask,
    phase,
    done,
    total,
    minutesLeft,
    minutesDone,
    dayStart,
    dayEnd,
    allDone: total > 0 && done >= total,
  };
}
