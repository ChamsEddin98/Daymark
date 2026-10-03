/**
 * Injectable clock shared by the API and the daemon.
 *
 * - `PLANNER_NOW=2026-09-28T10:15:00+02:00`         fixed instant (never advances)
 * - `PLANNER_CLOCK=start=2026-09-28T07:59:00,speed=600`  compressed clock: starts at `start` when the
 *   process starts and runs `speed` times faster than real time. A `start` without an offset is read
 *   as wall time in the planner's time zone.
 * - neither: the system clock.
 */
import { zonedMs } from "@planner/core";

export interface Clock {
  /** Epoch ms. */
  now(): number;
  readonly kind: "system" | "fixed" | "compressed" | "manual";
  /** Clock speed relative to real time (1 = real, 0 = frozen). Timers should divide real delays by it. */
  readonly speed: number;
}

export interface ManualClock extends Clock {
  set(t: string | number | Date): void;
  advance(ms: number): void;
}

export const systemClock: Clock = { now: () => Date.now(), kind: "system", speed: 1 };

/** Parse an ISO instant; a value without an offset / "Z" is local wall time in `timeZone`. */
export function parseLocalInstant(value: string, timeZone: string): number {
  const v = value.trim();
  const hasOffset = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(v);
  if (hasOffset) {
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new Error(`invalid instant "${value}"`);
    return t;
  }
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(v);
  if (!m) throw new Error(`invalid instant "${value}" (expected YYYY-MM-DDTHH:MM[:SS][offset])`);
  const minute = Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return zonedMs(m[1]!, minute, timeZone) + Number(m[4] ?? 0) * 1000 + Number((m[5] ?? "0").padEnd(3, "0"));
}

export function fixedClock(at: string | number | Date, timeZone = systemTimeZone()): ManualClock {
  let t = toMs(at, timeZone);
  return {
    now: () => t,
    kind: "manual",
    speed: 0,
    set: (v) => {
      t = toMs(v, timeZone);
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export function compressedClock(start: string | number | Date, speed: number, timeZone = systemTimeZone(), realNow = () => Date.now()): Clock {
  if (!(speed > 0) || !Number.isFinite(speed)) throw new Error(`clock speed must be a positive number, got ${speed}`);
  const s = toMs(start, timeZone);
  const r0 = realNow();
  return { now: () => s + (realNow() - r0) * speed, kind: "compressed", speed };
}

/** Clock from PLANNER_NOW / PLANNER_CLOCK (see file header), else the system clock. */
export function clockFromEnv(env: Record<string, string | undefined> = process.env, timeZone = timeZoneFromEnv(env)): Clock {
  if (env.PLANNER_NOW) {
    const c = fixedClock(env.PLANNER_NOW, timeZone);
    return { now: c.now, kind: "fixed", speed: 0 };
  }
  if (env.PLANNER_CLOCK) {
    const parts = Object.fromEntries(
      env.PLANNER_CLOCK.split(",").map((p) => {
        const i = p.indexOf("=");
        return i < 0 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
      }),
    );
    if (!parts.start) throw new Error(`PLANNER_CLOCK needs start=...: "${env.PLANNER_CLOCK}"`);
    return compressedClock(parts.start, parts.speed ? Number(parts.speed) : 1, timeZone);
  }
  return systemClock;
}

export const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** PLANNER_TZ (validated IANA name) else the system zone. */
export function timeZoneFromEnv(env: Record<string, string | undefined> = process.env): string {
  const tz = env.PLANNER_TZ?.trim();
  if (!tz) return systemTimeZone();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`PLANNER_TZ="${tz}" is not a valid IANA time zone`);
  }
  return tz;
}

function toMs(v: string | number | Date, timeZone: string): number {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  return parseLocalInstant(v, timeZone);
}
