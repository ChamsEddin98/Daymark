import { addDays, hhmm, shortDate } from "./time";
import type { ShiftBody, ShiftResult } from "./types";

export function shiftLabel(body: ShiftBody): string {
  if (body.unit === "days") return `${body.amount} day${body.amount === 1 ? "" : "s"}`;
  if (body.unit === "hours") return `${body.amount} h`;
  return `${body.amount} min`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (names: string[]) =>
  names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;

export interface ShiftContext {
  /** Today's date, so a days shift can name the day the work lands on. */
  date: string;
  /** Today's task items that would move (start ≥ now), computed from the timeline. */
  movingTasks?: number;
  /** Titles of the pending daily sessions this shift would push past midnight. */
  droppedTitles?: string[];
}

export interface ShiftCopy {
  /** The headline outcome: "Ends 19:00", or "Wed 30 Sep · 7 of today's tasks move". */
  main: string;
  /** Counts and anything lost, shown under the headline. */
  detail: string | null;
  /** Work that leaves the plan or the day, shown as a warning. */
  warning: string | null;
}

/**
 * One wording for the popover preview and the confirmation toast, built from the same
 * `POST /plan/shift(/preview)` fields, so the numbers always agree. A days shift leads with the
 * date the work lands on, which is what tells +1 day and +2 days apart when their counts match.
 */
export function describeShift(body: ShiftBody, r: ShiftResult, ctx?: ShiftContext): ShiftCopy {
  const dropped = r.dropped ?? 0;
  const names = ctx?.droppedTitles ?? [];
  const warning =
    dropped > 0
      ? `${plural(dropped, "daily session")} dropped${names.length ? `: ${list(names)}` : ""}`
      : null;

  if (body.unit === "days") {
    const target = ctx ? shortDate(addDays(ctx.date, body.amount)) : null;
    const moving = ctx?.movingTasks;
    const main = target
      ? moving !== undefined
        ? `${target} · ${moving} of today's task${moving === 1 ? "" : "s"} move`
        : target
      : `${plural(r.moved, "item")} move to later days`;
    const detail = `${plural(r.moved, "item")} in all${r.endOfDay ? ` · today ends ${hhmm(r.endOfDay)}` : ""}`;
    return { main, detail, warning };
  }

  const carried = r.carried > 0 ? `${plural(r.carried, "task")} pushed to tomorrow` : null;
  return {
    main: r.endOfDay ? `Ends ${hhmm(r.endOfDay)}` : "Nothing left today",
    detail: carried,
    warning,
  };
}

/** One line for a toast: everything the popover showed, in reading order. */
export function shiftSentence(body: ShiftBody, r: ShiftResult, ctx?: ShiftContext): string {
  const c = describeShift(body, r, ctx);
  return [c.main, c.detail, c.warning].filter(Boolean).join(" · ");
}
