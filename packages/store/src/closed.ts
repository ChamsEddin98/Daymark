/**
 * Checked items (done/skipped) are never deleted by a regeneration or a shift. One that loses its
 * timeline slot leaves the timeline and goes to its day's `checked` list:
 * - `start`/`end` show its ORIGINAL slot: `plannedStart`/`plannedEnd`, captured once at its first status
 *   change and never overwritten (so it stays on its own date, 08:00-24:00);
 * - `lastStart`/`lastEnd` keep the last slot it had on the timeline, which is what calendar sync last
 *   wrote; sync leaves an existing event there (no patch, no delete) and never inserts one.
 */
import type { PlanItem } from "@planner/core";

export type StoredItem = PlanItem & { plannedStart?: string; plannedEnd?: string; lastStart?: string; lastEnd?: string };

const ms = (iso: string) => Date.parse(iso);

export const byStart = (a: PlanItem, b: PlanItem) => ms(a.start) - ms(b.start) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Capture the original slot at the first status change (no-op afterwards). */
export function withPlanned(it: StoredItem): StoredItem {
  return it.plannedStart ? it : { ...it, plannedStart: it.start, plannedEnd: it.end };
}

/** The item as it leaves the timeline (`placed`: it is on the timeline now). */
export function toChecked(it: StoredItem, placed: boolean): StoredItem {
  const p = withPlanned(it);
  return {
    ...p,
    start: p.plannedStart!,
    end: p.plannedEnd!,
    lastStart: placed ? it.start : (it.lastStart ?? it.start),
    lastEnd: placed ? it.end : (it.lastEnd ?? it.end),
  };
}

/**
 * Google Calendar stores whole seconds, so the fractional second an exact (pause/resume) shift can
 * leave on an item is dropped here. Without this every sync would read the event back a few
 * milliseconds off its item and patch it again, for ever.
 */
const wholeSecond = (iso: string) => iso.replace(/\.\d+(?=[+-]\d{2}:\d{2}$|Z$)/, "");

/** A checked item for calendar sync: its last timeline slot. */
export function calendarView(it: StoredItem): PlanItem {
  const { lastStart, lastEnd, plannedStart: _ps, plannedEnd: _pe, ...rest } = it;
  return { ...rest, start: wholeSecond(lastStart ?? it.start), end: wholeSecond(lastEnd ?? it.end) };
}
