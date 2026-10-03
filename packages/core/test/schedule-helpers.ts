import { expect } from "vitest";
import {
  DEFAULT_CONFIG,
  localMinute,
  parseClock,
  type FileKind,
  type PlanDay,
  type PlanItem,
  type Task,
  type TaskFile,
  type TaskType,
} from "../src/index.ts";

export const TZ = "Africa/Tunis";
export const MIN_PART = DEFAULT_CONFIG.minPartMin!;
export const ms = (iso: string) => Date.parse(iso);
export const mins = (it: PlanItem) => (ms(it.end) - ms(it.start)) / 60_000;
export const hhmm = (iso: string) => iso.slice(11, 16);
export const tasksOf = (d: PlanDay) => d.items.filter((i) => i.kind === "task");

export interface InvariantOpts {
  timeZone?: string;
  /** First item must start at dayStart (default true). Off for a partly shifted day. */
  strictStart?: boolean;
  /** Allow idle time between items (after a minutes shift). Rest lengths stay exact. */
  allowGaps?: boolean;
  /** Task minutes already done earlier that day (a day that received a shifted remainder). */
  taskMinBefore?: number;
  /** Today after a shift may end with the rest that is in progress. */
  allowTrailingRest?: boolean;
  /** Today after a minutes/hours shift: a rest may be stretched over the time the shift opened. */
  stretchedRests?: boolean;
  /**
   * The active hours the day was generated with, when they are not the defaults. The rest rules
   * never change, but how much a day may hold and when it may run do - so a test that sets them has
   * to say so here, instead of this helper assuming 08:00 and 480.
   */
  dayStart?: string;
  dayEnd?: string;
  dailyTaskMin?: number;
}

/** The hard rest rules, checked item by item. */
export function assertDayInvariants(day: PlanDay, opts: InvariantOpts = {}): void {
  const { blockMin, shortRestMin, longRestMin } = DEFAULT_CONFIG;
  const dayStart = opts.dayStart ?? DEFAULT_CONFIG.dayStart;
  const dayEnd = opts.dayEnd ?? DEFAULT_CONFIG.dayEnd;
  const dailyTaskMin = opts.dailyTaskMin ?? DEFAULT_CONFIG.dailyTaskMin;
  const tz = opts.timeZone ?? TZ;
  const where = (it: PlanItem) => `${day.date} ${it.key} ${hhmm(it.start)}-${hhmm(it.end)} "${it.title}"`;
  const items = day.items;
  if (!items.length) return;

  expect(new Set(items.map((i) => i.key)).size, `${day.date}: keys unique`).toBe(items.length);
  for (const it of items) {
    expect(it.date, where(it)).toBe(day.date);
    expect(it.key.startsWith(`${day.date}|`), `${where(it)}: key carries date`).toBe(true);
    expect(mins(it), `${where(it)}: positive length`).toBeGreaterThan(0);
    // Fractional seconds appear only after an exact (ms) shift - a resume (P8).
    expect(it.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?[+-]\d{2}:\d{2}$/);
  }
  if (opts.strictStart !== false) expect(localMinute(ms(items[0]!.start), tz), `${day.date}: starts at ${dayStart}`).toBe(parseClock(dayStart));
  // Never before the window opens, and never past where it closes (P-active-hours).
  expect(localMinute(ms(items[0]!.start), tz), `${day.date}: not before ${dayStart}`).toBeGreaterThanOrEqual(parseClock(dayStart));
  const endMin = localMinute(ms(items.at(-1)!.end), tz);
  expect(endMin === 0 ? 1440 : endMin, `${day.date}: ends by ${dayEnd}`).toBeLessThanOrEqual(parseClock(dayEnd));
  expect(items[0]!.kind, `${day.date}: no leading rest`).toBe("task");
  if (!opts.allowTrailingRest) expect(items.at(-1)!.kind, `${day.date}: no trailing rest`).toBe("task");

  let taskMin = opts.taskMinBefore ?? 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const prev = items[i - 1];
    if (prev) {
      const gap = (ms(it.start) - ms(prev.end)) / 60_000;
      expect(gap, `${where(it)}: no overlap`).toBeGreaterThanOrEqual(0);
      if (!opts.allowGaps) expect(gap, `${where(it)}: contiguous`).toBe(0);
      expect(prev.kind === "rest" && it.kind === "rest", `${where(it)}: two rests in a row`).toBe(false);
      expect(prev.kind === "task" && it.kind === "task", `${where(it)}: tasks need a rest between them`).toBe(false);
    }
    if (it.kind === "rest") {
      const atMark = taskMin > 0 && taskMin % blockMin === 0;
      if (atMark) {
        expect(it.restKind, `${where(it)}: long rest after ${taskMin} min`).toBe("long");
        if (opts.stretchedRests) expect(mins(it), where(it)).toBeGreaterThanOrEqual(longRestMin);
        else expect(mins(it), where(it)).toBe(longRestMin);
        expect(it.title).toBe("Long rest");
      } else {
        expect(it.restKind, `${where(it)}: short rest at ${taskMin} min`).toBe("short");
        if (opts.stretchedRests) expect(mins(it), where(it)).toBeGreaterThanOrEqual(shortRestMin);
        else expect(mins(it), where(it)).toBe(shortRestMin);
        expect(it.title).toBe("Rest");
      }
    } else {
      const block = Math.floor(taskMin / blockMin);
      taskMin += mins(it);
      expect(Math.ceil(taskMin / blockMin) - 1, `${where(it)}: does not cross the ${blockMin}-min mark`).toBeLessThanOrEqual(block);
      if (it.part) {
        expect(it.title.endsWith(` (part ${it.part.index}/${it.part.total})`), where(it)).toBe(true);
        expect(mins(it), `${where(it)}: part >= ${MIN_PART} min`).toBeGreaterThanOrEqual(MIN_PART);
      }
      else expect(it.title).not.toMatch(/\(part \d+\/\d+\)$/);
    }
  }
  expect(taskMin, `${day.date}: task time <= ${dailyTaskMin}`).toBeLessThanOrEqual(dailyTaskMin);
}

// ---- fixtures ----------------------------------------------------------------------------------

export interface TSpec {
  id: string;
  min: number;
  title?: string;
  repeat?: "daily";
  occurrences?: number;
  type?: TaskType;
  section?: string;
}

export function mkFile(
  path: string,
  track: string,
  kind: FileKind,
  specs: TSpec[],
  extra: { priority?: number; startsAfter?: string } = {},
): TaskFile {
  const tasks: Task[] = specs.map((s, order) => ({
    uid: `${track}/${s.id}`,
    track,
    id: s.id,
    title: s.title ?? `${track} ${s.id}`,
    durationMin: s.min,
    type: s.type ?? "coding",
    links: [{ label: `${s.id} link`, url: `https://example.com/${track}/${s.id}` }],
    ...(s.repeat ? { repeat: s.repeat } : {}),
    ...(s.occurrences !== undefined ? { occurrences: s.occurrences } : {}),
    body: "",
    bodyLinks: [],
    section: s.section ?? null,
    order,
    file: path,
    line: order + 1,
    // Fixtures have no real file behind them; the span just has to be consistent.
    span: { heading: order + 1, blockOpen: order + 2, blockClose: order + 4, end: order + 4 },
  }));
  return { path, meta: { schema: "planner/task-file@1", track, title: track, kind, ...extra }, tasks, references: [] };
}

export const many = (prefix: string, n: number, min: number): TSpec[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, min }));

/** The real resources' shape: 3 prep tracks, lessons 2h x28, portfolio 1h, apply 30m after bcg. */
export function standardFiles(opts: { bcg?: TSpec[]; salesforce?: TSpec[]; anthropic?: TSpec[] } = {}): TaskFile[] {
  return [
    mkFile("bcg.md", "bcg", "prep", opts.bcg ?? many("B", 16, 30), { priority: 1 }),
    mkFile("salesforce.md", "salesforce", "prep", opts.salesforce ?? many("S", 20, 45), { priority: 2 }),
    mkFile("anthropic.md", "anthropic", "prep", opts.anthropic ?? many("A", 200, 45), { priority: 3 }),
    mkFile("lessons.md", "lessons", "lessons", [{ id: "DAILY", min: 120, repeat: "daily", occurrences: 28, title: "AI engineering lessons" }]),
    mkFile("portfolio.md", "portfolio", "portfolio", [{ id: "DAILY", min: 60, repeat: "daily", title: "Portfolio project" }]),
    mkFile("apply.md", "apply", "recurring", [{ id: "DAILY", min: 30, repeat: "daily", title: "Apply for positions" }], { startsAfter: "bcg" }),
  ];
}

const KIND: Record<string, FileKind> = { bcg: "prep", salesforce: "prep", anthropic: "prep", lessons: "lessons", portfolio: "portfolio", apply: "recurring" };
const RANK: Record<FileKind, number> = { prep: 0, lessons: 1, portfolio: 2, recurring: 3 };

/** Slots never go backwards within a day: prep, lessons, portfolio, recurring. */
export function assertSlotOrder(day: PlanDay, kindOf: Record<string, FileKind> = KIND): void {
  const ranks = tasksOf(day).map((t) => RANK[kindOf[t.track!]!]);
  expect(ranks, `${day.date}: slot order`).toEqual([...ranks].sort((a, b) => a - b));
}

/** Each one-off task's parts, by date, across a plan. */
export function partsByTask(days: PlanDay[]): Map<string, { date: string; min: number }[]> {
  const m = new Map<string, { date: string; min: number }[]>();
  for (const d of days)
    for (const t of tasksOf(d))
      if (!t.taskUid!.endsWith("/DAILY")) m.set(t.taskUid!, [...(m.get(t.taskUid!) ?? []), { date: d.date, min: mins(t) }]);
  return m;
}
