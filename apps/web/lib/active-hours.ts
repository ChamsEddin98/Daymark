import type { ActiveHours, SettingsResponse } from "./types";

/**
 * Active hours in the two units the owner and the API each want. The owner thinks in hours a day;
 * the API stores minutes of task time. Converting in one place keeps the form and the request from
 * disagreeing by a rounding error.
 */
export const MIN_PER_HOUR = 60;
export const hoursOf = (min: number) => Math.round((min / MIN_PER_HOUR) * 100) / 100;
export const minutesOf = (hours: number) => Math.round(hours * MIN_PER_HOUR);

/** "8h", "8h 30m", "45m" — the same shape `dur()` gives a task, for a day's budget. */
export function budgetLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** `24:00` is how the API says "no fence"; the owner should read that as midnight, not as a time. */
export const endLabel = (dayEnd: string) => (dayEnd === "24:00" ? "midnight" : dayEnd);

export interface HoursDraft {
  dayStart: string;
  dayEnd: string;
  /** Hours, as the form shows them. Converted on submit. */
  hours: number;
  onMissed: ActiveHours["onMissed"];
}

export const draftOf = (h: ActiveHours): HoursDraft => ({ dayStart: h.dayStart, dayEnd: h.dayEnd, hours: hoursOf(h.dailyTaskMin), onMissed: h.onMissed });
export const patchOf = (d: HoursDraft): ActiveHours => ({ dayStart: d.dayStart, dayEnd: d.dayEnd, dailyTaskMin: minutesOf(d.hours), onMissed: d.onMissed });

export const sameDraft = (a: HoursDraft, b: HoursDraft) =>
  a.dayStart === b.dayStart && a.dayEnd === b.dayEnd && minutesOf(a.hours) === minutesOf(b.hours) && a.onMissed === b.onMissed;

/** The two answers to "you did not get to this", in the owner's words rather than the API's. */
export const MISSED_CHOICES: { id: ActiveHours["onMissed"]; label: string; help: string }[] = [
  { id: "reflow", label: "Re-time my day", help: "The rest of the day slides so the work still fits. You are told what moved." },
  { id: "notify", label: "Just tell me", help: "Nothing moves. You decide: do it, skip it, or let it roll over tonight." },
];

const CLOCK = /^([01]?\d|2[0-4]):([0-5]\d)$/;
const clockMin = (s: string) => {
  const m = CLOCK.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * What is wrong with a draft, in the owner's words, or null when it is fine. The API validates too —
 * this exists so the form can refuse to submit something it already knows will be rejected, and say
 * why beside the field rather than in an error toast.
 */
export function draftError(d: HoursDraft): string | null {
  const start = clockMin(d.dayStart);
  const end = clockMin(d.dayEnd);
  if (start === null) return "Start needs to be a time like 08:00";
  if (end === null) return "End needs to be a time like 20:00, or 24:00 for midnight";
  if (end > 24 * 60 || (end === 24 * 60 && d.dayEnd !== "24:00")) return "End cannot be past midnight";
  if (end <= start) return "The day has to end after it starts";
  // A window cannot wrap midnight: every key in the plan carries a calendar date.
  if (end - start < 15) return "That leaves less than 15 minutes — too short for one task";
  if (!Number.isFinite(d.hours) || d.hours <= 0) return "Hours a day has to be more than zero";
  if (minutesOf(d.hours) < 15) return "Hours a day has to be at least 15 minutes";
  if (minutesOf(d.hours) > 24 * 60) return "Hours a day cannot be more than 24";
  return null;
}

/**
 * What the saved settings actually produce, for the line under the form and the toast after saving.
 *
 * The reason this needs saying at all: every 4 hours of task time buys an hour of long rest, so the
 * clock a day needs grows in steps. Asking for 10 hours inside an 08:00–20:00 window grants 8, and a
 * UI that echoed the request back would be lying about the plan.
 */
export interface EffectiveCopy {
  /** "Days hold 8h, ending by 18:40". */
  main: string;
  /** Present when the window, not the budget, is the limit — with the fix. */
  warning?: string;
}

export function describeEffective(s: SettingsResponse): EffectiveCopy {
  const asked = s.activeHours.dailyTaskMin;
  const got = s.effective.dailyTaskMin;
  const ends = s.effective.lastEnd ? s.effective.lastEnd.slice(11, 16) : null;
  if (got === null) return { main: `Days start at ${s.activeHours.dayStart} and hold up to ${budgetLabel(asked)}` };
  const main = `Days hold ${budgetLabel(got)}${ends ? `, ending by ${ends}` : ""}`;
  if (s.effective.boundBy !== "window" || got >= asked) return { main };
  return {
    main,
    warning: `Your ${budgetLabel(asked)} does not fit before ${endLabel(s.activeHours.dayEnd)} — each 4h of work adds an hour of rest. Push the end later to get the rest.`,
  };
}
