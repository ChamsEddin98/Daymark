/** Time-zone helpers on top of Intl. Instants are epoch ms; plan dates are local "YYYY-MM-DD". */

const MIN = 60_000;
const DAY_MS = 86_400_000;
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wall(ms: number, tz: string): Wall {
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(tz).formatToParts(ms)) if (type !== "literal") p[type] = Number(value);
  return { y: p.year!, mo: p.month!, d: p.day!, h: p.hour!, mi: p.minute!, s: p.second! };
}

const wallAsUtc = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

/** UTC offset of `tz` at instant `ms`, in minutes (east positive). */
export function offsetMin(ms: number, tz: string): number {
  return Math.round((wallAsUtc(wall(ms, tz)) - Math.floor(ms / 1000) * 1000) / MIN);
}

/** Instant of local wall time `minuteOfDay` on `date` in `tz`. A time inside a DST gap resolves forward. */
export function zonedMs(date: string, minuteOfDay: number, tz: string): number {
  const local = dateMs(date) + minuteOfDay * MIN;
  const o1 = offsetMin(local, tz);
  const t1 = local - o1 * MIN;
  const o2 = offsetMin(t1, tz);
  if (o1 === o2) return t1;
  const t2 = local - o2 * MIN;
  return offsetMin(t2, tz) === o2 ? t2 : Math.max(t1, t2);
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, "0");

/**
 * "2026-09-28T08:00:00+01:00", or "2026-09-28T08:00:00.317+01:00" when the instant is not on a whole
 * second. Sub-second digits appear only when they carry information, so every minute-aligned plan item
 * keeps the exact form it has always had; a resume (P8) shifts by exact milliseconds and needs them.
 */
export function toIso(ms: number, tz: string): string {
  const w = wall(ms, tz);
  const off = Math.round((wallAsUtc(w) - Math.floor(ms / 1000) * 1000) / MIN);
  const sign = off < 0 ? "-" : "+";
  const frac = ((ms % 1000) + 1000) % 1000;
  const sec = `${pad(w.s)}${frac ? `.${pad(frac, 3)}` : ""}`;
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${sec}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

export function localDate(ms: number, tz: string): string {
  const w = wall(ms, tz);
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}`;
}

/** Wall-clock minutes since local midnight. */
export function localMinute(ms: number, tz: string): number {
  const w = wall(ms, tz);
  return w.h * 60 + w.mi;
}

export function parseInstant(v: string | number | Date): number {
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : v.getTime();
  if (!Number.isFinite(ms)) throw new RangeError(`invalid instant: ${String(v)}`);
  return ms;
}

const dateMs = (date: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`invalid date "${date}", expected YYYY-MM-DD`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

export function addDays(date: string, n: number): string {
  return new Date(dateMs(date) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((dateMs(to) - dateMs(from)) / DAY_MS);
}

/** "08:00" -> 480 */
/**
 * "HH:MM" as minutes from midnight. `"24:00"` is accepted and means the end of the day (1440), the
 * ISO-8601 end-of-day form, because an active-hours window has to be able to say "until midnight".
 * No other hour above 23 is valid, and `"24:30"` is not.
 */
export function parseClock(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m || Number(m[2]) > 59 || Number(m[1]) > 24 || (Number(m[1]) === 24 && Number(m[2]) !== 0))
    throw new RangeError(`invalid clock time "${hhmm}", expected HH:MM from 00:00 to 24:00`);
  return Number(m[1]) * 60 + Number(m[2]);
}
