import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanDay, PlanItem } from "@planner/core";
import {
  PlanService,
  PlannerStore,
  SCHEMA_VERSION,
  clockFromEnv,
  closest,
  compressedClock,
  editDistance,
  fixedClock,
  loadResources,
  parseLocalInstant,
  calendarView,
  toChecked,
  withPlanned,
} from "../src/index.ts";

const TZ = "Africa/Tunis";
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/api/test/fixtures/resources");
const dirs: string[] = [];
const stores: PlannerStore[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "planner-store-"));
  dirs.push(d);
  return d;
}
function open(dir: string) {
  const s = new PlannerStore({ dir });
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const item = (date: string, n: number, over: Partial<PlanItem> = {}): PlanItem => ({
  key: `${date}|t/${n}|1`,
  date,
  kind: "task",
  start: `${date}T${String(8 + n).padStart(2, "0")}:00:00+01:00`,
  end: `${date}T${String(8 + n).padStart(2, "0")}:50:00+01:00`,
  taskUid: `t/${n}`,
  track: "t",
  title: `Task ${n}`,
  status: "pending",
  ...over,
});
const day = (date: string, ...ns: number[]): PlanDay => ({ date, items: ns.map((n) => item(date, n)) });

describe("PlannerStore", () => {
  it("migrates to the latest version, WAL mode, idempotent on reopen", () => {
    const dir = tmp();
    const s = open(dir);
    expect(s.schemaVersion).toBe(SCHEMA_VERSION);
    expect((s.db.prepare("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
    expect(Number((s.db.prepare("PRAGMA busy_timeout").get() as any).timeout)).toBeGreaterThan(0);
    s.setMeta("x", 1);
    s.close();
    const s2 = open(dir);
    expect(s2.schemaVersion).toBe(SCHEMA_VERSION);
    expect(s2.getMeta("x")).toBe("1");
  });

  it("meta helpers", () => {
    const s = open(tmp());
    expect(s.getAnchor()).toBeUndefined();
    s.setAnchor("2026-09-28");
    s.setCalendarId("cal1");
    s.setHorizon(28);
    expect([s.getAnchor(), s.getCalendarId(), s.getHorizon()]).toEqual(["2026-09-28", "cal1", 28]);
    expect(s.allMeta()).toMatchObject({ anchor: "2026-09-28", calendar_id: "cal1" });
  });

  it("task status and lookup; plan rev increments", () => {
    const s = open(tmp());
    const r0 = s.planRev();
    s.setStatus("a/1", "done", "2026-09-28T10:00:00Z");
    s.setStatus("d/DAILY@2026-09-28", "skipped");
    expect(s.getStatus("a/1")).toEqual({ key: "a/1", status: "done", updatedAt: "2026-09-28T10:00:00Z" });
    expect([...s.statusLookup()]).toEqual(expect.arrayContaining([["a/1", "done"], ["d/DAILY@2026-09-28", "skipped"]]));
    expect(() => s.setStatus("a/1", "nope" as never)).toThrow();
    expect(s.planRev()).toBe(r0 + 2);
  });

  it("items: replaceDays (atomic, keepStatus), getDay/getRange/applyChanges/setItemStatus", () => {
    const s = open(tmp());
    s.replaceDays([day("2026-09-28", 0, 1, 2), day("2026-09-29", 0)]);
    expect(s.getDay("2026-09-28").items.map((i) => i.key)).toEqual(["2026-09-28|t/0|1", "2026-09-28|t/1|1", "2026-09-28|t/2|1"]);
    expect(s.setItemStatus("2026-09-28|t/1|1", "done")!.status).toBe("done");
    s.replaceDays([day("2026-09-28", 1, 3)], { keepStatus: true });
    const d = s.getDay("2026-09-28").items;
    expect(d.map((i) => [i.key, i.status])).toEqual([
      ["2026-09-28|t/1|1", "done"],
      ["2026-09-28|t/3|1", "pending"],
    ]);
    const range = s.getRange("2026-09-27", 4);
    expect(range.map((x) => [x.date, x.items.length])).toEqual([["2026-09-27", 0], ["2026-09-28", 2], ["2026-09-29", 1], ["2026-09-30", 0]]);
    s.applyChanges({ remove: ["2026-09-29|t/0|1"], upsert: [item("2026-09-30", 5)] });
    expect(s.dateBounds()).toEqual({ first: "2026-09-28", last: "2026-09-30" });
    expect(s.itemsForTask("t/5").map((i) => i.date)).toEqual(["2026-09-30"]);
    // A failing transaction leaves nothing behind.
    expect(() =>
      s.transaction(() => {
        s.replaceDays([day("2026-09-28")]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.getDay("2026-09-28").items).toHaveLength(2);
    s.replaceFrom("2026-09-29", [day("2026-09-29", 7)]);
    expect(s.getItemsBetween("2026-09-28", "2026-12-31").map((i) => i.key)).toEqual(["2026-09-28|t/1|1", "2026-09-28|t/3|1", "2026-09-29|t/7|1"]);
    expect(s.getItemsOverlapping(Date.parse("2026-09-28T09:30:00+01:00"), Date.parse("2026-09-28T11:10:00+01:00")).map((i) => i.key)).toEqual([
      "2026-09-28|t/1|1",
      "2026-09-28|t/3|1",
    ]);
  });

  it("notifications are de-duplicated by (itemKey, type) across reopen", () => {
    const dir = tmp();
    const s = open(dir);
    expect(s.recordNotification({ at: "a", type: "task_start", itemKey: "k", title: "T" })).toBe(true);
    expect(s.recordNotification({ at: "a", type: "task_end", itemKey: "k", title: "T" })).toBe(true);
    s.close();
    const s2 = open(dir);
    expect(s2.recordNotification({ at: "b", type: "task_start", itemKey: "k", title: "T" })).toBe(false);
    expect(s2.hasNotification("k", "task_end")).toBe(true);
    expect(s2.listNotifications().map((n) => n.type)).toEqual(["task_end", "task_start"]);
    expect(s2.listNotifications(10, 1).map((n) => n.type)).toEqual(["task_end"]);
  });

  it("sync state, progress and held sessions (P7)", () => {
    const s = open(tmp());
    expect(s.getSyncState()).toEqual({ lastSyncAt: null, lastResult: null, lastError: null, pending: false, lastAttemptAt: null });
    s.updateSyncState({ pending: true, lastError: { code: "X", message: "m", at: "t" } });
    s.updateSyncState({ lastResult: { inserted: 1, patched: 0, deleted: 0, unchanged: 2 }, lastSyncAt: "t2" });
    expect(s.getSyncState()).toMatchObject({ pending: true, lastSyncAt: "t2", lastResult: { inserted: 1 }, lastError: { code: "X" } });
    // task_progress: absolute, delta-based and capped; a zero row is deleted.
    expect(s.getTaskProgress("t/1")).toEqual({ doneMin: 0, partsDone: 0 });
    expect(s.setTaskProgress("t/1", { doneMin: 45, partsDone: 1 })).toEqual({ doneMin: 45, partsDone: 1 });
    expect(s.addTaskProgress("t/1", 60, 1, 90)).toEqual({ doneMin: 90, partsDone: 2 });
    expect(s.addTaskProgress("t/1", -500, -5)).toEqual({ doneMin: 0, partsDone: 0 });
    expect([...s.getProgress()]).toEqual([]);
    s.setTaskProgress("t/2", { doneMin: 30, partsDone: 1 });
    expect([...s.getProgress()]).toEqual([["t/2", { doneMin: 30, partsDone: 1 }]]);
    s.clearTaskProgress("t/2");
    expect([...s.getProgress()]).toEqual([]);
    // sessions_held: one row per date, idempotent, releasable.
    expect(s.holdSession("l/DAILY", "2026-09-28")).toBe(true);
    expect(s.holdSession("l/DAILY", "2026-09-28")).toBe(false);
    s.holdSession("l/DAILY", "2026-09-29");
    expect(s.heldSessionDates("l/DAILY")).toEqual(["2026-09-28", "2026-09-29"]);
    s.releaseSession("l/DAILY", "2026-09-28");
    expect([...s.allHeldSessions()]).toEqual([["l/DAILY", ["2026-09-29"]]]);
  });

  it("pending items before a date are not history: deletePendingBefore removes them", () => {
    const s = open(tmp());
    s.replaceDays([day("2026-09-27", 1, 2), day("2026-09-28", 3, 4)]);
    s.setItemStatus("2026-09-27|t/1|1", "done");
    expect(s.deletePendingBefore("2026-09-28")).toBe(1); // t/2 (pending) goes, t/1 (done) stays
    expect(s.getItemsBetween("2026-09-27", "2026-09-27").map((i) => [i.key, i.status])).toEqual([["2026-09-27|t/1|1", "done"]]);
    expect(s.deletePendingBefore("2026-09-29", (i) => i.taskUid === "t/3")).toBe(1);
    expect(s.getDay("2026-09-28").items.map((i) => i.key)).toEqual(["2026-09-28|t/3|1"]);
  });

  it("keepStatus takes a status only from the timeline, never from a checked row", () => {
    const s = open(tmp());
    const done = item("2026-09-28", 1, { status: "done" });
    // The same key exists off the timeline (checked). A fresh timeline item must not inherit its status.
    s.replaceDays([{ date: "2026-09-28", items: [], checked: [done] }]);
    expect(s.getItemRow(done.key)).toMatchObject({ placed: false, item: { status: "done" } });
    s.replaceDays([day("2026-09-28", 1)], { keepStatus: true });
    expect(s.getDay("2026-09-28").items.map((i) => [i.key, i.status])).toEqual([[done.key, "pending"]]);
    // A non-pending row that IS on the timeline still hands its status over.
    s.setItemStatus(done.key, "done");
    s.replaceDays([day("2026-09-28", 1)], { keepStatus: true });
    expect(s.getDay("2026-09-28").items.map((i) => [i.key, i.status])).toEqual([[done.key, "done"]]);
  });

  it("two connections on one file (API + daemon) both write", () => {
    const dir = tmp();
    const a = open(dir);
    const b = open(dir);
    a.replaceDays([day("2026-09-28", 0)]);
    b.setStatus("t/0", "done");
    b.recordNotification({ at: "x", type: "rest_start", itemKey: "k", title: "Rest" });
    expect(a.getStatus("t/0")?.status).toBe("done");
    expect(b.getDay("2026-09-28").items).toHaveLength(1);
    expect(a.planRev()).toBe(b.planRev());
  });
});

describe("checked items", () => {
  it("toChecked shows the original slot (captured once) and keeps the last timeline slot for sync", () => {
    const original = item("2026-09-28", 2, { status: "done" }); // 10:00-10:50
    const planned = withPlanned(original);
    const moved = { ...planned, start: "2026-09-28T11:00:00+01:00", end: "2026-09-28T11:50:00+01:00" }; // shifted later
    expect(withPlanned(moved).plannedStart).toBe(original.start); // never overwritten
    const c = toChecked(moved, true);
    expect([c.start, c.end, c.lastStart, c.lastEnd]).toEqual([original.start, original.end, moved.start, moved.end]);
    const again = toChecked(c, false);
    expect([again.start, again.lastStart]).toEqual([original.start, moved.start]);
    const cal = calendarView(c);
    expect([cal.start, cal.end]).toEqual([moved.start, moved.end]);
  });

  it("getDay splits timeline and checked; renumberRests keys rests chronologically", () => {
    const s = open(tmp());
    const hh = (h: number) => String(h).padStart(2, "0");
    const rest = (n: number, h: number): PlanItem => ({
      key: `2026-09-28|rest|${n}`,
      date: "2026-09-28",
      kind: "rest",
      start: `2026-09-28T${hh(h)}:50:00+01:00`,
      end: `2026-09-28T${hh(h + 1)}:00:00+01:00`,
      title: "Rest",
      restKind: "short",
      status: "pending",
    });
    s.replaceDays([{ date: "2026-09-28", items: [item("2026-09-28", 0), rest(7, 8), item("2026-09-28", 1), rest(2, 9)], checked: [item("2026-09-28", 5, { status: "done" })] }]);
    const d = s.getDay("2026-09-28");
    expect(d.items).toHaveLength(4);
    expect(d.checked.map((i) => i.key)).toEqual(["2026-09-28|t/5|1"]);
    expect(s.getItemsOverlapping(0, 9e15).some((i) => i.key === "2026-09-28|t/5|1")).toBe(false);
    s.renumberRests(["2026-09-28"]);
    expect(s.getDay("2026-09-28").items.filter((i) => i.kind === "rest").map((i) => i.key)).toEqual(["2026-09-28|rest|1", "2026-09-28|rest|2"]);
    expect(s.getItemRow("2026-09-28|t/5|1")?.placed).toBe(false);
  });
});

describe("clock", () => {
  it("fixed, local without offset, compressed, env", () => {
    expect(parseLocalInstant("2026-09-28T07:59:00", TZ)).toBe(Date.parse("2026-09-28T07:59:00+01:00"));
    expect(parseLocalInstant("2026-09-28T07:59:00Z", TZ)).toBe(Date.parse("2026-09-28T07:59:00Z"));
    expect(() => parseLocalInstant("yesterday", TZ)).toThrow();
    const f = fixedClock("2026-09-28T10:00:00+01:00", TZ);
    f.advance(60_000);
    expect(f.now()).toBe(Date.parse("2026-09-28T10:01:00+01:00"));
    let real = 1000;
    const c = compressedClock("2026-09-28T07:59:00", 600, TZ, () => real);
    real += 1000; // 1 real second = 10 simulated minutes
    expect(c.now()).toBe(Date.parse("2026-09-28T08:09:00+01:00"));
    expect(clockFromEnv({ PLANNER_NOW: "2026-09-28T10:15:00+02:00" }, TZ).now()).toBe(Date.parse("2026-09-28T08:15:00Z"));
    const e = clockFromEnv({ PLANNER_CLOCK: "start=2026-09-28T07:59:00,speed=600" }, TZ);
    expect(e.kind).toBe("compressed");
    expect(e.speed).toBe(600);
    expect(Math.abs(e.now() - Date.parse("2026-09-28T07:59:00+01:00"))).toBeLessThan(600_000);
    expect(clockFromEnv({}, TZ).kind).toBe("system");
  });

  it("edit distance and closest match", () => {
    expect(editDistance("bcg/A99", "bcg/A9")).toBe(1);
    expect(closest("bcg/a1", ["bcg/A1", "sf/A1", "bcg/B1"])).toBe("bcg/A1");
  });
});

describe("PlanService", () => {
  const files = loadResources(FIXTURES).files;
  const svc = (dir: string, now: string) => {
    const clock = fixedClock(now, TZ);
    const store = open(dir);
    return { s: new PlanService({ store, clock, timeZone: TZ, horizon: 7, files }), clock, store };
  };

  it("first start sets the anchor and materializes the horizon; second call is a no-op", () => {
    const { s, store } = svc(tmp(), "2026-09-28T10:15:00+01:00");
    expect(s.ensureCurrent()).toHaveLength(7);
    expect(store.getAnchor()).toBe("2026-09-28");
    expect(s.ensureCurrent()).toBeNull();
    expect(store.dateBounds()).toEqual({ first: "2026-09-28", last: "2026-10-04" });
  });

  it("midnight rollover regenerates from today with actual status; unfinished work comes back first", () => {
    const { s, store, clock } = svc(tmp(), "2026-09-28T10:15:00+01:00");
    s.ensureCurrent();
    const d0 = store.getDay("2026-09-28").items.filter((i) => i.kind === "task");
    s.setItemStatus(d0[0]!.key, "done"); // A1 done, A2 left unfinished
    const revBefore = store.planRev();
    clock.set("2026-09-29T00:05:00+01:00");
    const rolled = s.ensureCurrent();
    expect(rolled?.[0]).toBe("2026-09-29");
    expect(store.planRev()).toBeGreaterThan(revBefore);
    expect(store.getAnchor()).toBe("2026-09-28"); // the anchor never moves
    const d1 = store.getDay("2026-09-29").items.filter((i) => i.kind === "task");
    expect(d1[0]!.taskUid).toBe("alpha/A2");
    expect(d1[0]!.start).toBe("2026-09-29T08:00:00+01:00");
    expect(d1.some((i) => i.taskUid === "alpha/A1")).toBe(false);
    // Yesterday is history and stays.
    expect(store.getDay("2026-09-28").items[0]!.status).toBe("done");
    expect(store.dateBounds()!.last).toBe("2026-10-05");
    expect(s.ensureCurrent()).toBeNull();
  });

  it("a second process sees the rollover already done", () => {
    const dir = tmp();
    const a = svc(dir, "2026-09-28T10:15:00+01:00");
    a.s.ensureCurrent();
    a.clock.set("2026-09-29T00:01:00+01:00");
    const b = svc(dir, "2026-09-29T00:01:00+01:00");
    expect(b.s.ensureCurrent()?.[0]).toBe("2026-09-29");
    expect(a.s.ensureCurrent()).toBeNull();
  });
});
