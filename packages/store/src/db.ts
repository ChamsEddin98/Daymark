/**
 * SQLite repository shared by the API and the daemon (two processes, one file, WAL mode).
 * Every multi-row write runs in one BEGIN IMMEDIATE transaction; busy_timeout makes the other
 * process wait for the lock instead of failing.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ItemStatus, PlanDay, PlanItem, TaskProgress } from "@planner/core";
import { MAX_SHIFT_MS, addDays, daysBetween } from "@planner/core";
import { dataDir } from "./paths.ts";

export const ITEM_STATUSES: readonly ItemStatus[] = ["pending", "done", "skipped"];
export const BOUNDARY_TYPES = ["task_start", "task_end", "rest_start", "rest_end"] as const;
export type NotificationType = (typeof BOUNDARY_TYPES)[number];
/** Every type a notification record can have: the four boundaries plus "resume", the daemon's
 *  one-off "Now: …" toast when it starts mid-item. Used to validate GET /notifications?type=. */
export const NOTIFICATION_TYPES: readonly string[] = [...BOUNDARY_TYPES, "resume"];

export interface NotificationRecord {
  at: string;
  type: NotificationType;
  itemKey: string;
  title: string;
}

export interface SyncResultCounts {
  inserted: number;
  patched: number;
  deleted: number;
  unchanged: number;
}

export interface SyncState {
  lastSyncAt: string | null;
  lastResult: SyncResultCounts | null;
  lastError: { code: string; message: string; at: string } | null;
  pending: boolean;
  lastAttemptAt: string | null;
}

export interface StatusRow {
  key: string;
  status: ItemStatus;
  updatedAt: string;
}

/** Well-known meta keys. */
export const META = {
  anchor: "anchor",
  timeZone: "time_zone",
  calendarId: "calendar_id",
  horizon: "horizon_days",
  /** Date the stored plan was last regenerated from with actual status (the rollover marker). */
  planFrom: "plan_from",
  /** Incremented on every plan/status write; lets another process notice changes by polling. */
  planRev: "plan_rev",
  /**
   * Epoch ms of the instant `POST /plan/pause` froze the plan at, to the millisecond; absent when the
   * plan is running (docs/PLAN.md, P8). It lives in `meta`, so a pause survives a restart of either
   * process, and every write of it bumps `planRev`, so the daemon sees it within its tick.
   */
  pausedSince: "paused_since",
} as const;

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE task_status (
        key TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending','done','skipped')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE plan_items (
        key TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        start TEXT NOT NULL,
        "end" TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        kind TEXT NOT NULL,
        task_uid TEXT,
        status TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX plan_items_date ON plan_items (date, start_ms);
      CREATE INDEX plan_items_task ON plan_items (task_uid, date);
      CREATE INDEX plan_items_start ON plan_items (start_ms);
      CREATE TABLE sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_sync_at TEXT,
        last_result TEXT,
        last_error TEXT,
        last_attempt_at TEXT,
        pending INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO sync_state (id) VALUES (1);
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        item_key TEXT NOT NULL,
        title TEXT NOT NULL,
        UNIQUE (item_key, type)
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- Per-task count of daily occurrences dropped by a minute/hour shift and added back at the end (PLAN.md).
      CREATE TABLE extra_occurrences (task_uid TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
    `,
  },
  {
    version: 3,
    sql: `
      -- 1: on the day's timeline; 0: in the day's "checked" list (done/skipped, no longer placed).
      ALTER TABLE plan_items ADD COLUMN placed INTEGER NOT NULL DEFAULT 1;
      CREATE INDEX plan_items_placed ON plan_items (placed, date);
    `,
  },
  {
    version: 4,
    sql: `
      -- P7 (docs/PLAN.md): progress is first-class, durable state, never inferred from the plan.
      -- done_min: minutes of this task's parts currently marked done (skipped parts count nothing).
      -- parts_done: how many parts are marked done; it sets the part numbering of what follows.
      CREATE TABLE task_progress (
        uid TEXT PRIMARY KEY,
        done_min INTEGER NOT NULL DEFAULT 0,
        parts_done INTEGER NOT NULL DEFAULT 0
      );
      -- One row per date on which a session of a daily task was held (placed and now in the past, or
      -- done). Replaces extra_occurrences: occurrences counts sessions, never a window of dates.
      CREATE TABLE sessions_held (
        task_uid TEXT NOT NULL,
        date TEXT NOT NULL,
        PRIMARY KEY (task_uid, date)
      );
      DROP TABLE IF EXISTS extra_occurrences;
    `,
  },
];

/** A stored day: the timeline plus the checked items of that date that are no longer placed. */
export interface StoredDay extends PlanDay {
  checked: PlanItem[];
}

/** Which rows: the timeline, the checked lists, or both. */
export type Which = "timeline" | "checked" | "all";
const WHERE: Record<Which, string> = { timeline: " AND placed = 1", checked: " AND placed = 0", all: "" };

export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.version;

export interface OpenOptions {
  /** Directory holding planner.db. Default: PLANNER_DATA_DIR or <repo>/.data */
  dir?: string;
  /** Full path (overrides dir). ":memory:" works for unit tests. */
  file?: string;
  /** ms to wait for the other process' lock. Default 5000. */
  busyTimeoutMs?: number;
}

type Row = Record<string, SQLInputValue>;

const toMs = (iso: string) => Date.parse(iso);

/** `%` and `_` are LIKE wildcards; task ids may contain `_`, so a literal key has to escape them. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Rows removed per table by `forgetTask` (P9 rule 4), so a delete can report what it dropped. */
export interface ForgetCounts {
  statuses: number;
  items: number;
  progress: number;
  sessions: number;
  notifications: number;
}

/** True for SQLite's "another connection holds the lock" errors (SQLITE_BUSY / SQLITE_LOCKED). */
export function isBusyError(e: unknown): boolean {
  const err = e as { errcode?: number; errstr?: string; message?: string };
  const primary = typeof err?.errcode === "number" ? err.errcode & 0xff : undefined;
  return primary === 5 || primary === 6 || /database (table )?is locked|SQLITE_BUSY/i.test(err?.message ?? "");
}

/** Runs `fn`, retrying on a busy/locked database with a growing backoff for up to `budgetMs`. Synchronous. */
export function retryBusy<T>(fn: () => T, budgetMs = 5000): T {
  const deadline = Date.now() + Math.max(budgetMs, 1000);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!isBusyError(e) || Date.now() >= deadline) throw e;
      Atomics.wait(sleeper, 0, 0, Math.min(10 * 2 ** attempt, 200) + Math.random() * 10);
    }
  }
}

export class PlannerStore {
  readonly db: DatabaseSync;
  readonly path: string;
  private depth = 0;

  constructor(opts: OpenOptions = {}) {
    if (opts.file) this.path = opts.file;
    else {
      const dir = opts.dir ?? dataDir();
      mkdirSync(dir, { recursive: true });
      this.path = join(dir, "planner.db");
    }
    this.db = new DatabaseSync(this.path);
    const busyMs = opts.busyTimeoutMs ?? 5000;
    this.db.exec(`PRAGMA busy_timeout = ${busyMs}`);
    // The API and the daemon start together and may both open a brand-new file. busy_timeout does
    // not cover switching the journal mode (or every step of the first migration), so those two
    // steps are retried on SQLITE_BUSY with a short backoff.
    if (this.path !== ":memory:") retryBusy(() => this.db.exec("PRAGMA journal_mode = WAL"), busyMs);
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    retryBusy(() => this.migrate(), busyMs);
  }

  static open(opts?: OpenOptions): PlannerStore {
    return new PlannerStore(opts);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  get schemaVersion(): number {
    return Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
  }

  private migrate(): void {
    this.transaction(() => {
      const current = this.schemaVersion;
      for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        this.db.exec(m.sql);
        this.db.exec(`PRAGMA user_version = ${m.version}`);
      }
    });
  }

  /** Runs `fn` in a BEGIN IMMEDIATE transaction (write lock up front). Nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  // ---------------------------------------------------------------- meta

  getMeta(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return r ? String(r.value) : undefined;
  }

  setMeta(key: string, value: string | number): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, String(value));
  }

  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }

  /**
   * A planner-wide setting: stored in `meta` **and** bumping the revision, so the other process
   * notices within its tick. `setMeta` alone is silent, which is right for bookkeeping the daemon
   * does not care about (plan_to, resume_at) and wrong for anything that changes the schedule.
   */
  setSetting(key: string, value: string): void {
    this.transaction(() => {
      this.setMeta(key, value);
      this.bumpRev();
    });
  }

  allMeta(): Record<string, string> {
    const rows = this.db.prepare("SELECT key, value FROM meta ORDER BY key").all() as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.key), String(r.value)]));
  }

  getAnchor = () => this.getMeta(META.anchor);
  setAnchor = (date: string) => this.setMeta(META.anchor, date);
  getTimeZone = () => this.getMeta(META.timeZone);
  setTimeZone = (tz: string) => this.setMeta(META.timeZone, tz);
  getCalendarId = () => this.getMeta(META.calendarId);
  setCalendarId = (id: string) => this.setMeta(META.calendarId, id);
  getHorizon = () => {
    const v = this.getMeta(META.horizon);
    return v ? Number(v) : undefined;
  };
  setHorizon = (days: number) => this.setMeta(META.horizon, days);
  getPlanFrom = () => this.getMeta(META.planFrom);
  setPlanFrom = (date: string) => this.setMeta(META.planFrom, date);

  /** Monotonic revision of plan + status data. */
  planRev(): number {
    return Number(this.getMeta(META.planRev) ?? 0);
  }
  // ---------------------------------------------------------------- pause (P8)

  /** The pause instant in epoch ms (millisecond precision), or undefined when the plan is running. */
  pausedSince(): number | undefined {
    const v = this.getMeta(META.pausedSince);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  /**
   * The pause instant only while the pause is still LIVE, i.e. no older than the 24 h an exact shift
   * can apply (docs/PLAN.md, P8 rule 7/8). A pause nobody resumed for longer than that can no longer
   * be applied, so it stops freezing anything: the API lets shifts through again and the daemon fires
   * boundaries again. **This is the single definition of "the plan is paused right now"** - the API and
   * the daemon both read it here, so they can never disagree about whether a pause is live.
   *
   * `pausedSince()` is the raw state, which stays reported by /health and /today and still blocks a
   * second `pause`, and which `resume` needs in order to refuse a too-long pause without losing it.
   */
  freshPausedSince(nowMs: number): number | undefined {
    const since = this.pausedSince();
    return since !== undefined && nowMs - since <= MAX_SHIFT_MS ? since : undefined;
  }

  /** Freeze the plan at `ms`. Bumps `planRev` so the other process notices within one tick. */
  setPausedSince(ms: number): void {
    if (!Number.isFinite(ms)) throw new RangeError(`pause instant must be finite epoch ms, got ${String(ms)}`);
    this.transaction(() => {
      this.setMeta(META.pausedSince, String(Math.round(ms)));
      this.bumpRev();
    });
  }

  /** Clear the pause. Bumps `planRev`. Safe when there is none. */
  clearPausedSince(): void {
    this.transaction(() => {
      this.deleteMeta(META.pausedSince);
      this.bumpRev();
    });
  }

  private bumpRev(): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1")
      .run(META.planRev);
  }

  // ---------------------------------------------------------------- task status

  getStatus(key: string): StatusRow | undefined {
    const r = this.db.prepare("SELECT key, status, updated_at FROM task_status WHERE key = ?").get(key) as Row | undefined;
    return r ? { key: String(r.key), status: r.status as ItemStatus, updatedAt: String(r.updated_at) } : undefined;
  }

  /** Task-level status. `key` is a task uid, or `${uid}@${date}` for daily tasks (see core statusKey). */
  setStatus(key: string, status: ItemStatus, at: string = new Date().toISOString()): void {
    if (!ITEM_STATUSES.includes(status)) throw new RangeError(`invalid status "${status}"`);
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO task_status (key, status, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
        )
        .run(key, status, at);
      this.bumpRev();
    });
  }

  listStatuses(): StatusRow[] {
    return (this.db.prepare("SELECT key, status, updated_at FROM task_status ORDER BY key").all() as Row[]).map((r) => ({
      key: String(r.key),
      status: r.status as ItemStatus,
      updatedAt: String(r.updated_at),
    }));
  }

  /** Snapshot usable as core's StatusLookup. */
  statusLookup(): Map<string, ItemStatus> {
    const m = new Map<string, ItemStatus>();
    for (const r of this.db.prepare("SELECT key, status FROM task_status").all() as Row[]) m.set(String(r.key), r.status as ItemStatus);
    return m;
  }

  // ---------------------------------------------------------------- plan items
  //
  // Every item row is either on its day's timeline (placed = 1) or in the day's `checked` list
  // (placed = 0: a done/skipped item that lost its slot). Reads default to both unless noted.

  private static parse(r: Row): PlanItem {
    const it = JSON.parse(String(r.json)) as PlanItem;
    it.status = r.status as ItemStatus;
    return it;
  }

  getItem(key: string): PlanItem | undefined {
    return this.getItemRow(key)?.item;
  }

  /** The item and whether it is on the timeline. */
  getItemRow(key: string): { item: PlanItem; placed: boolean } | undefined {
    const r = this.db.prepare("SELECT json, status, placed FROM plan_items WHERE key = ?").get(key) as Row | undefined;
    return r ? { item: PlannerStore.parse(r), placed: Number(r.placed) === 1 } : undefined;
  }

  /** One date: the chronological timeline plus the checked list. */
  getDay(date: string): StoredDay {
    const rows = this.db.prepare("SELECT json, status, placed FROM plan_items WHERE date = ? ORDER BY start_ms, key").all(date) as Row[];
    return {
      date,
      items: rows.filter((r) => Number(r.placed) === 1).map(PlannerStore.parse),
      checked: rows.filter((r) => Number(r.placed) === 0).map(PlannerStore.parse),
    };
  }

  /** `days` consecutive dates from `from` (empty days included). */
  getRange(from: string, days: number): StoredDay[] {
    if (days <= 0) return [];
    const to = addDays(from, days - 1);
    const rows = this.db
      .prepare("SELECT json, status, date, placed FROM plan_items WHERE date >= ? AND date <= ? ORDER BY date, start_ms, key")
      .all(from, to) as Row[];
    const byDate = new Map<string, StoredDay>();
    for (const r of rows) {
      const d = String(r.date);
      const day = byDate.get(d) ?? { date: d, items: [], checked: [] };
      (Number(r.placed) === 1 ? day.items : day.checked).push(PlannerStore.parse(r));
      byDate.set(d, day);
    }
    return Array.from({ length: days }, (_, i) => {
      const date = addDays(from, i);
      return byDate.get(date) ?? { date, items: [], checked: [] };
    });
  }

  /** Items with `from <= date <= to`, chronological. */
  getItemsBetween(from: string, to: string, which: Which = "all"): PlanItem[] {
    return (
      this.db.prepare(`SELECT json, status FROM plan_items WHERE date >= ? AND date <= ?${WHERE[which]} ORDER BY start_ms, key`).all(from, to) as Row[]
    ).map(PlannerStore.parse);
  }

  /** Timeline items whose [start, end) overlaps [fromMs, toMs). Used by the daemon for boundary scans. */
  getItemsOverlapping(fromMs: number, toMs: number): PlanItem[] {
    return (
      this.db.prepare("SELECT json, status FROM plan_items WHERE end_ms > ? AND start_ms < ? AND placed = 1 ORDER BY start_ms, key").all(fromMs, toMs) as Row[]
    ).map(PlannerStore.parse);
  }

  itemsForTask(uid: string, which: Which = "all"): PlanItem[] {
    return (this.db.prepare(`SELECT json, status FROM plan_items WHERE task_uid = ?${WHERE[which]} ORDER BY start_ms, key`).all(uid) as Row[]).map(
      PlannerStore.parse,
    );
  }

  itemKeys(fromDate?: string): string[] {
    const rows = fromDate
      ? (this.db.prepare("SELECT key FROM plan_items WHERE date >= ? ORDER BY date, start_ms").all(fromDate) as Row[])
      : (this.db.prepare("SELECT key FROM plan_items ORDER BY date, start_ms").all() as Row[]);
    return rows.map((r) => String(r.key));
  }

  /** First and last stored dates, optionally only dates >= `from`. */
  dateBounds(from?: string): { first: string; last: string } | null {
    const r = (
      from
        ? this.db.prepare("SELECT MIN(date) AS first, MAX(date) AS last FROM plan_items WHERE date >= ?").get(from)
        : this.db.prepare("SELECT MIN(date) AS first, MAX(date) AS last FROM plan_items").get()
    ) as Row;
    return r.first ? { first: String(r.first), last: String(r.last) } : null;
  }

  private insertItem(it: PlanItem, placed = true): void {
    this.db
      .prepare(
        `INSERT INTO plan_items (key, date, start, "end", start_ms, end_ms, kind, task_uid, status, json, placed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET date = excluded.date, start = excluded.start, "end" = excluded."end", start_ms = excluded.start_ms,
           end_ms = excluded.end_ms, kind = excluded.kind, task_uid = excluded.task_uid, status = excluded.status, json = excluded.json,
           placed = excluded.placed`,
      )
      .run(it.key, it.date, it.start, it.end, toMs(it.start), toMs(it.end), it.kind, it.taskUid ?? null, it.status, JSON.stringify(it), placed ? 1 : 0);
  }

  /** Insert or replace items by key (on the timeline, or into the checked list with `placed: false`). */
  upsertItems(items: readonly PlanItem[], placed = true): void {
    this.transaction(() => {
      for (const it of items) this.insertItem(it, placed);
      this.bumpRev();
    });
  }

  /**
   * Replace every item of the given dates (and of the dates of `days`) with `days`' timeline and
   * checked items, in one transaction. With `keepStatus`, a new timeline item whose key existed with a
   * non-pending status keeps it.
   */
  replaceDays(days: readonly (PlanDay & { checked?: readonly PlanItem[] })[], opts: { dates?: readonly string[]; keepStatus?: boolean } = {}): void {
    this.transaction(() => {
      const dates = new Set([...(opts.dates ?? []), ...days.map((d) => d.date)]);
      const kept = new Map<string, ItemStatus>();
      if (opts.keepStatus)
        for (const d of dates)
          // Only a row that is ON the timeline may hand its status to the new timeline item with that
          // key; a checked row keeps its own status where it is, and never colours a fresh item.
          for (const r of this.db.prepare("SELECT key, status FROM plan_items WHERE date = ? AND status != 'pending' AND placed = 1").all(d) as Row[])
            kept.set(String(r.key), r.status as ItemStatus);
      const del = this.db.prepare("DELETE FROM plan_items WHERE date = ?");
      for (const d of dates) del.run(d);
      for (const d of days) {
        for (const it of d.items) this.insertItem(kept.has(it.key) ? { ...it, status: kept.get(it.key)! } : it, true);
        for (const it of d.checked ?? []) this.insertItem(it, false);
      }
      this.bumpRev();
    });
  }

  /** Delete every item dated >= `from`, then insert `days`. */
  replaceFrom(from: string, days: readonly (PlanDay & { checked?: readonly PlanItem[] })[], opts: { keepStatus?: boolean } = {}): void {
    this.transaction(() => {
      const bounds = this.dateBounds(from);
      const dates: string[] = [];
      if (bounds) for (let i = 0; i <= daysBetween(from, bounds.last); i++) dates.push(addDays(from, i));
      this.replaceDays(days, { dates, keepStatus: opts.keepStatus });
    });
  }

  /** Apply a diff atomically: delete `remove`, upsert `upsert` on the timeline and `checked` off it. */
  applyChanges(changes: { upsert?: readonly PlanItem[]; remove?: readonly string[]; checked?: readonly PlanItem[] }): void {
    this.transaction(() => {
      const del = this.db.prepare("DELETE FROM plan_items WHERE key = ?");
      for (const k of changes.remove ?? []) del.run(k);
      for (const it of changes.upsert ?? []) this.insertItem(it, true);
      for (const it of changes.checked ?? []) this.insertItem(it, false);
      this.bumpRev();
    });
  }

  /** Set the stored status of one item (and optionally merge fields). Keeps its placement. */
  setItemStatus(key: string, status: ItemStatus, patch: object = {}): PlanItem | undefined {
    if (!ITEM_STATUSES.includes(status)) throw new RangeError(`invalid status "${status}"`);
    return this.transaction(() => {
      const row = this.getItemRow(key);
      if (!row) return undefined;
      const next = { ...row.item, ...patch, status } as PlanItem;
      this.insertItem(next, row.placed);
      this.bumpRev();
      return next;
    });
  }

  /**
   * Merge fields into one stored item, keeping its key, its placement and its status. A field set to
   * `undefined` is removed. Used by P9's restyle, which refreshes what an item shows without
   * re-timing it.
   */
  patchItem(key: string, patch: Partial<PlanItem>): PlanItem | undefined {
    return this.transaction(() => {
      const row = this.getItemRow(key);
      if (!row) return undefined;
      const next = { ...row.item, ...patch } as PlanItem;
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (next as unknown as Record<string, unknown>)[k];
      this.insertItem(next, row.placed);
      this.bumpRev();
      return next;
    });
  }

  /**
   * Rest keys are `${date}|rest|n`, numbered 1.. in chronological order on each date, so the same
   * timeline always has the same keys. Returns the number of rests re-keyed.
   */
  renumberRests(dates: Iterable<string>): number {
    return this.transaction(() => {
      let changed = 0;
      for (const date of new Set(dates)) {
        const rests = this.getDay(date).items.filter((i) => i.kind === "rest");
        const want = rests.map((r, i) => `${date}|rest|${i + 1}`);
        if (rests.every((r, i) => r.key === want[i])) continue;
        const del = this.db.prepare("DELETE FROM plan_items WHERE key = ?");
        for (const r of rests) del.run(r.key);
        rests.forEach((r, i) => this.insertItem({ ...r, key: want[i]! }, true));
        changed += rests.length;
      }
      if (changed) this.bumpRev();
      return changed;
    });
  }

  /**
   * Delete pending items dated before `date` (history is immutable: only done and skipped items stay).
   * `oneOffOnly` keeps the daily slots, whose sessions are recorded in sessions_held. Returns the count.
   */
  deletePendingBefore(date: string, keep: (item: PlanItem) => boolean = () => false): number {
    return this.transaction(() => {
      const stale = (this.db.prepare("SELECT json, status FROM plan_items WHERE date < ? AND status = 'pending' ORDER BY start_ms, key").all(date) as Row[])
        .map(PlannerStore.parse)
        .filter((i) => !keep(i));
      if (!stale.length) return 0;
      const del = this.db.prepare("DELETE FROM plan_items WHERE key = ?");
      for (const i of stale) del.run(i.key);
      this.bumpRev();
      return stale.length;
    });
  }

  /**
   * Everything the store knows about one task, removed together (docs/PLAN.md, P9 rule 4): the
   * notifications fired for its items, the items, its task-level status (the bare uid, plus every
   * `uid@date` a daily task has), its progress and its held sessions. A deleted task must leave
   * nothing behind that a later `POST /reload` could resurrect, so this is the *single* definition of
   * "forget it" - the API's delete goes through here and nowhere else re-derives the table list.
   */
  forgetTask(uid: string): ForgetCounts {
    return this.transaction(() => {
      // Notifications key on the item key, `date|uid|part`. They are matched on the key's **shape**
      // rather than by joining on plan_items, because an item key that stopped existing earlier - a
      // re-split after a duration change, a purged past-pending item, a rollover - left its
      // notification behind and there is no row left to find it from. The `|` on both sides is what
      // keeps `alpha/A1` from also matching `alpha/A10`.
      const notifications = Number(
        this.db.prepare("DELETE FROM notifications WHERE item_key LIKE ? ESCAPE '\\'").run(`%|${likeEscape(uid)}|%`).changes,
      );
      const items = Number(this.db.prepare("DELETE FROM plan_items WHERE task_uid = ?").run(uid).changes);
      // A daily task's status keys are `uid@<date>`; an id may contain `_`, which LIKE treats as a
      // wildcard, hence the explicit escape.
      const statuses = Number(
        this.db.prepare("DELETE FROM task_status WHERE key = ? OR key LIKE ? ESCAPE '\\'").run(uid, `${likeEscape(uid)}@%`).changes,
      );
      const progress = Number(this.db.prepare("DELETE FROM task_progress WHERE uid = ?").run(uid).changes);
      const sessions = Number(this.db.prepare("DELETE FROM sessions_held WHERE task_uid = ?").run(uid).changes);
      const counts = { statuses, items, progress, sessions, notifications };
      if (statuses + items + progress + sessions + notifications > 0) this.bumpRev();
      return counts;
    });
  }

  /** `forgetTask` for a whole plan file, in one transaction. Totals are summed per table. */
  forgetTasks(uids: Iterable<string>): ForgetCounts {
    return this.transaction(() => {
      const total: ForgetCounts = { statuses: 0, items: 0, progress: 0, sessions: 0, notifications: 0 };
      for (const uid of uids) {
        const c = this.forgetTask(uid);
        for (const k of Object.keys(total) as (keyof ForgetCounts)[]) total[k] += c[k];
      }
      return total;
    });
  }

  deleteAllItems(): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM plan_items");
      this.bumpRev();
    });
  }


  // ---------------------------------------------------------------- progress (P7)

  /** Durable progress of every one-off task that has any (core `GenerateInput.progress`). */
  getProgress(): Map<string, TaskProgress> {
    const m = new Map<string, TaskProgress>();
    for (const r of this.db.prepare("SELECT uid, done_min, parts_done FROM task_progress").all() as Row[])
      m.set(String(r.uid), { doneMin: Number(r.done_min), partsDone: Number(r.parts_done) });
    return m;
  }

  getTaskProgress(uid: string): TaskProgress {
    const r = this.db.prepare("SELECT done_min, parts_done FROM task_progress WHERE uid = ?").get(uid) as Row | undefined;
    return { doneMin: Number(r?.done_min ?? 0), partsDone: Number(r?.parts_done ?? 0) };
  }

  /** Set progress absolutely. Both values are floored at 0; a zero row is deleted. */
  setTaskProgress(uid: string, p: TaskProgress): TaskProgress {
    const next = { doneMin: Math.max(0, Math.round(p.doneMin)), partsDone: Math.max(0, Math.round(p.partsDone)) };
    return this.transaction(() => {
      if (!next.doneMin && !next.partsDone) this.db.prepare("DELETE FROM task_progress WHERE uid = ?").run(uid);
      else
        this.db
          .prepare(
            `INSERT INTO task_progress (uid, done_min, parts_done) VALUES (?, ?, ?)
             ON CONFLICT (uid) DO UPDATE SET done_min = excluded.done_min, parts_done = excluded.parts_done`,
          )
          .run(uid, next.doneMin, next.partsDone);
      this.bumpRev();
      return next;
    });
  }

  /** Add a delta to a task's progress (floored at 0, and `doneMin` capped at `cap` when given). */
  addTaskProgress(uid: string, doneMin: number, parts: number, cap = Infinity): TaskProgress {
    const cur = this.getTaskProgress(uid);
    return this.setTaskProgress(uid, { doneMin: Math.min(cap, Math.max(0, cur.doneMin + doneMin)), partsDone: Math.max(0, cur.partsDone + parts) });
  }

  clearTaskProgress(uid: string): void {
    this.setTaskProgress(uid, { doneMin: 0, partsDone: 0 });
  }

  // ---------------------------------------------------------------- sessions held (P7)

  /** Dates on which a session of this daily task was held, ascending. */
  heldSessionDates(uid: string): string[] {
    return (this.db.prepare("SELECT date FROM sessions_held WHERE task_uid = ? ORDER BY date").all(uid) as Row[]).map((r) => String(r.date));
  }

  allHeldSessions(): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const r of this.db.prepare("SELECT task_uid, date FROM sessions_held ORDER BY task_uid, date").all() as Row[])
      m.set(String(r.task_uid), [...(m.get(String(r.task_uid)) ?? []), String(r.date)]);
    return m;
  }

  /** Record that a session was held. Idempotent; returns true when it was new. */
  holdSession(uid: string, date: string): boolean {
    const r = this.db.prepare("INSERT INTO sessions_held (task_uid, date) VALUES (?, ?) ON CONFLICT DO NOTHING").run(uid, date);
    if (Number(r.changes) > 0) {
      this.bumpRev();
      return true;
    }
    return false;
  }

  /** Undo of a session: the date no longer counts toward `occurrences`. */
  releaseSession(uid: string, date: string): void {
    const r = this.db.prepare("DELETE FROM sessions_held WHERE task_uid = ? AND date = ?").run(uid, date);
    if (Number(r.changes) > 0) this.bumpRev();
  }

  // ---------------------------------------------------------------- sync state

  getSyncState(): SyncState {
    const r = this.db.prepare("SELECT * FROM sync_state WHERE id = 1").get() as Row;
    return {
      lastSyncAt: (r.last_sync_at as string | null) ?? null,
      lastResult: r.last_result ? (JSON.parse(String(r.last_result)) as SyncResultCounts) : null,
      lastError: r.last_error ? (JSON.parse(String(r.last_error)) as SyncState["lastError"]) : null,
      pending: Number(r.pending) === 1,
      lastAttemptAt: (r.last_attempt_at as string | null) ?? null,
    };
  }

  updateSyncState(patch: Partial<SyncState>): SyncState {
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    const put = (col: string, v: SQLInputValue) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if ("lastSyncAt" in patch) put("last_sync_at", patch.lastSyncAt ?? null);
    if ("lastResult" in patch) put("last_result", patch.lastResult ? JSON.stringify(patch.lastResult) : null);
    if ("lastError" in patch) put("last_error", patch.lastError ? JSON.stringify(patch.lastError) : null);
    if ("pending" in patch) put("pending", patch.pending ? 1 : 0);
    if ("lastAttemptAt" in patch) put("last_attempt_at", patch.lastAttemptAt ?? null);
    if (sets.length) this.db.prepare(`UPDATE sync_state SET ${sets.join(", ")} WHERE id = 1`).run(...vals);
    return this.getSyncState();
  }

  // ---------------------------------------------------------------- notifications

  /** Records a fired notification. Returns false if (itemKey, type) was already recorded (de-dup across restarts). */
  recordNotification(n: NotificationRecord): boolean {
    const r = this.db
      .prepare("INSERT INTO notifications (at, type, item_key, title) VALUES (?, ?, ?, ?) ON CONFLICT (item_key, type) DO NOTHING")
      .run(n.at, n.type, n.itemKey, n.title);
    return Number(r.changes) > 0;
  }

  hasNotification(itemKey: string, type: NotificationType): boolean {
    return !!this.db.prepare("SELECT 1 FROM notifications WHERE item_key = ? AND type = ?").get(itemKey, type);
  }

  /** Newest first. */
  listNotifications(limit = 50, afterId?: number): (NotificationRecord & { id: number })[] {
    const rows = (
      afterId !== undefined
        ? this.db.prepare("SELECT * FROM notifications WHERE id > ? ORDER BY id DESC LIMIT ?").all(afterId, limit)
        : this.db.prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT ?").all(limit)
    ) as Row[];
    return rows.map((r) => ({ id: Number(r.id), at: String(r.at), type: r.type as NotificationType, itemKey: String(r.item_key), title: String(r.title) }));
  }

  lastNotificationId(): number {
    const r = this.db.prepare("SELECT MAX(id) AS id FROM notifications").get() as Row;
    return Number(r.id ?? 0);
  }
}
