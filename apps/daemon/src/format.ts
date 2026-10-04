/**
 * Toast text for one instant's boundaries. Several boundaries at the same instant (task end + rest
 * start, rest end + task start) become ONE toast; the store still gets one record per boundary.
 */
import { toIso, type PlanItem } from "@planner/core";
import type { BoundaryType } from "@planner/store";

export interface BoundaryEvent {
  type: BoundaryType;
  item: PlanItem;
  /** Boundary instant (epoch ms): the item's start for *_start, its end for *_end. */
  atMs: number;
  /**
   * Rests inside a free window (see scanner.ts "Free windows"): the first rest_start of the window
   * carries `free` = when the window ends and the pending task that ends it; the toast says
   * "Free until <untilMs> · Next: <next>".
   */
  free?: { untilMs: number; next?: PlanItem };
  /** Recorded but not shown (inner boundaries of a free window). */
  silent?: boolean;
}

export interface ToastContent {
  title: string;
  message: string;
}

/** Reads the plan around a boundary (for "then …" / "next: …"). */
export type ItemsAfter = (fromMs: number, date: string) => PlanItem[];

export const hhmm = (ms: number, tz: string) => toIso(ms, tz).slice(11, 16);

export function fmtDuration(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

const minutes = (it: PlanItem) => (Date.parse(it.end) - Date.parse(it.start)) / 60_000;

/**
 * "A1 · Boolean filtering": the heading as written. A heading usually starts with the task id
 * ("A1 · …"); when it does not ("Skip test — …"), the title is used as is (no id prefix).
 */
export function taskLabel(it: PlanItem): string {
  return it.title;
}

export function restLabel(it: PlanItem): string {
  return `${it.restKind === "long" ? "Long rest" : "Rest"} ${fmtDuration(minutes(it))}`;
}

/** Title stored with each notification record (and shown by the API / SSE). */
export function recordTitle(e: BoundaryEvent, tz: string): string {
  switch (e.type) {
    case "task_start":
      return `Start: ${taskLabel(e.item)}`;
    case "task_end":
      return `End: ${taskLabel(e.item)}`;
    case "rest_start":
      return e.free ? `Free until ${hhmm(e.free.untilMs, tz)}` : restLabel(e.item);
    case "rest_end":
      return `${e.item.restKind === "long" ? "Long rest" : "Rest"} over`;
  }
}

const PRIORITY: BoundaryType[] = ["task_start", "rest_start", "task_end", "rest_end"];
const open = (it: PlanItem) => it.kind === "rest" || it.status === "pending";

/** What follows `ms`: the first open item starting at/after it (today, else the next plan day). */
function following(itemsAfter: ItemsAfter, ms: number, date: string, exceptKey?: string): PlanItem | undefined {
  return itemsAfter(ms, date).find((it) => it.key !== exceptKey && Date.parse(it.start) >= ms && open(it));
}
function nextTask(itemsAfter: ItemsAfter, ms: number, date: string): PlanItem | undefined {
  return itemsAfter(ms, date).find((it) => it.kind === "task" && Date.parse(it.start) >= ms && it.status === "pending");
}

function thenText(next: PlanItem | undefined, date: string, tz: string, endMs: number): string {
  if (!next || next.date > date) return "then done for today";
  if (next.kind === "rest") return `then ${next.restKind === "long" ? `${fmtDuration(minutes(next))} long rest` : `${fmtDuration(minutes(next))} rest`}`;
  const at = Date.parse(next.start);
  return at > endMs ? `then ${taskLabel(next)} at ${hhmm(at, tz)}` : `then ${taskLabel(next)}`;
}

function nextText(next: PlanItem | undefined, date: string): string {
  return !next || next.date > date ? "then done for today" : `next: ${taskLabel(next)}`;
}

export function buildToast(events: readonly BoundaryEvent[], tz: string, itemsAfter: ItemsAfter): ToastContent {
  const lead = [...events].sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type))[0]!;
  const it = lead.item;
  const endMs = Date.parse(it.end);
  switch (lead.type) {
    case "task_start":
      return { title: `Start: ${taskLabel(it)}`, message: `Until ${hhmm(endMs, tz)} · ${thenText(following(itemsAfter, endMs, it.date, it.key), it.date, tz, endMs)}` };
    case "rest_start": {
      if (lead.free) {
        const nx = lead.free.next;
        return { title: `Free until ${hhmm(lead.free.untilMs, tz)}`, message: nx && nx.date === it.date ? `Next: ${taskLabel(nx)}` : "Nothing left today" };
      }
      return { title: restLabel(it), message: `Until ${hhmm(endMs, tz)} · ${nextText(nextTask(itemsAfter, endMs, it.date), it.date)}` };
    }
    case "task_end": {
      const next = following(itemsAfter, endMs, it.date, it.key);
      const tail = !next || next.date > it.date ? "Done for today" : next.kind === "rest" ? `Next: ${restLabel(next)} at ${hhmm(Date.parse(next.start), tz)}` : `Next: ${taskLabel(next)} at ${hhmm(Date.parse(next.start), tz)}`;
      return { title: `Time's up: ${taskLabel(it)}`, message: tail };
    }
    case "rest_end": {
      const next = nextTask(itemsAfter, endMs, it.date);
      const tail = !next || next.date > it.date ? "Nothing left today" : `Next: ${taskLabel(next)} at ${hhmm(Date.parse(next.start), tz)}`;
      return { title: recordTitle(lead, tz), message: tail };
    }
  }
}

/**
 * Startup toast for the item already in progress when the daemon starts (its start boundary was
 * missed): "Now: A1 · Boolean filtering" / "Until 09:30 · then 10 min rest".
 */
export function buildResume(it: PlanItem, tz: string, itemsAfter: ItemsAfter): ToastContent {
  const endMs = Date.parse(it.end);
  if (it.kind === "task")
    return { title: `Now: ${taskLabel(it)}`, message: `Until ${hhmm(endMs, tz)} · ${thenText(following(itemsAfter, endMs, it.date, it.key), it.date, tz, endMs)}` };
  return { title: `Now: ${restLabel(it)}`, message: `Until ${hhmm(endMs, tz)} · ${nextText(nextTask(itemsAfter, endMs, it.date), it.date)}` };
}
