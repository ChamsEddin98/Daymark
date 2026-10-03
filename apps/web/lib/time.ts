/**
 * Times arrive as ISO strings with the planner's local offset. Wall-clock labels are read straight
 * from the string so the UI shows the planner's time zone even if the browser is elsewhere.
 */
export const hhmm = (iso: string) => iso.slice(11, 16);
export const ms = (iso: string) => Date.parse(iso);
export const minutesBetween = (a: string, b: string) => Math.round((ms(b) - ms(a)) / 60_000);

/** 40 → "40m", 60 → "1h", 90 → "1h 30m" */
export function dur(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** Long form used in sentences: "12 min", "1 h 5 min". */
export function durLong(min: number): string {
  const m = Math.max(0, Math.ceil(min));
  if (m < 1) return "less than a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/**
 * The live pause counter: "0:07", "1:12", "1:02:33". Always m:ss (or h:mm:ss) so the width is
 * stable under tabular numerals and the number never jumps between shapes as it ticks.
 */
export function clockDur(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  const s = t % 60;
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/**
 * How far a resume moved the plan, from `pausedSec` (seconds with a fractional part).
 * Seconds under a minute, m:ss above, and at most one decimal below 10 s — never absurd precision.
 */
export function pausedForLabel(sec: number): string {
  const v = Math.max(0, sec);
  if (v < 10) {
    const one = Math.round(v * 10) / 10;
    return `${Number.isInteger(one) ? one : one.toFixed(1)} s`;
  }
  if (v < 60) return `${Math.round(v)} s`;
  return clockDur(Math.round(v));
}

const pad2 = (n: number) => String(n).padStart(2, "0");

const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MO = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09-28" → "Monday 28 September" (calendar date, no time zone involved). */
export function longDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WD[wd]} ${d} ${MO[m - 1]}`;
}

/** "2026-09-30" -> "Wed 30 Sep" */
export function shortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${WD[wd]!.slice(0, 3)} ${d} ${MO[m - 1]!.slice(0, 3)}`;
}

/** "2026-09-28" + 2 -> "2026-09-30" (calendar arithmetic, no time zone involved). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** "2026-09-29" -> "29 Sep" (calendar date, no time zone involved). */
export function dayMonth(date: string): string {
  const [, m, d] = date.split("-").map(Number) as [number, number, number];
  return `${d} ${MO[m - 1]!.slice(0, 3)}`;
}

/**
 * How to name the instant `iso` relative to the day `today`: the wall clock alone when it is the
 * same day, and the day as well when it is not — a pause that began at 23:40 must not read as
 * "since 23:40" the next morning.
 */
export function whenOn(today: string, iso: string): string {
  const date = iso.slice(0, 10);
  const at = hhmm(iso);
  if (date === today) return at;
  if (isTomorrow(date, today)) return `yesterday ${at}`;
  return `${dayMonth(date)} ${at}`;
}

export function isTomorrow(today: string, other: string): boolean {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return t === other;
}
