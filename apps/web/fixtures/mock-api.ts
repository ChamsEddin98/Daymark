/**
 * Fixture planner API for developing and testing apps/web without the real API.
 * Implements the subset of docs/API.md the daily view uses, with the same shapes
 * (including "Response details": `day.checked`, `currentTask`/`nextTask`, `progress.checkedMin`,
 * shift `dropped`/`day`, stretched rests, 409 on an empty shift):
 *   GET  /health, /today, /plan, /tracks, /events (SSE)
 *   POST /items/:key/status, /plan/shift, /plan/shift/preview, /plan/pause, /plan/resume
 *
 * Pause and resume (docs/PLAN.md P8): /health and /today carry `paused: { since, elapsedSec }|null`.
 * A pause moves nothing; a resume moves every item starting at or after the resume instant forward
 * by the exact elapsed milliseconds and reports `pausedSec` with its fractional part. While paused,
 * /plan/shift, /plan/shift/preview and /plan/regenerate answer 409 PAUSED; status changes still work.
 *
 * Run: npx tsx fixtures/mock-api.ts           (port 4317, or MOCK_PORT)
 *
 * Clock
 *   MOCK_NOW=2026-09-28T10:20:00+01:00   the clock starts there and then runs in real time
 *   ?now=<iso>                           on any request pins "now" for that request
 * Scenario (initial statuses), MOCK_SCENARIO:
 *   auto (default)  tasks that ended before now are done
 *   missed          like auto, but A9 is left unchecked (a missed task)
 *   fresh           nothing done
 *   alldone         every task done
 * Test controls (not part of the real API):
 *   POST /__mock/reset  { now?, scenario?, latencyMs?, failNext?, pausedAgoMs? }
 *   POST /__mock/pause  { agoMs }   backdates a pause, so a resume reports a known duration
 *   GET  /__mock/state  the raw item statuses (timeline and checked)
 *   MOCK_LATENCY=ms     delay added to every write (proves the UI is optimistic)
 *
 * Simplifications: tasks a minute/hour shift carries past midnight are counted but not
 * re-laid into tomorrow, and undoing a checked item appends it to the end of today.
 */
import http from "node:http";
import type { ItemStatus, PlanDay, PlanItem } from "../lib/types";

const PORT = Number(process.env.MOCK_PORT ?? 4317);
const OFFSET = "+01:00"; // Africa/Tunis, no DST
const OFFSET_MIN = 60;
const TZ = "Africa/Tunis";

type Scenario = "auto" | "missed" | "fresh" | "alldone";
type Day = PlanDay & { checked: PlanItem[] };

// ---------------------------------------------------------------- task catalogue (real titles from resources/*.md)
interface T { uid: string; track: string; title: string; min: number; type: string; links: { label: string; url: string }[] }
const lc = (label: string, slug: string) => ({ label, url: `https://leetcode.com/problems/${slug}/` });
const BCG: T[] = [
  { uid: "bcg/A7", track: "bcg", title: "A7 · Sorting", min: 40, type: "coding", links: [lc("620. Not Boring Movies", "not-boring-movies")] },
  { uid: "bcg/A8", track: "bcg", title: "A8 · Deduplication", min: 40, type: "coding", links: [lc("196. Delete Duplicate Emails", "delete-duplicate-emails")] },
  { uid: "bcg/A9", track: "bcg", title: "A9 · GroupBy → aggregate", min: 40, type: "coding", links: [lc("1693. Daily Leads and Partners", "daily-leads-and-partners")] },
  { uid: "bcg/A10", track: "bcg", title: "A10 · GroupBy → transform", min: 40, type: "coding", links: [lc("184. Department Highest Salary", "department-highest-salary")] },
  { uid: "bcg/A11", track: "bcg", title: "A11 · GroupBy → filter", min: 40, type: "coding", links: [lc("596. Classes More Than 5 Students", "classes-more-than-5-students")] },
  { uid: "bcg/A12", track: "bcg", title: "A12 · Ranking", min: 40, type: "coding", links: [lc("178. Rank Scores", "rank-scores")] },
  { uid: "bcg/A13", track: "bcg", title: "A13 · shift, lag and diff", min: 40, type: "coding", links: [lc("197. Rising Temperature", "rising-temperature")] },
  { uid: "bcg/A14", track: "bcg", title: "A14 · Rolling and cumulative windows", min: 40, type: "coding", links: [lc("1321. Restaurant Growth", "restaurant-growth")] },
  { uid: "bcg/A15", track: "bcg", title: "A15 · Join types", min: 40, type: "coding", links: [lc("183. Customers Who Never Order", "customers-who-never-order")] },
];
const LESSONS: T = { uid: "lessons/DAILY", track: "lessons", title: "AI engineering lessons", min: 120, type: "reading", links: [] };
const PORTFOLIO: T = { uid: "portfolio/DAILY", track: "portfolio", title: "Portfolio project", min: 60, type: "build", links: [] };
const isDaily = (uid?: string) => !!uid && uid.endsWith("/DAILY");

// ---- active hours (the owner's working window). The mock does not re-plan; it stores the setting,
// validates it the way the real API does, and reports an `effective` figure a test can pin.
const DEFAULT_HOURS = { dayStart: "08:00", dayEnd: "24:00", dailyTaskMin: 480, onMissed: "reflow" as "reflow" | "notify" };
let activeHours = { ...DEFAULT_HOURS };
let effectiveOverride: { dailyTaskMin: number | null; boundBy: "window" | "budget"; lastEnd: string | null } | null = null;

const clockMin = (v: unknown): number | null => {
  const m = typeof v === "string" ? /^([01]?\d|2[0-4]):([0-5]\d)$/.exec(v) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** The same refusals the real API makes, so the UI meets the same errors here. */
function checkHours(h: typeof DEFAULT_HOURS): string | null {
  const start = clockMin(h.dayStart);
  const end = clockMin(h.dayEnd);
  if (start === null) return `invalid clock time "${String(h.dayStart)}", expected HH:MM from 00:00 to 24:00`;
  if (end === null || end > 24 * 60) return `invalid clock time "${String(h.dayEnd)}", expected HH:MM from 00:00 to 24:00`;
  if (end <= start) return `dayEnd (${h.dayEnd}) must be after dayStart (${h.dayStart}); a window that wraps midnight is not supported`;
  if (end - start < 15) return `the active window ${h.dayStart}-${h.dayEnd} is ${end - start} min, too short for a task of 15 min`;
  if (!Number.isInteger(h.dailyTaskMin) || h.dailyTaskMin < 15 || h.dailyTaskMin > 1440)
    return `dailyTaskMin must be a whole number of minutes from 15 to 1440; got ${String(h.dailyTaskMin)}`;
  if (h.onMissed !== "reflow" && h.onMissed !== "notify") return `onMissed must be one of reflow, notify; got ${JSON.stringify(h.onMissed)}`;
  return null;
}

/**
 * What the window grants. The real API measures the materialized days; the mock computes the same
 * stepped cost analytically - a long rest for every 4 h of task time plus a short rest between the
 * tasks - which is enough for the UI to be exercised against the real shape of the answer.
 */
function settingsPayload() {
  if (effectiveOverride) return { activeHours, defaults: DEFAULT_HOURS, timeZone: TZ, effective: effectiveOverride };
  const start = clockMin(activeHours.dayStart)!;
  const room = clockMin(activeHours.dayEnd)! - start;
  const clockFor = (taskMin: number) => taskMin + 60 * Math.max(0, Math.ceil(taskMin / 240) - 1) + 10 * Math.max(0, Math.ceil(taskMin / 50) - 1);
  let granted = 0;
  for (let m = 15; m <= activeHours.dailyTaskMin; m += 5) if (clockFor(m) <= room) granted = m;
  const lastEnd = granted ? iso(anchorDate, start + clockFor(granted)) : null;
  return {
    activeHours,
    defaults: DEFAULT_HOURS,
    timeZone: TZ,
    effective: { dailyTaskMin: granted || null, boundBy: granted < activeHours.dailyTaskMin ? "window" : "budget", lastEnd },
  };
}

// ---------------------------------------------------------------- time helpers
const pad = (n: number) => String(n).padStart(2, "0");
function iso(date: string, min: number): string {
  return localIso(Date.parse(`${date}T00:00:00${OFFSET}`) + min * 60_000);
}
function localIso(epoch: number): string {
  const d = new Date(epoch + OFFSET_MIN * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${OFFSET}`;
}
/** Like localIso but keeping milliseconds: a pause instant is exact (docs/PLAN.md P8, rule 1). */
function localIsoMs(epoch: number): string {
  const d = new Date(epoch + OFFSET_MIN * 60_000);
  const base = localIso(epoch);
  return `${base.slice(0, 19)}.${String(d.getUTCMilliseconds()).padStart(3, "0")}${OFFSET}`;
}
const localDate = (epoch: number) => localIso(epoch).slice(0, 10);
const addDays = (date: string, n: number) => localDate(Date.parse(`${date}T12:00:00${OFFSET}`) + n * 86_400_000);
const plusMs = (isoStr: string, ms: number) => localIso(Date.parse(isoStr) + ms);
const mins = (i: PlanItem) => (Date.parse(i.end) - Date.parse(i.start)) / 60_000;

// ---------------------------------------------------------------- plan builder (follows PLAN.md rules)
/**
 * Day 0 (the fixture's "today") starts with A7's carried-over part 2/2, so A13 lands across the
 * 4-hour mark and is split around the long rest. Later days continue the BCG queue.
 */
function buildDay(date: string, dayIndex: number): Day {
  type Seg = { t: T; min: number; part?: { index: number; total: number } };
  const prepBudget = 480 - LESSONS.min - PORTFOLIO.min; // 300
  const prep: Seg[] = [];
  if (dayIndex <= 0) {
    prep.push({ t: BCG[0]!, min: 20, part: { index: 2, total: 2 } });
    for (const t of BCG.slice(1, 8)) prep.push({ t, min: t.min });
  } else {
    const q = [...BCG.slice(8), ...BCG.slice(0, 8)];
    let used = 0;
    for (const t of q) { if (used + t.min > prepBudget) break; prep.push({ t, min: t.min }); used += t.min; }
  }
  const segs: Seg[] = [...prep, { t: LESSONS, min: LESSONS.min }, { t: PORTFOLIO, min: PORTFOLIO.min }];

  const laid: (Seg | "long")[] = [];
  let taskMin = 0;
  for (const s of segs) {
    if (taskMin < 240 && taskMin + s.min > 240) {
      const a = 240 - taskMin;
      laid.push({ ...s, min: a, part: { index: 1, total: 2 } }, "long", { ...s, min: s.min - a, part: { index: 2, total: 2 } });
    } else {
      laid.push(s);
      if (taskMin + s.min === 240) laid.push("long");
    }
    taskMin += s.min;
  }

  const items: PlanItem[] = [];
  let t = 8 * 60;
  let restN = 0;
  laid.forEach((s, i) => {
    if (s === "long") {
      restN++;
      items.push({ key: `${date}|rest|${restN}`, date, kind: "rest", restKind: "long", title: "Long rest", start: iso(date, t), end: iso(date, t + 60), status: "pending" });
      t += 60;
      return;
    }
    if (i > 0 && laid[i - 1] !== "long") {
      restN++;
      items.push({ key: `${date}|rest|${restN}`, date, kind: "rest", restKind: "short", title: "Rest", start: iso(date, t), end: iso(date, t + 10), status: "pending" });
      t += 10;
    }
    const idx = s.part ? s.part.index : 1;
    items.push({
      key: `${date}|${s.t.uid}|${idx}`, date, kind: "task", taskUid: s.t.uid, track: s.t.track,
      title: s.part ? `${s.t.title} (part ${s.part.index}/${s.part.total})` : s.t.title,
      ...(s.part ? { part: s.part } : {}),
      links: s.t.links.map((l) => ({ ...l })), type: s.t.type,
      start: iso(date, t), end: iso(date, t + s.min), status: "pending",
    });
    t += s.min;
  });
  return { date, items, checked: [] };
}

// ---------------------------------------------------------------- state
let clockBase = { real: Date.now(), mock: process.env.MOCK_NOW ? Date.parse(process.env.MOCK_NOW) : Date.now() };
let latencyMs = Number(process.env.MOCK_LATENCY ?? 0);
let failNext = 0;
let anchorDate = localDate(clockBase.mock);
let days = new Map<string, Day>();
/** Days emptied by a shift of N > 1 days. */
let daysOff = new Set<string>();
/** Epoch ms the plan was paused at, or null when it is running. Survives everything but a reset. */
let pausedSince: number | null = null;
const MAX_PAUSE_MS = 24 * 3_600_000;

function nowEpoch(url?: URL): number {
  const q = url?.searchParams.get("now");
  if (q && !Number.isNaN(Date.parse(q))) return Date.parse(q);
  return clockBase.mock + (Date.now() - clockBase.real);
}
function getDay(date: string, store = days): Day {
  let d = store.get(date);
  if (!d) {
    const idx = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${anchorDate}T12:00:00Z`)) / 86_400_000);
    d = daysOff.has(date) ? { date, items: [], checked: [] } : buildDay(date, idx);
    store.set(date, d);
  }
  return d;
}
function reset(opts: { now?: string; scenario?: Scenario; latencyMs?: number; failNext?: number; pausedAgoMs?: number } = {}) {
  if (opts.now) clockBase = { real: Date.now(), mock: Date.parse(opts.now) };
  if (opts.latencyMs !== undefined) latencyMs = opts.latencyMs;
  failNext = opts.failNext ?? 0;
  anchorDate = localDate(clockBase.mock);
  days = new Map();
  daysOff = new Set();
  pausedSince = opts.pausedAgoMs !== undefined ? nowEpoch() - opts.pausedAgoMs : null;
  const scenario: Scenario = opts.scenario ?? (process.env.MOCK_SCENARIO as Scenario) ?? "auto";
  const today = getDay(anchorDate);
  for (let i = 1; i < 7; i++) getDay(addDays(anchorDate, i)); // materialize a 7-day horizon
  const now = nowEpoch();
  for (const it of today.items) {
    if (it.kind !== "task") continue;
    const past = Date.parse(it.end) <= now;
    if (scenario === "alldone" || ((scenario === "auto" || scenario === "missed") && past)) {
      if (scenario === "missed" && it.taskUid === "bcg/A9") continue;
      setStatusOn(it, "done");
    }
  }
}

reset();

function setStatusOn(it: PlanItem, status: ItemStatus) {
  if (!it.plannedStart) {
    it.plannedStart = it.start;
    it.plannedEnd = it.end;
  }
  it.status = status;
}

function findItem(key: string): { day: Day; item: PlanItem; where: "items" | "checked" } | undefined {
  for (const d of days.values()) {
    for (const it of d.items) if (it.key === key) return { day: d, item: it, where: "items" };
    for (const it of d.checked) if (it.key === key) return { day: d, item: it, where: "checked" };
  }
  return undefined;
}

/** A checked item leaves the timeline: it shows its original slot and remembers its last one. */
function toChecked(it: PlanItem): PlanItem {
  return {
    ...it,
    lastStart: it.start,
    lastEnd: it.end,
    start: it.plannedStart ?? it.start,
    end: it.plannedEnd ?? it.end,
  };
}

/** Rests exist only between tasks: trim rests at the ends, merge consecutive rests. */
function tidy(items: PlanItem[]): PlanItem[] {
  const out: PlanItem[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.kind === "rest" && (!prev || prev.kind === "rest")) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1]!.kind === "rest") out.pop();
  return out;
}

/** Rest keys are numbered from 1 in chronological order on each date. */
function renumberRests(d: Day) {
  let n = 0;
  for (const it of d.items) if (it.kind === "rest") it.key = `${d.date}|rest|${++n}`;
}

// ---------------------------------------------------------------- shift (PLAN.md rules)
interface ShiftBody { amount: number; unit: "minutes" | "hours" | "days" }
class Conflict extends Error {}

function shift(body: ShiftBody, now: number, store: Map<string, Day>, off: Set<string>) {
  const date = localDate(now);
  const today = getDay(date, store);
  let moved = 0;
  let carried = 0;
  let dropped = 0;
  const regenerated: string[] = [];

  if (body.unit === "days") {
    const later = [...store.keys()].filter((d) => d > date).sort();
    const ahead = today.items.filter((i) => Date.parse(i.start) >= now);
    if (!ahead.length && !later.some((d) => store.get(d)!.items.length)) throw new Conflict("Nothing in the plan starts after now");
    const offsetMs = body.amount * 86_400_000;
    const rekey = (it: PlanItem, from: string, to: string): PlanItem => ({
      ...it, date: to, key: it.key.replace(`${from}|`, `${to}|`),
      start: plusMs(it.start, offsetMs), end: plusMs(it.end, offsetMs),
    });
    // later days move first (from the end), then today's remainder
    const next = new Map<string, Day>([[date, today]]);
    for (const d of later) {
      const src = store.get(d)!;
      const to = addDays(d, body.amount);
      next.set(to, { date: to, items: src.items.map((i) => rekey(i, d, to)), checked: [] });
      moved += src.items.length;
      regenerated.push(to);
      // checked items stay on their date
      if (src.checked.length) {
        const keep = next.get(d) ?? { date: d, items: [], checked: [] };
        keep.checked.push(...src.checked);
        next.set(d, keep);
      }
    }
    const to = addDays(date, body.amount);
    const target = next.get(to) ?? { date: to, items: [], checked: [] };
    const movedToday: PlanItem[] = [];
    const keep: PlanItem[] = [];
    for (const it of today.items) {
      if (Date.parse(it.start) < now) { keep.push(it); continue; }
      if (it.kind === "task" && it.status !== "pending") today.checked.push(toChecked(it));
      else { movedToday.push(rekey(it, date, to)); moved++; }
    }
    target.items = tidy([...movedToday, ...target.items]);
    next.set(to, target);
    for (let i = 1; i < body.amount; i++) {
      const d = addDays(date, i);
      off.add(d);
      if (!next.has(d)) next.set(d, { date: d, items: [], checked: [] });
    }
    today.items = tidy(keep);
    store.clear();
    for (const [k, v] of next) { renumberRests(v); store.set(k, v); }
    regenerated.unshift(...Array.from({ length: body.amount }, (_, i) => addDays(date, i + 1)).filter((d) => !regenerated.includes(d)));
  } else {
    const ms = body.amount * (body.unit === "hours" ? 3_600_000 : 60_000);
    const midnight = Date.parse(`${addDays(date, 1)}T00:00:00${OFFSET}`);
    if (!today.items.some((i) => Date.parse(i.start) >= now)) throw new Conflict("Nothing of today starts at or after now");
    const keep: PlanItem[] = [];
    for (const it of today.items) {
      const s = Date.parse(it.start);
      if (s < now) { keep.push(it); continue; }
      const ns = s + ms;
      if (ns >= midnight) {
        if (it.kind === "task") {
          if (it.status !== "pending") today.checked.push(toChecked(it));
          else if (isDaily(it.taskUid)) dropped++;
          else carried++;
        }
        continue;
      }
      keep.push({ ...it, start: localIso(ns), end: plusMs(it.end, ms) });
      moved++;
    }
    // The gap opened after the item in progress becomes rest time (rests are stretched).
    const firstMoved = keep.findIndex((i) => Date.parse(i.start) >= now + ms && Date.parse(i.start) - ms >= now);
    if (firstMoved > 0) {
      const prev = keep[firstMoved - 1]!;
      const cur = keep[firstMoved]!;
      if (cur.kind === "rest") keep[firstMoved] = { ...cur, start: prev.end };
      else if (prev.kind === "rest") keep[firstMoved - 1] = { ...prev, end: cur.start };
    }
    today.items = tidy(keep);
    renumberRests(today);
    if (carried || dropped) regenerated.push(addDays(date, 1));
  }
  const last = today.items[today.items.length - 1];
  return { moved, carried, dropped, regenerated, endOfDay: last ? last.end : null, day: today };
}

/**
 * A resume. The cut point is the **pause** instant, not the resume instant (docs/API.md): every item
 * whose start is at or after the moment you paused moves forward by exactly `deltaMs`, so nothing
 * that had not begun when you paused is allowed to run while you were away. Durations, order and the
 * gaps between moved items are preserved, so the 10-minute rests and the 240 -> 60-minute long rest
 * survive untouched. The gap the pause opened before the first moved item becomes rest time, under
 * the existing gap-to-rest rule. A pause that crossed local midnight is cut at midnight instead,
 * because the cut has to be inside the current day.
 */
function resumeShift(deltaMs: number, now: number, pausedAt: number) {
  const date = localDate(now);
  const today = getDay(date);
  const midnight = Date.parse(`${addDays(date, 1)}T00:00:00${OFFSET}`);
  const startOfToday = Date.parse(`${date}T00:00:00${OFFSET}`);
  const cut = Math.max(pausedAt, startOfToday);
  let moved = 0;
  let carried = 0;
  const keep: PlanItem[] = [];
  for (const it of today.items) {
    const st = Date.parse(it.start);
    if (st < cut) {
      keep.push(it);
      continue;
    }
    const ns = st + deltaMs;
    if (ns >= midnight) {
      if (it.kind === "task") {
        if (it.status !== "pending") today.checked.push(toChecked(it));
        else carried++;
      }
      continue;
    }
    keep.push({ ...it, start: localIsoMs(ns), end: localIsoMs(Date.parse(it.end) + deltaMs) });
    moved++;
  }
  const firstMoved = keep.findIndex((i) => Date.parse(i.start) >= cut + deltaMs);
  if (firstMoved > 0) {
    const prev = keep[firstMoved - 1]!;
    const cur = keep[firstMoved]!;
    if (cur.kind === "rest") keep[firstMoved] = { ...cur, start: prev.end };
    else if (prev.kind === "rest") keep[firstMoved - 1] = { ...prev, end: cur.start };
  }
  today.items = tidy(keep);
  renumberRests(today);
  const last = today.items[today.items.length - 1];
  return { moved, carried, endOfDay: last ? last.end : null, day: today };
}

// ---------------------------------------------------------------- read payloads
/** `{ since, elapsedSec } | null` — the shape /health and /today both carry. */
function pausedPayload(now: number) {
  if (pausedSince === null) return null;
  return { since: localIsoMs(pausedSince), elapsedSec: Math.max(0, (now - pausedSince) / 1000) };
}

function todayPayload(now: number) {
  const date = localDate(now);
  const day = getDay(date);
  /**
   * While the pause is enforced the plan is frozen, so "what is on now" is read at the pause
   * instant rather than allowed to advance. A stale pause (> 24 h) no longer holds the plan, so it
   * no longer holds these either.
   */
  const enforced = pausedSince !== null && now - pausedSince <= MAX_PAUSE_MS;
  const at = enforced ? pausedSince! : now;
  const cur = day.items.find((i) => Date.parse(i.start) <= at && at < Date.parse(i.end)) ?? null;
  const next = day.items.find((i) => Date.parse(i.start) > at) ?? null;
  const currentTask = cur && cur.kind === "task" && cur.status === "pending" ? cur : null;
  const nextTask = day.items.find((i) => i.kind === "task" && i.status === "pending" && Date.parse(i.start) > at) ?? null;
  const tasks = [...day.items.filter((i) => i.kind === "task"), ...day.checked];
  const checkedMin = day.checked.reduce((a, t) => a + mins(t), 0);
  let upcoming: { date: string; firstTitle: string } | null = null;
  for (let i = 1; i <= 30 && !upcoming; i++) {
    const d = getDay(addDays(date, i));
    const first = d.items.find((x) => x.kind === "task");
    if (first) upcoming = { date: d.date, firstTitle: first.title };
  }
  return {
    date,
    now: localIso(now),
    paused: pausedPayload(now),
    day,
    current: cur,
    next,
    currentTask,
    nextTask,
    progress: {
      done: tasks.filter((t) => t.status !== "pending").length,
      total: tasks.length,
      taskMinDone: tasks.filter((t) => t.status !== "pending").reduce((a, t) => a + mins(t), 0),
      taskMinTotal: tasks.reduce((a, t) => a + mins(t), 0),
      checkedMin,
    },
    upcoming,
  };
}

function tracksPayload() {
  const all = [...days.values()].flatMap((d) => [...d.items, ...d.checked]).filter((i) => i.kind === "task");
  const doneUids = new Set(all.filter((i) => i.status === "done" && (!i.part || i.part.index === i.part.total)).map((i) => i.taskUid));
  const bcgDone = 6 + BCG.filter((t) => doneUids.has(t.uid)).length; // SKIP + A1..A6 done before the fixture day
  const today = getDay(localDate(nowEpoch()));
  const has = (track: string) => today.items.some((i) => i.track === track);
  return {
    tracks: [
      { track: "bcg", kind: "prep", priority: 1, title: "BCG X AI Engineer — Assessment Prep Plan", total: 58, done: bcgDone, skipped: 0, remainingMin: (58 - bcgDone) * 38, active: has("bcg") },
      { track: "salesforce", kind: "prep", priority: 2, title: "Salesforce FDE coding screen", total: 34, done: 0, skipped: 0, remainingMin: 34 * 45, active: has("salesforce") },
      { track: "anthropic", kind: "prep", priority: 3, title: "Anthropic prep", total: 30, done: 0, skipped: 0, remainingMin: 30 * 50, active: has("anthropic") },
      { track: "lessons", kind: "lessons", title: "AI engineering lessons", total: 1, done: doneUids.has(LESSONS.uid) ? 1 : 0, skipped: 0, remainingMin: 120, active: has("lessons") },
      { track: "portfolio", kind: "portfolio", title: "Portfolio project", total: 1, done: doneUids.has(PORTFOLIO.uid) ? 1 : 0, skipped: 0, remainingMin: 60, active: has("portfolio") },
      { track: "apply", kind: "recurring", title: "Apply for positions", total: 1, done: 0, skipped: 0, remainingMin: 30, active: has("apply") },
    ],
  };
}

// ---------------------------------------------------------------- SSE
const clients = new Set<http.ServerResponse>();
function publish(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
setInterval(() => { for (const c of clients) c.write(`: heartbeat\n\n`); }, 15_000).unref();

// ---------------------------------------------------------------- http
function send(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function error(res: http.ServerResponse, code: number, c: string, message: string, hint = "") {
  send(res, code, { error: { code: c, message, hint } });
}
async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return undefined; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function validShift(b: any): b is ShiftBody {
  return b && typeof b.amount === "number" && Number.isFinite(b.amount) && b.amount > 0 && ["minutes", "hours", "days"].includes(b.unit);
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", req.headers.origin ?? "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const now = nowEpoch(url);
  const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/settings") return send(res, 200, settingsPayload());
    if (req.method === "PATCH" && p === "/settings") {
      for (const k of url.searchParams.keys())
        if (k !== "dryRun" && k !== "now") return error(res, 400, "INVALID_INPUT", `unknown query parameter "${k}"`, "This endpoint takes ?dryRun.");
      const body = (await readBody(req)) ?? {};
      const next = { ...activeHours };
      for (const [k, v] of Object.entries(body)) {
        if (!(k in next)) return error(res, 400, "INVALID_INPUT", `unknown setting "${k}"`, "Active hours are dayStart, dayEnd, dailyTaskMin.");
        (next as Record<string, unknown>)[k] = k === "dailyTaskMin" ? Number(v) : v;
      }
      const bad = checkHours(next);
      if (bad) return error(res, 400, "INVALID_INPUT", bad, "dayStart and dayEnd are HH:MM (dayEnd may be 24:00), and dailyTaskMin is whole minutes.");
      if (url.searchParams.get("dryRun") === "true") return send(res, 200, { activeHours: next, regenerated: [anchorDate], dryRun: true, sync: "skipped" });
      const changed = JSON.stringify(next) !== JSON.stringify(activeHours);
      activeHours = next;
      if (changed) publish("plan", { dates: [anchorDate], reason: "settings" });
      return send(res, 200, { activeHours: next, regenerated: changed ? [anchorDate] : [], changed, sync: changed ? "queued" : "skipped" });
    }
    if (req.method === "GET" && p === "/health") {
      return send(res, 200, { ok: true, version: "mock-3", now: localIso(now), timeZone: TZ, tasksLoaded: BCG.length + 2, paused: pausedPayload(now), calendar: { authorized: false, lastSyncAt: null, lastError: null, pending: false } });
    }
    if (req.method === "GET" && p === "/today") return send(res, 200, todayPayload(now));
    if (req.method === "GET" && p === "/tracks") return send(res, 200, tracksPayload());
    if (req.method === "GET" && p === "/plan") {
      const from = url.searchParams.get("from") ?? localDate(now);
      const n = Number(url.searchParams.get("days") ?? 7);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isInteger(n) || n < 1 || n > 120) return error(res, 400, "INVALID_INPUT", "from must be YYYY-MM-DD and days 1..120", "e.g. /plan?from=2026-09-28&days=7");
      return send(res, 200, { days: Array.from({ length: n }, (_, i) => getDay(addDays(from, i))) });
    }
    if (req.method === "GET" && p === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`: connected\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const m = p.match(/^\/items\/(.+)\/status$/);
    if (req.method === "POST" && m) {
      const key = decodeURIComponent(m[1]!);
      const body = await readBody(req);
      if (latencyMs) await sleep(latencyMs);
      if (failNext > 0) { failNext--; return error(res, 500, "INTERNAL", "Injected failure", "Mock failNext"); }
      const status = body?.status as ItemStatus;
      if (!["done", "pending", "skipped"].includes(status)) return error(res, 400, "INVALID_INPUT", "status must be done, pending or skipped", "Send { \"status\": \"done\" }");
      const found = findItem(key);
      if (!found) return error(res, 404, "UNKNOWN_ITEM", `No item ${key}`, "GET /today lists today's keys");
      const { day, item, where } = found;
      if (item.kind === "rest") return error(res, 409, "CONFLICT", "Rest items have no status", "Pick a task item");
      const regenerated = [addDays(item.date, 1)];
      if (where === "checked" && status === "pending") {
        // undo on a checked item: remove it and re-plan the task at the end of its day
        day.checked = day.checked.filter((i) => i.key !== key);
        const last = day.items[day.items.length - 1];
        const startMs = Math.max(last ? Date.parse(last.end) + 10 * 60_000 : now, now);
        const len = Date.parse(item.end) - Date.parse(item.start);
        const midnight = Date.parse(`${addDays(day.date, 1)}T00:00:00${OFFSET}`);
        let replannedItem: PlanItem | null = null;
        if (startMs + len <= midnight) {
          const { plannedStart, plannedEnd, lastStart, lastEnd, ...rest } = item;
          void plannedStart; void plannedEnd; void lastStart; void lastEnd;
          replannedItem = { ...rest, status: "pending", start: localIso(startMs), end: localIso(startMs + len) };
          if (last) day.items.push({ key: "", date: day.date, kind: "rest", restKind: "short", title: "Rest", status: "pending", start: last.end, end: localIso(startMs) });
          day.items.push(replannedItem);
          renumberRests(day);
        }
        publish("status", { key, taskUid: item.taskUid, date: item.date, status });
        publish("plan", { dates: [item.date, ...regenerated], reason: "status" });
        return send(res, 200, { item: replannedItem, regenerated, replanned: true });
      }
      setStatusOn(item, status);
      publish("status", { key, taskUid: item.taskUid, date: item.date, status });
      publish("plan", { dates: [item.date, ...regenerated], reason: "status" });
      return send(res, 200, { item, regenerated });
    }
    if (req.method === "POST" && p === "/plan/pause") {
      if (latencyMs) await sleep(latencyMs);
      if (failNext > 0) { failNext--; return error(res, 500, "INTERNAL", "Injected failure", "Mock failNext"); }
      if (pausedSince !== null) {
        return send(res, 409, {
          error: {
            code: "CONFLICT",
            message: `the plan is already paused since ${localIsoMs(pausedSince)}`,
            hint: "POST /plan/resume shifts the plan by the elapsed time and clears the pause",
            details: { paused: pausedPayload(now) },
          },
        });
      }
      pausedSince = now;
      // A pause moves nothing, so it publishes the state with no dates and queues no calendar sync.
      publish("plan", { dates: [], reason: "pause", paused: pausedPayload(now) });
      return send(res, 200, { paused: { since: localIsoMs(pausedSince) } });
    }
    if (req.method === "POST" && p === "/plan/resume") {
      if (latencyMs) await sleep(latencyMs);
      if (failNext > 0) { failNext--; return error(res, 500, "INTERNAL", "Injected failure", "Mock failNext"); }
      if (pausedSince === null) {
        return send(res, 409, {
          error: {
            code: "CONFLICT",
            message: "the plan is not paused, so there is nothing to resume",
            hint: "POST /plan/pause freezes the plan; GET /health and GET /today report the pause.",
            details: { paused: null },
          },
        });
      }
      const deltaMs = Math.max(0, now - pausedSince);
      if (deltaMs > MAX_PAUSE_MS) {
        // The pause stays in place, so nothing is lost (PLAN.md P8, rule 7).
        const days = Math.max(1, Math.ceil(deltaMs / 86_400_000));
        return error(
          res,
          400,
          "INVALID_INPUT",
          `the pause has run for ${(deltaMs / 3_600_000).toFixed(1)} h, which is longer than the 24 h a resume may move the plan`,
          `Shift whole days instead ({ "amount": ${days}, "unit": "days" }); that clears the pause. The pause is kept until then, so nothing is lost.`,
        );
      }
      const r = resumeShift(deltaMs, now, pausedSince);
      pausedSince = null;
      publish("plan", { dates: [localDate(now)], reason: "resume", paused: null });
      return send(res, 200, { pausedSec: deltaMs / 1000, moved: r.moved, carried: r.carried, endOfDay: r.endOfDay, day: r.day });
    }
    if (req.method === "POST" && (p === "/plan/shift" || p === "/plan/shift/preview" || p === "/plan/regenerate")) {
      if (pausedSince !== null && now - pausedSince <= MAX_PAUSE_MS) {
        return send(res, 409, {
          error: {
            code: "PAUSED",
            message: "The plan is paused, so it cannot be moved",
            hint: "POST /plan/resume first — it already moves everything forward by the pause.",
            details: { paused: pausedPayload(now) },
          },
        });
      }
    }
    if (req.method === "POST" && (p === "/plan/shift" || p === "/plan/shift/preview")) {
      const body = await readBody(req);
      if (!validShift(body)) return error(res, 400, "INVALID_INPUT", "amount must be > 0 and unit one of minutes, hours, days", 'Send a whole number, e.g. { "amount": 30, "unit": "minutes" }.');
      const commit = p === "/plan/shift";
      if (commit && latencyMs) await sleep(latencyMs);
      const store = commit ? days : structuredClone(days);
      const off = commit ? daysOff : new Set(daysOff);
      try {
        const r = shift(body, now, store, off);
        if (commit && pausedSince !== null) pausedSince = null; // a stale pause is cleared by a shift
        if (commit) publish("plan", { dates: [localDate(now), ...r.regenerated], reason: "shift" });
        return send(res, 200, r);
      } catch (e) {
        if (e instanceof Conflict) return error(res, 409, "CONFLICT", e.message, "Nothing left to shift");
        throw e;
      }
    }
    // ---- test controls
    if (req.method === "POST" && p === "/__mock/reset") {
      const body = (await readBody(req)) ?? {};
      reset(body);
      publish("plan", { dates: [anchorDate], reason: "external" });
      return send(res, 200, { ok: true, now: localIso(nowEpoch()), anchorDate });
    }
    if (req.method === "POST" && p === "/__mock/pause") {
      const body = (await readBody(req)) ?? {};
      pausedSince = now - Number(body.agoMs ?? 0);
      publish("plan", { dates: [], reason: "pause", paused: pausedPayload(now) });
      return send(res, 200, { paused: pausedPayload(now) });
    }
    if (req.method === "POST" && p === "/__mock/settings") {
      const body = (await readBody(req)) ?? {};
      activeHours = { ...activeHours, ...(body.activeHours as object) };
      if (body.effective !== undefined) effectiveOverride = body.effective as typeof effectiveOverride;
      return send(res, 200, settingsPayload());
    }
    if (req.method === "GET" && p === "/__mock/state") {
      const statuses: Record<string, ItemStatus> = {};
      const checked: string[] = [];
      for (const d of days.values()) {
        for (const it of d.items) if (it.kind === "task") statuses[it.key] = it.status;
        for (const it of d.checked) { statuses[it.key] = it.status; checked.push(it.key); }
      }
      return send(res, 200, { now: localIso(now), statuses, checked, paused: pausedPayload(now) });
    }
    return error(res, 404, "NOT_FOUND", `${req.method} ${p} is not part of the API`, "See docs/API.md");
  } catch (e) {
    return error(res, 500, "INTERNAL", String(e), "Mock failure");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock planner API on http://127.0.0.1:${PORT}  now=${localIso(nowEpoch())}`);
});
