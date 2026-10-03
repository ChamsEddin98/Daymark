/**
 * Boundary scanner: each `scan()` fires every item boundary in (last scan, now] exactly once.
 *
 * - task item start/end -> task_start/task_end; rest item start/end -> rest_start/rest_end.
 * - Task items whose status is done/skipped fire nothing (checked at fire time, so marking a task
 *   done early suppresses its task_end). Rest boundaries always fire.
 * - De-dup is the store's UNIQUE(item_key, type): a restart, a second daemon or a re-scan never
 *   fires a boundary twice.
 * - Grace window: boundaries older than `graceMs` (default 2 min, simulated time) are never fired,
 *   neither at startup nor after a stall (sleep/hibernate). They are skipped, not recorded, and
 *   counted in the log ("skipped N boundaries during downtime"; at startup the downtime is counted
 *   from the last recorded notification, at most from local midnight).
 * - Resume: when boundaries were skipped (startup, stall) and an item is in progress whose start was
 *   never notified, ONE "Now: … until HH:MM" toast is sent and recorded as type `resume` under the
 *   item's key, so later restarts within the same item do not repeat it. `resume` is not one of the
 *   four boundary types and is not counted with them.
 * - Free windows: a run of adjacent timeline items made of rests and closed (done/skipped) tasks is
 *   ONE free window when it contains a closed task, or when no pending task ends where its first
 *   rest starts (for example a rest in a gap opened by a shift). Its first rest_start is shown as
 *   "Free until <start of the next pending task> · Next: <task>"; every other rest boundary inside
 *   it is recorded once as usual but marked `silent` (delivered only to the log). If that first
 *   rest already fired as a normal rest (the task was closed later), the next rest announces it. The pending task
 *   that ends the window fires its own task_start toast (coalesced with the last rest_end).
 * - Items are read from the store on every scan, so a shift/check/regenerate by the API is seen on
 *   the next scan (≤ 1 s real time).
 * - Pause (docs/PLAN.md, P8 rule 5): the pause instant is read from the store on every scan, so the
 *   daemon follows a pause within one tick. While paused the scan never looks past that instant, so no
 *   boundary inside the pause fires and none is recorded; on resume the next window starts at the
 *   resume instant, so the pause window is never replayed. The single exception is the `task_end` of
 *   the task that was under way when the owner paused: that task keeps its times, so a pause that
 *   outlasts it would swallow its end for good. It is fired once, at the resume instant.
 */
import { addDays, localDate, toIso, zonedMs, type PlanItem } from "@planner/core";
import type { Clock, NotificationRecord, NotificationType, PlannerStore } from "@planner/store";
import { buildResume, buildToast, hhmm, recordTitle, type BoundaryEvent } from "./format.ts";
import { deliver, errMsg, type FiredNotification, type NotificationSink } from "./sinks.ts";

export interface ScannerOptions {
  store: PlannerStore;
  clock: Clock;
  timeZone: string;
  sinks: readonly NotificationSink[];
  graceMs?: number;
  log?: (msg: string) => void;
}

export const DEFAULT_GRACE_MS = 2 * 60_000;

export class BoundaryScanner {
  private last: number | undefined;
  /** The pause instant the scan is frozen at (docs/PLAN.md, P8 rule 5); undefined when running. */
  private frozenAt: number | undefined;
  readonly graceMs: number;
  private readonly log: (msg: string) => void;
  /** Counters (tests, shutdown summary). */
  readonly stats = { fired: 0, toasts: 0, duplicates: 0, stale: 0, resumed: 0 };

  constructor(private readonly o: ScannerOptions) {
    this.graceMs = o.graceMs ?? DEFAULT_GRACE_MS;
    this.log = o.log ?? (() => {});
  }

  /** Boundaries with at in (fromMs, toMs], chronological. Done/skipped task items are excluded. */
  boundaries(fromMs: number, toMs: number): BoundaryEvent[] {
    const out: BoundaryEvent[] = [];
    if (toMs <= fromMs) return out;
    const windows = new Map<string, FreeWindow>();
    for (const item of this.o.store.getItemsOverlapping(fromMs, toMs + 1)) {
      const task = item.kind === "task";
      if (task && item.status !== "pending") continue;
      const edges: [NotificationType, number][] = [
        [task ? "task_start" : "rest_start", Date.parse(item.start)],
        [task ? "task_end" : "rest_end", Date.parse(item.end)],
      ];
      for (const [type, atMs] of edges) {
        if (atMs <= fromMs || atMs > toMs) continue;
        const e: BoundaryEvent = { type, item, atMs };
        if (!task) {
          const w = windows.get(item.key) ?? this.freeWindow(item);
          windows.set(item.key, w);
          if (w.free) {
            if (type === "rest_start" && w.firstRestKey === item.key) e.free = { untilMs: w.untilMs, next: w.next };
            else e.silent = true;
          }
        }
        out.push(e);
      }
    }
    // end before start at the same instant, so records read task_end, rest_start
    const order = (t: NotificationType) => (t.endsWith("_end") ? 0 : 1);
    return out.sort((a, b) => a.atMs - b.atMs || order(a.type) - order(b.type));
  }

  /** The free window (see header) a rest belongs to. */
  freeWindow(rest: PlanItem): FreeWindow {
    const items = this.o.store.getDay(rest.date).items; // the timeline, chronological
    const idx = items.findIndex((it) => it.key === rest.key);
    if (idx < 0) return { free: false, untilMs: Date.parse(rest.end) };
    const inRun = (it: PlanItem | undefined) => !!it && (it.kind === "rest" || it.status !== "pending");
    let a = idx;
    while (inRun(items[a - 1])) a--;
    let b = idx;
    while (inRun(items[b + 1])) b++;
    const run = items.slice(a, b + 1);
    const firstRest = run.find((it) => it.kind === "rest")!;
    const fs = Date.parse(firstRest.start);
    const closed = run.some((it) => it.kind === "task");
    const taskEndsAtFirstRest = this.o.store
      .getItemsOverlapping(fs - 1, fs)
      .some((it) => it.kind === "task" && it.status === "pending" && Date.parse(it.end) === fs);
    const next = items[b + 1];
    // The announcing rest: the first one whose rest_start is not recorded yet, or was recorded as
    // "Free until …". A rest that already fired as a normal rest (the task after it was closed
    // later) does not count, so the window is still announced once, at its next rest.
    const announcer = run.find((it) => {
      if (it.kind !== "rest") return false;
      const title = this.recordedTitle(it.key, "rest_start");
      return title === undefined || title.startsWith("Free until");
    });
    return {
      free: closed || !taskEndsAtFirstRest,
      firstRestKey: announcer?.key,
      untilMs: next ? Date.parse(next.start) : Date.parse(run.at(-1)!.end),
      next,
    };
  }

  private recordedTitle(itemKey: string, type: NotificationType): string | undefined {
    const r = this.o.store.db.prepare("SELECT title FROM notifications WHERE item_key = ? AND type = ?").get(itemKey, type) as { title?: string } | undefined;
    return r?.title === undefined ? undefined : String(r.title);
  }

  /** The next boundary instant after `now` within `withinMs`, if any (the daemon sleeps until it). */
  nextBoundaryAfter(now: number, withinMs: number): number | undefined {
    let best: number | undefined;
    for (const it of this.o.store.getItemsOverlapping(now, now + withinMs + 1))
      for (const t of [Date.parse(it.start), Date.parse(it.end)]) if (t > now && (best === undefined || t < best)) best = t;
    return best;
  }

  /** True while the plan is paused: the scan is frozen at the pause instant. */
  get frozen(): boolean {
    return this.frozenAt !== undefined;
  }

  /** Fires due boundaries. Returns the notifications delivered by this scan. */
  scan(): FiredNotification[] {
    let now = this.o.clock.now();
    // The store owns the rule: a pause older than the 24 h a resume can apply is no longer live, so it
    // must stop silencing notifications, exactly as it stops refusing shifts on the API side. Reading
    // it from the same place is what keeps the two processes from disagreeing.
    const pausedSince = this.o.store.freshPausedSince(now);
    if (pausedSince !== undefined) {
      // Frozen (P8 rule 5): the scan never looks past the pause instant, so no boundary inside the
      // pause window fires and none is recorded. Boundaries from before the pause still fire once.
      this.frozenAt = pausedSince;
      if (this.last === undefined || this.last >= pausedSince) {
        this.last = Math.min(this.last ?? pausedSince, pausedSince);
        return [];
      }
      now = pausedSince;
    } else if (this.frozenAt !== undefined) {
      // Resumed: everything still to come moved forward by exactly the pause, so the window the pause
      // covered has nothing left to fire. The next window starts at the resume instant, quietly - no
      // downtime note, no "Now: …" toast, nothing recorded for the instants that were paused. The one
      // exception is the end of the task that was under way, which the pause would otherwise swallow.
      const pausedAt = this.frozenAt;
      this.frozenAt = undefined;
      this.last = now;
      // Two ways to leave the frozen state. A real resume cleared the pause and moved the plan, so the
      // end it swallowed is replayed. A pause that merely went stale moved nothing and is hours old:
      // announcing the end of a task from two days ago would be worse than saying nothing.
      if (this.o.store.pausedSince() !== undefined) {
        this.log("pause is older than 24 h and can no longer be applied: firing boundaries again");
        return [];
      }
      return this.resumeSwallowedEnd(pausedAt, now);
    }
    if (this.last !== undefined && now < this.last) {
      this.last = now; // clock went backwards (manual clocks in tests); never re-fire
      return [];
    }
    const tz = this.o.timeZone;
    const floor = now - this.graceMs;
    const first = this.last === undefined;
    let from = this.last ?? floor;
    const out: FiredNotification[] = [];
    if (first || from < floor) {
      const firstStart = first && this.o.store.lastNotificationId() === 0;
      const since = first ? this.downtimeStart(now) : from;
      const stale = since < floor ? this.boundaries(since, floor).filter((e) => !this.o.store.hasNotification(e.item.key, e.type)) : [];
      if (stale.length) {
        this.stats.stale += stale.length;
        const n = `${stale.length} boundar${stale.length === 1 ? "y" : "ies"}`;
        this.log(
          firstStart
            ? `first start: skipped ${n} earlier today (before ${hhmm(floor, tz)})`
            : `skipped ${n} during downtime (${hhmm(since, tz)}–${hhmm(floor, tz)}, older than ${Math.round(this.graceMs / 1000)} s)`,
        );
        const entry = { at: toIso(now, tz), skipped: stale.length, from: toIso(since, tz), to: toIso(floor, tz), reason: firstStart ? "first_start" : "downtime" };
        for (const sink of this.o.sinks) {
          try {
            sink.note?.(entry);
          } catch (e) {
            this.log(`${sink.name} sink failed: ${errMsg(e)}`);
          }
        }
      }
      from = floor;
      const r = this.resume(now, floor);
      if (r) out.push(r);
    }
    const events = this.boundaries(from, now);
    this.last = now;
    out.push(...this.fire(events, now));
    return out;
  }

  /**
   * Record and deliver `events`, coalescing everything due at the same instant into one toast, and
   * stamping each record with `now` (the moment it is actually delivered). De-dup is the store's
   * UNIQUE(item_key, type), so an event already recorded is counted and dropped.
   */
  private fire(events: BoundaryEvent[], now: number): FiredNotification[] {
    const tz = this.o.timeZone;
    const out: FiredNotification[] = [];
    for (let i = 0; i < events.length; ) {
      let j = i;
      while (j < events.length && events[j]!.atMs === events[i]!.atMs) j++;
      const group = events.slice(i, j);
      i = j;
      const at = toIso(now, tz);
      const fired: BoundaryEvent[] = [];
      const records: FiredNotification["records"] = [];
      for (const e of group) {
        const rec = { at, type: e.type, itemKey: e.item.key, title: recordTitle(e, tz) };
        if (this.o.store.recordNotification(rec)) {
          fired.push(e);
          records.push({ ...rec, due: toIso(e.atMs, tz) });
        } else this.stats.duplicates++;
      }
      if (!fired.length) continue;
      const shown = fired.filter((e) => !e.silent);
      const silent = shown.length === 0;
      const toast = buildToast(silent ? fired : shown, tz, (fromMs, date) => this.itemsAfter(fromMs, date));
      const n: FiredNotification = silent ? { toast, records, silent } : { toast, records };
      this.stats.fired += records.length;
      if (!silent) this.stats.toasts++;
      this.log(`${records.map((r) => r.type).join("+")} ${hhmmOf(records[0]!.due)}  ${silent ? "(silent: inside a free window)" : `${toast.title} — ${toast.message}`}`);
      deliver(this.o.sinks, n, this.log);
      out.push(n);
    }
    return out;
  }

  /**
   * The one boundary a pause may swallow for good: the END of the task that was under way when the
   * owner paused. That task keeps its times (P8 rule 2), so if the pause outlasted it its `task_end`
   * fell inside the pause window and would never fire - the owner would never be told that task was
   * over. It is fired once here, at the resume instant, together with anything else due at the same
   * instant (the rest that follows it starts there), as one toast.
   *
   * Nothing else needs this: every item that had not begun moved out of the pause window with the
   * shift, so its boundaries fire at their new times.
   */
  private resumeSwallowedEnd(pausedAt: number, now: number): FiredNotification[] {
    const underway = this.o.store
      .getItemsOverlapping(pausedAt, pausedAt + 1)
      .find((it) => it.kind === "task" && it.status === "pending" && Date.parse(it.start) <= pausedAt && Date.parse(it.end) > pausedAt);
    if (!underway) return [];
    const endMs = Date.parse(underway.end);
    // Only when the end really is inside the pause window; a shorter pause leaves it in the future,
    // where the normal scan fires it.
    if (!(endMs > pausedAt && endMs <= now)) return [];
    if (this.o.store.hasNotification(underway.key, "task_end")) return [];
    const fired = this.fire(this.boundaries(endMs - 1, endMs), now);
    if (fired.length) this.log(`resume: fired the task_end of ${underway.key}, which fell inside the pause`);
    return fired;
  }

  /** Start of the downtime before this process: the last recorded notification, at most local midnight. */
  private downtimeStart(now: number): number {
    const midnight = zonedMs(localDate(now, this.o.timeZone), 0, this.o.timeZone);
    const last = this.o.store.listNotifications(1)[0];
    const lastMs = last ? Date.parse(last.at) : NaN;
    return Number.isFinite(lastMs) && lastMs > midnight && lastMs < now ? lastMs : midnight;
  }

  /** "Now: …" for an item in progress whose start was never notified (see header). */
  private resume(now: number, floor: number): FiredNotification | undefined {
    const tz = this.o.timeZone;
    const cur = this.o.store
      .getItemsOverlapping(now, now + 1)
      .find((it) => Date.parse(it.start) <= floor && Date.parse(it.end) > now && (it.kind === "rest" || it.status === "pending"));
    if (!cur) return undefined;
    if (this.o.store.hasNotification(cur.key, cur.kind === "task" ? "task_start" : "rest_start")) return undefined;
    const w = cur.kind === "rest" ? this.freeWindow(cur) : undefined;
    const toast = w?.free
      ? buildToast([{ type: "rest_start", item: cur, atMs: Date.parse(cur.start), free: { untilMs: w.untilMs, next: w.next } }], tz, () => [])
      : buildResume(cur, tz, (fromMs, date) => this.itemsAfter(fromMs, date));
    if (w?.free) toast.title = `Now: ${toast.title}`;
    const rec = { at: toIso(now, tz), type: RESUME, itemKey: cur.key, title: toast.title };
    // `resume` is a daemon-only record type; the notifications table has no CHECK on type.
    if (!this.o.store.recordNotification(rec as unknown as NotificationRecord)) return undefined;
    this.stats.resumed++;
    const n: FiredNotification = { toast, records: [{ ...rec, due: cur.start }] };
    this.log(`resume ${hhmm(now, tz)}  ${toast.title} — ${toast.message}`);
    deliver(this.o.sinks, n, this.log);
    return n;
  }

  private itemsAfter(fromMs: number, date: string): PlanItem[] {
    return this.o.store.getItemsBetween(date, addDays(date, 1), "timeline").filter((it) => Date.parse(it.start) >= fromMs);
  }
}

const hhmmOf = (iso: string) => iso.slice(11, 16);

export interface FreeWindow {
  free: boolean;
  /** The rest whose start opens the window (shown); the window's other rest boundaries are silent. */
  firstRestKey?: string;
  /** Start of the pending task that ends the window (else the end of its last item). */
  untilMs: number;
  next?: PlanItem;
}

/** Record type of the startup "Now: …" toast (not a boundary). */
export const RESUME = "resume" as const;
