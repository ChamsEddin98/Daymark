import type { FileKind, FileMeta, Task, TaskFile } from "../taskfile/types.ts";
import { addDays, parseClock, toIso, zonedMs } from "./time.ts";
import { DEFAULT_CONFIG, MAX_DAILY_TASK_MIN, partTitle, type ItemStatus, type PlanDay, type PlanItem, type ScheduleConfig } from "./types.ts";

/** Status by key: task uid, or `${uid}@${date}` for `repeat: daily` tasks. */
export type StatusLookup = ReadonlyMap<string, ItemStatus> | ((key: string) => ItemStatus | undefined);

/**
 * Explicit progress of one one-off task (docs/PLAN.md, P7). Durable state owned by the store; the
 * generator never infers it from the shape of the plan.
 */
export interface TaskProgress {
  /** Minutes of this task's parts that are marked done. Skipped parts contribute nothing. */
  doneMin: number;
  /** Parts marked done. It sets the part numbering of what follows. */
  partsDone: number;
}

/** Per one-off task uid. Absent = untouched. */
export type ProgressLookup = ReadonlyMap<string, TaskProgress>;
/** Per daily task uid: sessions already held before the generated range. Counts toward `occurrences`. */
export type SessionsHeld = ReadonlyMap<string, number>;

export interface GenerateInput {
  files: readonly TaskFile[];
  /** First plan date, local "YYYY-MM-DD". */
  from: string;
  /** Horizon in days. Default 7. */
  days?: number;
  /**
   * Plan anchor, stored by the caller. Kept for the caller's bookkeeping only: `occurrences` counts
   * sessions (see `sessionsHeld`), never a window of dates, so the anchor no longer moves anything.
   */
  anchor?: string;
  config?: Partial<ScheduleConfig>;
  status?: StatusLookup;
  /**
   * Per one-off task uid. Drives remaining minutes and part numbering:
   * `rem = durationMin - doneMin`, `partsBefore = partsDone`. A one-off task is scheduled iff its
   * status is pending and `rem > 0`.
   */
  progress?: ProgressLookup;
  /** Per daily task uid: sessions already held before `from`. Counts toward `occurrences`. */
  sessionsHeld?: SessionsHeld;
  /** Uids to place first, in order. Ordering ONLY: it never carries minutes or part counts. */
  carryIn?: readonly string[];
  /**
   * Keys (uid or `${uid}@${date}`) to treat as done although still pending, e.g. today's items.
   *
   * A one-off **uid** here closes the whole task, so it is only for a task whose remaining work is
   * entirely in the kept window. A task that is only partly placed says so through `progress`
   * (`doneMin > 0`), and then progress wins: its remaining minutes are still placed, because
   * dropping them would lose work. A daily key (`${uid}@${date}`) closes that date's session only.
   */
  assumeDone?: Iterable<string>;
  /**
   * Optional (additive): lay out only the REST of the first day. The first day's items start at
   * `startAt` instead of `dayStart`; `taskMinSpent` task minutes already done or kept that day count
   * toward the block marks (240) and the day's capacity (480), so the long rest never comes earlier
   * than 240 task minutes; `maxTaskMin` caps the new task minutes (e.g. to end before midnight).
   * Prep uses the same fill, look-ahead and no-fragment rules as any day. Other days are unchanged.
   */
  firstDay?: FirstDay;
}

export interface FirstDay {
  startAt: string | number;
  taskMinSpent?: number;
  maxTaskMin?: number;
  /**
   * The lowest slot rank the rest of the first day may still hold (`SLOT_RANK`: prep 0, lessons 1,
   * portfolio 2, recurring 3). The day's order never goes backwards, so once a fixed slot has run,
   * only slots at or after it may follow. Capacity left over stays unused - the rule is "<= 480".
   */
  minSlotRank?: number;
}

/** The day's slot order (hard rule 6): prep, then lessons, then the portfolio, then recurring. */
export const SLOT_RANK: Record<FileKind, number> = { prep: 0, lessons: 1, portfolio: 2, recurring: 3 };
const KIND_RANK = SLOT_RANK;

export const statusKey = (uid: string, date?: string) => (date ? `${uid}@${date}` : uid);

export function resolveConfig(c?: Partial<ScheduleConfig>): ScheduleConfig {
  const timeZone = c?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cfg = { ...DEFAULT_CONFIG, ...c, timeZone };
  checkActiveHours(cfg);
  return cfg;
}

/**
 * The active hours have to describe a window inside one calendar day that can hold at least one
 * task. A window that wraps midnight ("22:00" to "02:00") is refused rather than guessed at: the
 * plan is keyed by calendar date throughout - items, statuses, rests, calendar events - and a day
 * spanning two dates would break every one of those keys.
 */
export function checkActiveHours(c: Pick<ScheduleConfig, "dayStart" | "dayEnd" | "dailyTaskMin"> & { minPartMin?: number }): void {
  const start = parseClock(c.dayStart);
  const end = parseClock(c.dayEnd);
  if (end <= start)
    throw new RangeError(
      `dayEnd (${c.dayEnd}) must be after dayStart (${c.dayStart}); a window that wraps midnight is not supported, because the plan is keyed by calendar date`,
    );
  const room = end - start;
  // The shortest piece the generator will ever produce. Defaulting to 1 here instead would let a
  // caller validate a window the generator then refuses, which is how a 400 became a 500.
  const least = c.minPartMin ?? DEFAULT_CONFIG.minPartMin ?? 1;
  if (room < least) throw new RangeError(`the active window ${c.dayStart}-${c.dayEnd} is ${room} min, too short for a task of ${least} min`);
  if (!Number.isInteger(c.dailyTaskMin) || c.dailyTaskMin < least || c.dailyTaskMin > MAX_DAILY_TASK_MIN)
    throw new RangeError(`dailyTaskMin must be a whole number of minutes from ${least} to ${MAX_DAILY_TASK_MIN}; got ${c.dailyTaskMin}`);
}

const MIN_MS = 60_000;
const minutesOf = (it: PlanItem) => (Date.parse(it.end) - Date.parse(it.start)) / MIN_MS;
const isPendingOneOff = (it: PlanItem, isDaily: (uid: string) => boolean) =>
  it.kind === "task" && !!it.taskUid && it.status === "pending" && !isDaily(it.taskUid);

/**
 * Progress as the generator must see it when only part of the plan is rebuilt. `kept` holds the plan
 * items before the regeneration date that stay where they are: the minutes of their **pending**
 * one-off parts are already laid out, so they must not be placed a second time. Done and skipped
 * parts are not counted here — `base` (the store's `task_progress`) already holds them.
 *
 * This is a projection of the plan, never a claim about work done, exactly like `assumeDone`.
 */
export function projectedProgress(base: ProgressLookup | undefined, kept: readonly PlanItem[], isDaily: (uid: string) => boolean): Map<string, TaskProgress> {
  const out = new Map<string, TaskProgress>();
  for (const [uid, p] of base ?? []) out.set(uid, { doneMin: Math.max(0, p.doneMin), partsDone: Math.max(0, p.partsDone) });
  for (const it of [...kept].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    if (it.kind !== "task" || !it.taskUid || isDaily(it.taskUid)) continue;
    const pending = it.status === "pending";
    const cur = out.get(it.taskUid) ?? { doneMin: 0, partsDone: 0 };
    // The part number of what follows is past every part that stays, even one labelled by an earlier
    // generation, so a rebuild can never hand out a part number twice.
    out.set(it.taskUid, {
      doneMin: cur.doneMin + (pending ? minutesOf(it) : 0),
      partsDone: Math.max(cur.partsDone + (pending ? 1 : 0), it.part?.index ?? 1),
    });
  }
  return out;
}

/**
 * The uids that must lead the next fill, in order: every one-off task that is under way (`progress`,
 * projected or durable) and still has minutes left. Ordering only — the minutes come from `progress`.
 * A task whose projected progress covers its duration is fully placed already and is left out.
 */
export function carryInFor(
  progress: ProgressLookup,
  kept: readonly PlanItem[],
  durationOf: (uid: string) => number | undefined,
  isDaily: (uid: string) => boolean,
): string[] {
  const at = new Map<string, number>();
  const left = (uid: string) => {
    const p = progress.get(uid);
    return p && (p.doneMin > 0 || p.partsDone > 0) ? (durationOf(uid) ?? 0) - p.doneMin : 0;
  };
  // Ordered by the earliest evidence of being under way: work begun before `kept`, then `kept` order.
  for (const it of kept) if (isPendingOneOff(it, isDaily) && left(it.taskUid!) > 0) at.set(it.taskUid!, Math.min(at.get(it.taskUid!) ?? Infinity, Date.parse(it.start)));
  for (const [uid] of progress) if (!at.has(uid) && left(uid) > 0) at.set(uid, -Infinity);
  return [...at.entries()].sort((a, b) => a[1] - b[1] || cmp(a[0], b[0])).map(([uid]) => uid);
}

interface Src {
  task: Task;
  meta: FileMeta;
  path: string;
}

interface Seg {
  task: Task;
  minutes: number;
}

type Rem = Map<string, number>; // one-off uid -> minutes not yet placed
type Sess = Map<string, number>; // daily uid -> sessions held or placed so far

/** Everything derived once from the inputs; the day loop only mutates `rem` and `sessions`. */
interface Ctx {
  cfg: ScheduleConfig;
  capacity: number;
  closed: (key: string) => boolean;
  /** Prep slot order: carry-in first, then prep tasks by (priority, file, order). */
  queue: Src[];
  /** Prep tracks by ascending `priority` (hard rule 7). */
  prepTracks: string[];
  /** Non-prep files by slot order. */
  fixed: { meta: FileMeta; path: string; tasks: Task[] }[];
  /** One-off uids per track, for "track finished". */
  trackUids: Map<string, string[]>;
  srcByUid: Map<string, Src>;
  partsBefore: Map<string, number>;
  /** Task minutes already on the day being planned (firstDay only; 0 otherwise). */
  off: number;
  /** Task-minute capacity of the day being planned (firstDay only; default `capacity`). */
  cap?: number;
  /** Lowest slot rank the day being planned may still hold (firstDay only; default 0). */
  minRank?: number;
}

function lookup(status: StatusLookup | undefined, assume: Set<string>) {
  const get = typeof status === "function" ? status : status ? (k: string) => status.get(k) : () => undefined;
  return (key: string) => {
    if (assume.has(key)) return true;
    const s = get(key);
    return s === "done" || s === "skipped";
  };
}

function buildCtx(input: GenerateInput, rem: Rem): Ctx {
  const cfg = resolveConfig(input.config);
  const assume = new Set(input.assumeDone ?? []);
  const closed = lookup(input.status, assume);
  const statusClosed = lookup(input.status, new Set<string>());
  const srcByUid = new Map<string, Src>();
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  for (const f of files) for (const t of f.tasks) if (!srcByUid.has(t.uid)) srcByUid.set(t.uid, { task: t, meta: f.meta, path: f.path });
  const own = (f: TaskFile) => f.tasks.filter((t) => srcByUid.get(t.uid)?.path === f.path).sort((a, b) => a.order - b.order);

  // Remaining minutes and part numbering come from `progress` alone (docs/PLAN.md, P7).
  const trackUids = new Map<string, string[]>();
  const partsBefore = new Map<string, number>();
  for (const s of srcByUid.values()) {
    const t = s.task;
    if (t.repeat === "daily") continue;
    const p = input.progress?.get(t.uid);
    if (p?.partsDone) partsBefore.set(t.uid, Math.max(0, Math.floor(p.partsDone)));
    if (statusClosed(t.uid)) continue;
    const left = t.durationMin - Math.max(0, p?.doneMin ?? 0);
    if (left <= 0) continue; // nothing remaining: never scheduled
    // Assumed done closes the task, unless progress says it is only partly placed (see `assumeDone`).
    if (assume.has(t.uid) && !(p && p.doneMin > 0)) continue;
    rem.set(t.uid, left);
    trackUids.set(t.track, [...(trackUids.get(t.track) ?? []), t.uid]);
  }

  const queue: Src[] = [];
  for (const uid of input.carryIn ?? []) {
    const s = srcByUid.get(uid);
    if (!s || !rem.has(uid) || queue.includes(s)) continue; // unknown, closed, finished, daily or duplicate
    queue.push(s);
  }
  const prep = files
    .filter((f) => f.meta.kind === "prep")
    .sort((a, b) => (a.meta.priority ?? Infinity) - (b.meta.priority ?? Infinity) || cmp(a.path, b.path));
  const prepTracks: string[] = [];
  for (const f of prep) if (!prepTracks.includes(f.meta.track)) prepTracks.push(f.meta.track);

  const fixed = files
    .filter((f) => f.meta.kind !== "prep")
    .sort((a, b) => KIND_RANK[a.meta.kind] - KIND_RANK[b.meta.kind] || cmp(a.path, b.path))
    .map((f) => ({ meta: f.meta, path: f.path, tasks: own(f) }));

  const capacity = cfg.dailyTaskMin;
  for (const f of prep) for (const t of own(f)) if (rem.has(t.uid) && !queue.some((q) => q.task.uid === t.uid)) queue.push(srcByUid.get(t.uid)!);
  return { cfg, capacity, closed, queue, prepTracks, fixed, trackUids, srcByUid, partsBefore, off: 0 };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const trackOpen = (ctx: Ctx, track: string, rem: Rem) => (ctx.trackUids.get(track) ?? []).some((u) => (rem.get(u) ?? 0) > 0);

/** A task whose file waits for another track (`starts_after`) is not eligible yet. */
const gated = (ctx: Ctx, uid: string, rem: Rem) => {
  const after = ctx.srcByUid.get(uid)?.meta.startsAfter;
  return !!after && trackOpen(ctx, after, rem);
};

/**
 * Hard rule 7, as P7 restates it: the open prep track is the lowest-`priority` prep track that still
 * has a task with remaining > 0. Only its tasks may take the prep slot — a task being mid-split never
 * makes its track look finished, because `rem` is what decides, not the split bookkeeping.
 */
function openTrack(ctx: Ctx, rem: Rem): string | undefined {
  for (const track of ctx.prepTracks) if ((ctx.trackUids.get(track) ?? []).some((u) => (rem.get(u) ?? 0) > 0 && !gated(ctx, u, rem))) return track;
  return undefined;
}

const LOOKAHEAD = 3;
const NODE_LIMIT = 3000;
const FIXED_TOLERANCE = 30;

/** Marks (block ends) a task at task-minute `t` of length `len` would cross, as piece lengths. */
function pieces(ctx: Ctx, t0: number, len: number, off = ctx.off): number[] {
  const out: number[] = [];
  const t = t0 + off; // position among the day's task minutes (firstDay: after those already spent)
  let start = t;
  for (let m = (Math.floor(t / ctx.cfg.blockMin) + 1) * ctx.cfg.blockMin; m < t + len; m += ctx.cfg.blockMin) {
    out.push(m - start);
    start = m;
  }
  out.push(t + len - start);
  return out;
}

/**
 * Split minimums. Every part >= `min`; a prep task of >= 2 x `carry` keeps parts >= `carry`;
 * a fixed-slot task (lessons, portfolio, recurring) keeps parts >= fixedFloor (or half its length).
 */
interface Mins {
  min: number;
  carry: number;
  fixedFloor: number;
}

/** A task placed at `t` is legal if, when split at a block mark, every part meets `longFloor`/`min`. */
const legalAt = (ctx: Ctx, t: number, len: number, m: Mins, longFloor = m.carry, off = ctx.off) => {
  const p = pieces(ctx, t, len, off);
  const floor = m.carry && len >= 2 * m.carry ? longFloor : m.min;
  return p.length === 1 || p.every((x) => x >= floor);
};

/**
 * Fill the prep slot (the day's first `budget` task minutes) without fragments:
 * - only the open prep track is eligible (see `openTrack`);
 * - a task is placed whole if it fits the remaining budget and any split at a block mark meets the
 *   minimums; the head of the queue may give way to up to LOOKAHEAD later tasks of its track and
 *   section (never to a task from a later section);
 * - only when no whole placement leads to a legal day, the head may be split across days: a task of
 *   >= 2 x carry into pieces >= carry, or a task that cannot sit whole in an empty slot. Today's piece
 *   is one contiguous part inside one block, the task is done for the day, and no other task is
 *   split across days that day;
 * - a continuation (carried in or begun on an earlier day) at the head goes first whenever it can;
 * - the fill must end where the fixed slots after it also split legally; leftover budget stays unused.
 * Prefers fills that include the day's first queued task (so it cannot be starved by look-ahead),
 * then the largest fill; ties keep queue order. Returns null if no legal fill exists. Mutates `rem`.
 */
function fillPrep(ctx: Ctx, rem: Rem, budget: number, fixedLens: number[], m: Mins, fullBudget = budget): Seg[] | null {
  const { min, carry } = m;
  const B = ctx.cfg.blockMin;
  const segs: Seg[] = [];
  const chunked = new Set<string>();
  let best = null as Seg[] | null;
  let bestT = -1;
  let bestHead = false;
  let nodes = 0;
  const memo = new Map<string, number>();
  const first = ctx.queue.findIndex((s) => (rem.get(s.task.uid) ?? 0) > 0);
  const eligible = (s: Src) => (rem.get(s.task.uid) ?? 0) > 0 && !chunked.has(s.task.uid) && !gated(ctx, s.task.uid, rem);
  const candidates = () => {
    const track = openTrack(ctx, rem);
    const out: Src[] = [];
    if (track === undefined) return out;
    for (let i = Math.max(0, first); i < ctx.queue.length && out.length <= LOOKAHEAD; i++) {
      const s = ctx.queue[i]!;
      // Only the open track, and the look-ahead stays in the head's section: sections are barriers.
      if (s.task.track !== track) continue;
      if (eligible(s) && (!out.length || s.task.section === out[0]!.task.section)) out.push(s);
    }
    return out;
  };
  // Fixed slots: parts >= fixedFloor, or half the task if it is shorter than 2 x fixedFloor.
  const legalEnd = (t: number) => {
    for (const len of fixedLens) {
      const p = pieces(ctx, t, len);
      if (p.length > 1 && p.some((x) => x < Math.max(min, Math.min(m.fixedFloor, Math.floor(len / 2))))) return false;
      t += len;
    }
    return true;
  };
  // A piece may not end just short of a block mark, where nothing could legally follow.
  const deadEnd = (t: number) => (t + ctx.off) % B !== 0 && B - ((t + ctx.off) % B) < min;
  // Piece sizes at `t`, largest first, that stay inside one block and leave both pieces >= `piece`.
  const chunks = (t: number, left: number, piece: number) => {
    const out: number[] = [];
    for (let c = Math.min(budget - t, left - piece, B - ((t + ctx.off) % B)); c >= Math.max(piece, 1); c--) if (!deadEnd(t + c)) out.push(c);
    return out;
  };
  // Already under way (part of it placed before): goes first when it can. A whole task carried in is
  // simply at the front of the queue, so shifting twice equals shifting once by the sum.
  const underway = new Set(
    ctx.queue.filter((q) => (ctx.partsBefore.get(q.task.uid) ?? 0) > 0 || (rem.get(q.task.uid) ?? 0) < q.task.durationMin).map((q) => q.task.uid),
  );
  // Fits a whole day: can be placed whole at the start of an empty prep slot.
  // (firstDay: judged against a whole day's prep slot, so a task that fits a normal day is not split.)
  const fitsDay = (len: number) => len <= fullBudget && legalAt(ctx, 0, len, m, m.carry, 0);
  const head = candidates()[0]?.task.uid;
  const place = (s: Src, take: number, t: number, split: boolean) => {
    const uid = s.task.uid;
    const left = rem.get(uid)!;
    rem.set(uid, left - take);
    segs.push({ task: s.task, minutes: take });
    if (split) chunked.add(uid);
    const r = go(t + take);
    if (split) chunked.delete(uid);
    segs.pop();
    rem.set(uid, left);
    return r;
  };
  /** Best legal fill reachable from here (-1: none). */
  const go = (t: number): number => {
    if (++nodes > NODE_LIMIT) return -1;
    const key = `${t}|${segs.map((x) => `${x.task.uid}:${x.minutes}`).sort().join(",")}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let res = legalEnd(t) ? t : -1;
    if (res >= 0) {
      const withHead = segs.some((x) => x.task.uid === head);
      if ((withHead && !bestHead) || (withHead === bestHead && t > bestT)) [bestT, bestHead, best] = [t, withHead, [...segs]];
    }
    if (!(bestT === budget && bestHead)) {
      const cands = candidates();
      let wholeBest = -1;
      for (const [i, s] of cands.entries()) {
        const left = rem.get(s.task.uid)!;
        if (left > budget - t || !legalAt(ctx, t, left, m)) continue;
        wholeBest = Math.max(wholeBest, place(s, left, t, false));
        if (i === 0 && underway.has(s.task.uid)) break; // a continuation that can go first, goes first
      }
      res = Math.max(res, wholeBest);
      const h = cands[0];
      // At most one task per day continues tomorrow, so continuations never queue up and slip a day.
      if (h && wholeBest < 0 && chunked.size === 0) {
        const left = rem.get(h.task.uid)!;
        const long = carry > 0 && left >= 2 * carry;
        const sizes = !fitsDay(left) ? chunks(t, left, long ? carry : min) : long ? chunks(t, left, carry) : [];
        for (const c of sizes) {
          const r = place(h, c, t, true);
          res = Math.max(res, r);
          if (r >= 0) break; // the largest piece that leads to a legal day
        }
      }
    }
    memo.set(key, res);
    return res;
  };
  go(0);
  const out: Seg[] | null = best;
  if (out) for (const x of out) rem.set(x.task.uid, rem.get(x.task.uid)! - x.minutes);
  return out;
}

const filled = (segs: Seg[] | null) => (segs ? segs.reduce((s, x) => s + x.minutes, 0) : -1);

/**
 * Prep fill for a day. Fixed slots prefer the block mark on a boundary or >= carry minutes before it;
 * a floor of 30 is used only if the stricter one costs more than FIXED_TOLERANCE prep
 * minutes. If nothing is legal, minimums are relaxed step by step.
 */
function prepFor(ctx: Ctx, rem: Rem, budget: number, lens: number[], fullBudget = budget): Seg[] {
  const min = ctx.cfg.minPartMin ?? 15;
  const carry = ctx.cfg.minCarryPieceMin ?? 45;
  const tryFill = (m: Mins) => {
    const r = new Map(rem);
    return { segs: fillPrep(ctx, r, budget, lens, m, fullBudget), r };
  };
  const floors = [...new Set([carry, Math.max(min, Math.min(30, carry))])];
  const strict = tryFill({ min, carry, fixedFloor: floors[0]! });
  let pick = strict;
  if (filled(strict.segs) < budget && floors.length > 1) {
    const loosest = tryFill({ min, carry, fixedFloor: floors.at(-1)! });
    const target = filled(loosest.segs) - FIXED_TOLERANCE;
    pick = loosest;
    for (const f of floors.slice(0, -1)) {
      const c = f === floors[0] ? strict : tryFill({ min, carry, fixedFloor: f });
      if (c.segs && filled(c.segs) >= target) {
        pick = c;
        break;
      }
    }
  }
  if (!pick.segs) pick = tryFill({ min, carry: 0, fixedFloor: min });
  if (!pick.segs) pick = tryFill({ min: 0, carry: 0, fixedFloor: 0 });
  for (const [k, v] of pick.r) rem.set(k, v);
  return pick.segs!;
}

/** One day's segments in slot order, given which gated (starts_after) files are active. */
function simulate(ctx: Ctx, date: string, active: Set<string>, rem0: Rem, sess0: Sess): { segs: Seg[]; rem: Rem; sessions: Sess } {
  const rem = new Map(rem0);
  const sessions = new Map(sess0);
  const fixed: Seg[] = [];
  let used = 0;
  const cap = ctx.cap ?? ctx.capacity;
  const add = (task: Task, minutes: number) => {
    if (used + minutes > cap) return false;
    fixed.push({ task, minutes });
    used += minutes;
    return true;
  };
  for (const f of ctx.fixed) {
    if (f.meta.startsAfter && !active.has(f.path)) continue;
    if (KIND_RANK[f.meta.kind] < (ctx.minRank ?? 0)) continue; // the day's order never goes backwards
    let oneOffTaken = false;
    for (const t of f.tasks) {
      if (t.repeat === "daily") {
        const closed = ctx.closed(statusKey(t.uid, date));
        if (t.occurrences === undefined) {
          if (!closed) add(t, t.durationMin);
          continue;
        }
        // `occurrences: N` counts SESSIONS, never a window of dates: a shift can neither lose one nor
        // add one. A closed date already holds its session and was reserved before the day loop.
        if (closed) continue;
        const held = sessions.get(t.uid) ?? 0;
        if (held >= t.occurrences) continue;
        if (add(t, t.durationMin)) sessions.set(t.uid, held + 1);
      } else if (!oneOffTaken && (rem.get(t.uid) ?? 0) > 0) {
        // Non-prep one-off tasks: the next pending one per file per day.
        oneOffTaken = true;
        if (add(t, rem.get(t.uid)!)) rem.set(t.uid, 0);
      }
    }
  }
  const budget = (ctx.minRank ?? 0) > 0 ? 0 : cap - used;
  const prep = prepFor(ctx, rem, budget, fixed.map((f) => f.minutes), Math.max(budget, ctx.capacity - used));
  return { segs: [...prep, ...fixed], rem, sessions };
}

/**
 * Pick the day's segments. Implements rule 8: a gated file (starts_after T) whose track T finishes
 * today is included only if T still finishes with it included; otherwise it starts tomorrow.
 */
function planDay(ctx: Ctx, date: string, started: Set<string>, forced: Set<string>, rem: Rem, sessions: Sess) {
  const gatedFiles = ctx.fixed.filter((f) => f.meta.startsAfter);
  const active = new Set([...started, ...forced]);
  for (const f of gatedFiles) if (!active.has(f.path) && !trackOpen(ctx, f.meta.startsAfter!, rem)) active.add(f.path);

  let sim = simulate(ctx, date, active, rem, sessions);
  const newly = gatedFiles.filter((f) => !active.has(f.path) && !trackOpen(ctx, f.meta.startsAfter!, sim.rem));
  const next = new Set<string>();
  if (newly.length) {
    const withAll = simulate(ctx, date, new Set([...active, ...newly.map((f) => f.path)]), rem, sessions);
    const keep = newly.filter((f) => !trackOpen(ctx, f.meta.startsAfter!, withAll.rem));
    for (const f of newly) if (!keep.includes(f)) next.add(f.path);
    for (const f of keep) active.add(f.path);
    // Fewer inclusions leave more prep budget, so every kept track still finishes.
    sim = keep.length === newly.length ? withAll : keep.length ? simulate(ctx, date, active, rem, sessions) : sim;
  }
  return { segs: sim.segs, rem: sim.rem, sessions: sim.sessions, started: active, forced: next };
}

/**
 * Plan one day so that nothing runs past `dayEnd` (the active-hours fence).
 *
 * How much task time a window holds is **not** a function of the window: it depends on how the work
 * divides into tasks, because every boundary between two of them costs a rest. So the fence cannot be
 * converted into a budget up front. Instead the day is planned, its end is looked at, and if it
 * overshoots, the largest task-minute budget that *does* fit is found by bisection.
 *
 * Bisection rather than "subtract the overshoot": subtracting is wildly wrong at the small end,
 * because removing task minutes also removes the rests between them. A 45-minute window asked to
 * hold a 480-minute day overshoots by ~9 h, and one subtraction lands on zero - so the day came out
 * empty when a single 45-minute task fitted perfectly.
 *
 * `planDay` is safe to call repeatedly: `simulate` copies `rem` and `sessions`, and `planDay` itself
 * calls it several times with the originals. Only the attempt that is returned gets committed.
 *
 * Trimming never *loses* work: the minutes stay in `rem`, so the following days place them. That is
 * what makes "what does not fit before the end of the day moves to the next day" true. And because
 * only an attempt whose last item ends at or before the fence is ever returned, no plan can contain
 * an item past it - whatever the search does.
 */
function fitDay(
  ctx: Ctx,
  date: string,
  started: Set<string>,
  forced: Set<string>,
  rem: Rem,
  sessions: Sess,
  first: { startMs: number; spent: number } | undefined,
  cap0: number | undefined,
): { day: ReturnType<typeof planDay>; items: Raw[] } {
  const fence = zonedMs(date, parseClock(ctx.cfg.dayEnd), ctx.cfg.timeZone);
  type Attempt = { day: ReturnType<typeof planDay>; items: Raw[]; fits: boolean };
  const attempt = (cap: number | undefined): Attempt => {
    ctx.cap = cap;
    const day = planDay(ctx, date, started, forced, rem, sessions);
    const items = layout(ctx, date, day.segs, first);
    const last = items.at(-1);
    return { day, items, fits: !last || last.end <= fence };
  };

  // The common case by far: the whole budget fits inside the window, and this costs one attempt.
  const whole = attempt(cap0);
  if (whole.fits) return whole;

  // Otherwise: the largest budget that fits, between "nothing" (which always fits) and the budget
  // that did not. More task minutes can only push the day later, so bisection converges in ~11 steps.
  let lo = 0;
  let hi = cap0 ?? ctx.capacity;
  let best = attempt(0);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const r = attempt(mid);
    if (r.fits) {
      lo = mid;
      best = r;
    } else hi = mid;
  }
  return best;
}

interface Raw {
  kind: "task" | "rest";
  start: number; // ms
  end: number;
  task?: Task;
  long?: boolean;
}

/** Lay segments on the clock from dayStart: split at block boundaries, rests between items. */
function layout(ctx: Ctx, date: string, segs: Seg[], first?: { startMs: number; spent: number }): Raw[] {
  const { cfg } = ctx;
  const t0 = first ? first.startMs : zonedMs(date, parseClock(cfg.dayStart), cfg.timeZone);
  const out: Raw[] = [];
  let taskMin = first?.spent ?? 0;
  let clock = 0;
  segs.forEach((seg, k) => {
    let left = seg.minutes;
    while (left > 0) {
      const chunk = Math.min(left, cfg.blockMin - (taskMin % cfg.blockMin));
      out.push({ kind: "task", start: t0 + clock * 60_000, end: t0 + (clock + chunk) * 60_000, task: seg.task });
      taskMin += chunk;
      clock += chunk;
      left -= chunk;
      if (left === 0 && k === segs.length - 1) break;
      const long = taskMin % cfg.blockMin === 0;
      const len = long ? cfg.longRestMin : cfg.shortRestMin;
      out.push({ kind: "rest", start: t0 + clock * 60_000, end: t0 + (clock + len) * 60_000, long });
      clock += len;
    }
  });
  return out;
}

/**
 * Turn raw layouts into keyed items. One-off parts are numbered across the whole range; `beyond`
 * holds days past the horizon so a task still running at the end gets its true part total.
 */
function materialize(ctx: Ctx, raw: { date: string; items: Raw[] }[], beyond: { date: string; items: Raw[] }[]): PlanDay[] {
  const tz = ctx.cfg.timeZone;
  const partKey = (date: string, t: Task) => (t.repeat === "daily" ? `${t.uid}@${date}` : t.uid);
  const totals = new Map<string, number>();
  for (const d of [...raw, ...beyond])
    for (const r of d.items) if (r.task) totals.set(partKey(d.date, r.task), (totals.get(partKey(d.date, r.task)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return raw.map(({ date, items }) => {
    let restN = 0;
    return {
      date,
      items: items.map((r): PlanItem => {
        const base = { date, start: toIso(r.start, tz), end: toIso(r.end, tz), status: "pending" as const };
        if (!r.task) {
          restN++;
          return { ...base, key: `${date}|rest|${restN}`, kind: "rest", title: r.long ? "Long rest" : "Rest", restKind: r.long ? "long" : "short" };
        }
        const t = r.task;
        const pk = partKey(date, t);
        const before = t.repeat === "daily" ? 0 : (ctx.partsBefore.get(t.uid) ?? 0);
        const index = before + (seen.get(pk) ?? 0) + 1;
        seen.set(pk, index - before);
        const total = before + totals.get(pk)!;
        const split = total > 1;
        return {
          ...base,
          key: `${date}|${t.uid}|${index}`,
          kind: "task",
          taskUid: t.uid,
          track: t.track,
          title: split ? partTitle(t.title, index, total) : t.title,
          ...(split ? { part: { index, total } } : {}),
          links: t.links.map((l) => ({ ...l })),
          type: t.type,
        };
      }),
    };
  });
}

/** Generate `days` plan days from `from`. Pure and deterministic. */
export function generatePlan(input: GenerateInput): PlanDay[] {
  const days = input.days ?? 7;
  if (!Number.isInteger(days) || days < 0) throw new RangeError(`days must be a non-negative integer, got ${days}`);
  let rem: Rem = new Map();
  const ctx = buildCtx(input, rem);
  let sessions: Sess = new Map([...(input.sessionsHeld ?? [])].map(([uid, n]) => [uid, Math.max(0, Math.floor(n))]));
  // A date in the range whose session is done or skipped has held it: reserve those sessions up front,
  // so no placement can ever be made on top of them (and the order of the days cannot matter).
  for (const s of ctx.srcByUid.values()) {
    const t = s.task;
    if (t.repeat !== "daily" || t.occurrences === undefined) continue;
    let n = 0;
    for (let i = 0; i < days; i++) if (ctx.closed(statusKey(t.uid, addDays(input.from, i)))) n++;
    if (n) sessions.set(t.uid, (sessions.get(t.uid) ?? 0) + n);
  }
  let started = new Set<string>();
  let forced = new Set<string>();
  const raw: { date: string; items: Raw[] }[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(input.from, i);
    const fd = i === 0 ? input.firstDay : undefined;
    let first: { startMs: number; spent: number } | undefined;
    let cap: number | undefined;
    if (fd) {
      const spent = Math.max(0, fd.taskMinSpent ?? 0);
      const startMs = typeof fd.startAt === "number" ? fd.startAt : Date.parse(fd.startAt);
      if (Number.isNaN(startMs)) throw new RangeError(`firstDay.startAt is not an instant: ${String(fd.startAt)}`);
      first = { startMs, spent };
      ctx.off = spent;
      cap = Math.max(0, Math.min(ctx.capacity - spent, fd.maxTaskMin ?? Infinity));
      ctx.minRank = fd.minSlotRank;
    }
    const d = fitDay(ctx, date, started, forced, rem, sessions, first, cap);
    ctx.off = 0;
    ctx.cap = undefined;
    ctx.minRank = undefined;
    ({ rem, sessions, started, forced } = d.day);
    raw.push({ date, items: d.items });
  }
  // Follow tasks cut by the horizon end until they finish, only to count their parts.
  const cut = new Set(raw.at(-1)?.items.flatMap((r) => (r.task && (rem.get(r.task.uid) ?? 0) > 0 ? [r.task.uid] : [])) ?? []);
  const beyond: { date: string; items: Raw[] }[] = [];
  for (let i = days; cut.size && [...cut].some((u) => rem.get(u)! > 0) && i < days + 60; i++) {
    const date = addDays(input.from, i);
    const d = fitDay(ctx, date, started, forced, rem, sessions, undefined, undefined);
    ({ rem, sessions, started, forced } = d.day);
    beyond.push({ date, items: d.items.filter((r) => r.task && cut.has(r.task.uid)) });
  }
  return materialize(ctx, raw, beyond);
}
