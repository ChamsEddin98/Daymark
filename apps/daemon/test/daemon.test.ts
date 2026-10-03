import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addDays, type PlanItem } from "@planner/core";
import { PlanService, PlannerStore, compressedClock, loadResources, type NotificationRecord } from "@planner/store";
import { Daemon } from "../src/daemon.ts";
import { LogSink, ToastSink, sinksFromEnv, toastResult, type NotifierLike, type ToastOutcome } from "../src/sinks.ts";
import { SyncRetrier } from "../src/sync.ts";
import { DAY, MIN, RESOURCES, TZ, cleanup, makeDaemon, runUntil, sleep, tempDir, waitFor, type TestDaemon, MemorySink, notAuthorized } from "./helpers.ts";

const dirs: string[] = [];
const daemons: Daemon[] = [];
const stores: PlannerStore[] = [];
function dir() {
  const d = tempDir();
  dirs.push(d);
  return d;
}
function daemon(d: string, at: string, o?: Parameters<typeof makeDaemon>[2]): TestDaemon {
  const t = makeDaemon(d, at, o);
  daemons.push(t.daemon);
  return t;
}
/** A second process' view of the same DB (the API's role). */
function apiService(d: string, clock: PlanService["clock"]) {
  const store = new PlannerStore({ dir: d });
  stores.push(store);
  return new PlanService({ store, clock, timeZone: TZ, horizon: 7, files: loadResources(RESOURCES).files });
}
afterEach(async () => {
  for (const x of daemons.splice(0)) await x.stop();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) cleanup(d);
});

type Expected = { key: string; type: NotificationRecord["type"]; atMs: number };
function expectedFor(items: PlanItem[]): Expected[] {
  return items.flatMap((it) => {
    const task = it.kind === "task";
    return [
      { key: it.key, type: task ? "task_start" : "rest_start", atMs: Date.parse(it.start) },
      { key: it.key, type: task ? "task_end" : "rest_end", atMs: Date.parse(it.end) },
    ] as Expected[];
  });
}
const allRecords = (store: PlannerStore) => store.listNotifications(10_000).reverse();
const id = (r: { itemKey: string; type: string }) => `${r.itemKey}#${r.type}`;

describe("full generated day", () => {
  it("fires every boundary exactly once, with the right type, within 1 simulated minute (manual clock)", () => {
    const d = dir();
    const t = daemon(d, `${DAY}T07:59:00`, { sinks: undefined, env: { PLANNER_NOTIFY: "log" } });
    const items = t.daemon.store.getDay(DAY).items;
    expect(items.length).toBeGreaterThan(5);
    runUntil(t, `${DAY}T23:59:00+01:00`, 30_000);

    const recs = allRecords(t.daemon.store);
    const want = expectedFor(items);
    expect(recs.map(id).sort()).toEqual(want.map((w) => `${w.key}#${w.type}`).sort());
    expect(new Set(recs.map(id)).size).toBe(recs.length);
    for (const w of want) {
      const r = recs.find((x) => x.itemKey === w.key && x.type === w.type)!;
      const lag = Date.parse(r.at) - w.atMs;
      expect(lag).toBeGreaterThanOrEqual(0);
      expect(lag).toBeLessThanOrEqual(MIN);
    }
    expect(new Set(recs.map((r) => r.type))).toEqual(new Set(["task_start", "task_end", "rest_start", "rest_end"]));

    // JSONL log: one line per record, same pairs
    const lines = readFileSync(join(d, "notifications.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map(id).sort()).toEqual(recs.map(id).sort());
    expect(lines[0]).toMatchObject({ type: "task_start", due: items[0]!.start });
    expect(lines[0].toast.title).toMatch(/^Start: /);
  });

  it("compressed clock (speed 1200) with the real loop: morning fires within 1 simulated minute (sleeps until the next boundary)", async () => {
    const d = dir();
    // the compressed clock starts when the loop starts (building the plan takes real time)
    let c: ReturnType<typeof compressedClock> | undefined;
    const start = Date.parse(`${DAY}T07:59:00+01:00`);
    const clock = { kind: "compressed" as const, speed: 1200, now: () => (c ? c.now() : start) };
    const t = daemon(d, `${DAY}T07:59:00`, { clock });
    const until = Date.parse(`${DAY}T10:05:00+01:00`);
    const items = t.daemon.store.getItemsOverlapping(0, until).filter((it) => it.date === DAY);
    const want = expectedFor(items).filter((w) => w.atMs <= Date.parse(`${DAY}T10:00:00+01:00`));
    c = compressedClock(start, 1200, TZ);
    t.daemon.start();
    await waitFor(() => clock.now() >= until, 20_000);
    await sleep(50);
    const recs = allRecords(t.daemon.store);
    for (const w of want) {
      const r = recs.find((x) => x.itemKey === w.key && x.type === w.type);
      expect(r, `${w.key} ${w.type}`).toBeDefined();
      expect(Date.parse(r!.at) - w.atMs).toBeLessThanOrEqual(MIN);
    }
    expect(new Set(recs.map(id)).size).toBe(recs.length);
  }, 30_000);

  it("sleeps until the next boundary when it is closer than a normal tick", () => {
    const d = dir();
    const start = Date.parse(`${DAY}T07:59:55+01:00`); // 5 s before 08:00
    const t = daemon(d, `${DAY}T07:00:00`, { clock: { kind: "compressed", speed: 2400, now: () => start } });
    expect(t.daemon.tickMs()).toBe(20);
    expect(t.daemon.sleepMs()).toBe(4); // ceil(5000 / 2400) + 1
  });
});

describe("status", () => {
  it("done/skipped tasks fire no task boundaries; rests still fire; done early suppresses task_end", () => {
    const d = dir();
    const t = daemon(d, `${DAY}T07:59:00`);
    const tasks = t.daemon.store.getDay(DAY).items.filter((it) => it.kind === "task");
    const [first, second, third] = [tasks[0]!, tasks[1]!, tasks[2]!];
    t.daemon.service.setItemStatus(second.key, "done");
    t.daemon.service.setItemStatus(third.key, "skipped");
    // first: starts, then marked done 5 min before its end
    runUntil(t, Date.parse(first.end) - 5 * MIN);
    t.daemon.service.setItemStatus(first.key, "done");
    runUntil(t, `${DAY}T23:59:00+01:00`);
    const recs = allRecords(t.daemon.store);
    const types = (k: string) => recs.filter((r) => r.itemKey === k).map((r) => r.type);
    expect(types(first.key)).toEqual(["task_start"]);
    expect(types(second.key)).toEqual([]);
    expect(types(third.key)).toEqual([]);
    const rests = t.daemon.store.getDay(DAY).items.filter((it) => it.kind === "rest");
    for (const r of rests) expect(types(r.key).sort()).toEqual(["rest_end", "rest_start"]);
  });
});

describe("restart and grace window", () => {
  it("a restart mid-day fires no duplicates", async () => {
    const d = dir();
    const a = daemon(d, `${DAY}T07:59:00`);
    const items = a.daemon.store.getDay(DAY).items;
    const b0 = items[2]!; // restart 30 s after this item's start: inside the grace window
    runUntil(a, Date.parse(b0.start) + 30_000);
    await a.daemon.stop();
    daemons.splice(daemons.indexOf(a.daemon), 1);
    const peek = new PlannerStore({ dir: d });
    stores.push(peek);
    const before = allRecords(peek);
    expect(before.some((r) => r.itemKey === b0.key)).toBe(true);

    const b = daemon(d, new Date(Date.parse(b0.start) + 60_000).toISOString());
    b.daemon.tick();
    expect(b.sink.records).toEqual([]);
    expect(b.daemon.scanner.stats.duplicates).toBeGreaterThan(0);
    runUntil(b, `${DAY}T23:59:00+01:00`);
    const recs = allRecords(b.daemon.store);
    expect(new Set(recs.map(id)).size).toBe(recs.length);
    expect(recs.length).toBe(expectedFor(items).length);
  });

  it("on startup, boundaries older than the grace window (2 min) are skipped and logged; a boundary 1 min old still fires", () => {
    const d = dir();
    const t = daemon(d, `${DAY}T10:15:00`);
    t.daemon.tick();
    const now = t.clock.now();
    const core = t.sink.records.filter((r) => r.type !== "resume");
    for (const r of core) expect(now - Date.parse(r.due)).toBeLessThanOrEqual(2 * MIN);
    // 08:00 .. 09:50 start of F3: 11 boundaries (F1, rest1, F2, rest2 start/end + F3 start)
    expect(t.logs.find((l) => l.includes("skipped"))).toMatch(/^first start: skipped 9 boundaries earlier today/);
    expect(t.daemon.scanner.stats.stale).toBe(9);

    const d2 = dir();
    const items = daemon(d2, `${DAY}T07:00:00`).daemon.store.getDay(DAY).items;
    const t2 = daemon(d2, new Date(Date.parse(items[1]!.start) + MIN).toISOString());
    t2.daemon.tick();
    const fired = t2.sink.records.map((r) => `${r.itemKey}#${r.type}`);
    expect(fired).toContain(`${items[1]!.key}#${items[1]!.kind}_start`);
    expect(fired).not.toContain(`${items[0]!.key}#${items[0]!.kind}_start`);
  });

  it("startup mid-item sends one 'Now: …' resume toast, recorded as `resume`, never repeated by restarts", async () => {
    const d = dir();
    // 1st run 07:59-08:30: F1's start is notified normally
    const a = daemon(d, `${DAY}T07:59:00`);
    runUntil(a, `${DAY}T08:30:00+01:00`);
    expect(a.sink.records.some((r) => r.type === "resume")).toBe(false);
    await a.daemon.stop();
    daemons.splice(daemons.indexOf(a.daemon), 1);
    // restart still inside F1 (its start was notified): no resume
    const b = daemon(d, `${DAY}T08:35:00`);
    b.daemon.tick();
    expect(b.sink.calls).toEqual([]);
    await b.daemon.stop();
    daemons.splice(daemons.indexOf(b.daemon), 1);
    // restart at 10:15, inside F3 (09:50-10:50) whose start was missed
    const c = daemon(d, `${DAY}T10:15:00`);
    c.daemon.tick();
    expect(c.sink.calls).toHaveLength(1);
    expect(c.sink.calls[0]!.records).toEqual([
      expect.objectContaining({ type: "resume", itemKey: `${DAY}|fx/F3|1`, due: `${DAY}T09:50:00+01:00`, at: `${DAY}T10:15:00+01:00` }),
    ]);
    expect(c.sink.calls[0]!.toast).toEqual({ title: "Now: F3 · Fixture task 3", message: "Until 10:50 · then 10 min rest" });
    // downtime counts from the last recorded notification (F1's start at 08:00)
    expect(c.logs.find((l) => l.startsWith("skipped"))).toMatch(/^skipped 8 boundaries during downtime \(08:00–10:13/);
    await c.daemon.stop();
    daemons.splice(daemons.indexOf(c.daemon), 1);
    // another restart inside F3: not repeated
    const e = daemon(d, `${DAY}T10:20:00`);
    e.daemon.tick();
    expect(e.sink.calls).toEqual([]);
    // resume is not one of the four boundary types; the day's boundary records are unaffected
    runUntil(e, `${DAY}T23:59:00+01:00`);
    const recs = allRecords(e.daemon.store);
    expect(recs.filter((r) => (r.type as string) === "resume")).toHaveLength(1);
    expect(new Set(recs.map(id)).size).toBe(recs.length);
  });
});

describe("free windows (rests around closed tasks)", () => {
  // Fixture day: F1 08:00-08:40, rest|1 -08:50, F2 -09:40, rest|2 -09:50, F3 -10:50, rest|3 -11:00,
  // F4 -11:40, rest|4 -11:50, F6 -12:40, long rest|5 -13:40, F5 ...
  const K = (x: string) => (x.startsWith("rest") ? `${DAY}|${x}` : `${DAY}|fx/${x}|1`);
  function run(closed: string[], from = "07:59", until = "13:00") {
    const d = dir();
    const t = daemon(d, `${DAY}T${from}:00`);
    for (const k of closed) t.daemon.service.setItemStatus(K(k), k === "F3" ? "skipped" : "done");
    runUntil(t, `${DAY}T${until}:00+01:00`);
    const shown = t.sink.calls.filter((c) => !c.silent);
    const at = (hhmm: string) => shown.filter((c) => c.records[0]!.due.slice(11, 16) === hhmm).map((c) => c.toast);
    const types = (key: string) => allRecords(t.daemon.store).filter((r) => r.itemKey === key).map((r) => r.type).sort();
    return { t, shown, at, types };
  }

  it("task AFTER a rest closed: one 'Free until' toast for the whole stretch", () => {
    const { at, types, t } = run(["F3"]);
    // 09:40 F2 ends: free until F4 starts (11:00), not "Rest 10 min until 09:50"
    expect(at("09:40")).toEqual([{ title: "Free until 11:00", message: "Next: F4 · Fixture task 4" }]);
    expect(at("09:50")).toEqual([]); // rest|2 end: silent
    expect(at("10:50")).toEqual([]); // rest|3 start: silent
    expect(at("11:00")).toEqual([expect.objectContaining({ title: "Start: F4 · Fixture task 4" })]);
    // every rest boundary is still recorded exactly once; the closed task fires nothing
    expect(types(K("rest|2"))).toEqual(["rest_end", "rest_start"]);
    expect(types(K("rest|3"))).toEqual(["rest_end", "rest_start"]);
    expect(types(K("F3"))).toEqual([]);
    // silent ones reach the log sink only (MemorySink here does not accept silent)
    expect(t.sink.calls.some((c) => c.silent)).toBe(false);
  });

  it("task BEFORE a rest closed", () => {
    const { at, types } = run(["F2"]);
    expect(at("08:40")).toEqual([{ title: "Free until 09:50", message: "Next: F3 · Fixture task 3" }]);
    expect(at("08:50")).toEqual([]);
    expect(at("09:40")).toEqual([]);
    expect(at("09:50")).toEqual([expect.objectContaining({ title: "Start: F3 · Fixture task 3" })]);
    expect(types(K("rest|1"))).toEqual(["rest_end", "rest_start"]);
    expect(types(K("rest|2"))).toEqual(["rest_end", "rest_start"]);
  });

  it("two consecutive closed tasks: one window up to the next pending task", () => {
    const { at, shown } = run(["F3", "F4"]);
    expect(at("09:40")).toEqual([{ title: "Free until 11:50", message: "Next: F6 · Fixture task 6" }]);
    for (const h of ["09:50", "10:50", "11:00", "11:40"]) expect(at(h)).toEqual([]);
    expect(at("11:50")).toEqual([expect.objectContaining({ title: "Start: F6 · Fixture task 6" })]);
    expect(shown.filter((c) => c.toast.title.startsWith("Free until"))).toHaveLength(1);
  });

  it("a task closed while in progress: the next rest announces the free time once", () => {
    const d = dir();
    const t = daemon(d, `${DAY}T07:59:00`);
    runUntil(t, `${DAY}T09:00:00+01:00`); // rest|1 already fired as a normal rest
    t.daemon.service.setItemStatus(K("F2"), "done");
    runUntil(t, `${DAY}T10:00:00+01:00`);
    const titles = t.sink.calls.map((c) => `${c.records[0]!.due.slice(11, 16)} ${c.toast.title}`);
    expect(titles).toContain("09:40 Free until 09:50");
    expect(titles).toContain("09:50 Start: F3 · Fixture task 3");
    expect(titles.filter((x) => x.includes("Free until"))).toHaveLength(1);
  });

  it("the JSONL log gets silent records with silent:true", () => {
    const d = dir();
    const t = daemon(d, `${DAY}T07:59:00`, { sinks: [new LogSink(join(d, "notifications.log"))] });
    t.daemon.service.setItemStatus(K("F3"), "skipped");
    runUntil(t, `${DAY}T11:30:00+01:00`);
    const lines = readFileSync(join(d, "notifications.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const silent = lines.filter((l) => l.silent);
    expect(silent.map((l) => `${l.itemKey}#${l.type}`).sort()).toEqual([`${K("rest|2")}#rest_end`, `${K("rest|3")}#rest_start`]);
  });
});

describe("plan changes", () => {
  it("a +1 h shift made by another process moves later notifications within 2 s, no restart", async () => {
    // Fixture day: F3 09:50-10:50 is in progress at 10:15, then rest|3 10:50-11:00, then F4 11:00.
    // Shift semantics (PLAN.md, gap-to-rest): the in-progress task keeps its times, the rest right
    // after it keeps its start and stretches by the shift (10:50-12:00), later items move +1 h.
    const d = dir();
    const t = daemon(d, `${DAY}T10:15:00`);
    const api = apiService(d, t.clock);
    const now = t.clock.now();
    const items = t.daemon.store.getDay(DAY).items;
    const task = items.find((it) => it.kind === "task" && Date.parse(it.start) > now)!;
    const rest = items.find((it) => it.kind === "rest" && Date.parse(it.start) > now && Date.parse(it.start) < Date.parse(task.start))!;
    expect(rest.end).toBe(task.start);
    t.daemon.start();
    await sleep(100);
    api.shift(1, "hours");
    const movedTask = api.store.getItem(task.key)!;
    const movedRest = api.store.getItem(rest.key)!;
    expect(Date.parse(movedTask.start)).toBe(Date.parse(task.start) + 60 * MIN);
    expect(movedRest.start).toBe(rest.start);
    expect(Date.parse(movedRest.end)).toBe(Date.parse(rest.end) + 60 * MIN);

    // the rest still starts on time
    t.clock.set(Date.parse(rest.start) + 30_000);
    await waitFor(() => t.sink.records.some((r) => r.itemKey === rest.key && r.type === "rest_start"), 2000);
    // old times pass: neither the old rest_end nor the old task_start fires
    t.clock.set(Date.parse(task.start) + 30_000);
    await sleep(1500);
    expect(t.sink.records.filter((r) => r.itemKey === task.key || (r.itemKey === rest.key && r.type === "rest_end"))).toEqual([]);
    // new time: rest_end + task_start fire within 2 s real time, as one toast
    t.clock.set(Date.parse(movedTask.start) + 30_000);
    const took = await waitFor(() => t.sink.records.some((r) => r.itemKey === task.key && r.type === "task_start"), 2000);
    expect(took).toBeLessThan(2000);
    const call = t.sink.calls.find((c) => c.records.some((r) => r.itemKey === task.key))!;
    expect(call.records.map((r) => `${r.type}@${r.due}`)).toEqual([`rest_end@${movedRest.end}`, `task_start@${movedTask.start}`]);
    expect(call.toast.title).toMatch(/^Start: F\d+ · /);
    expect(t.logs.some((l) => l.startsWith("plan changed"))).toBe(true);
  });
});

describe("midnight rollover", () => {
  it("regenerates from the new day and fires its boundaries", () => {
    const d = dir();
    const t = daemon(d, `${DAY}T23:58:00`);
    const tomorrow = addDays(DAY, 1);
    expect(t.daemon.store.getPlanFrom()).toBe(DAY);
    t.daemon.tick();
    runUntil(t, `${tomorrow}T00:01:00+01:00`);
    expect(t.daemon.store.getPlanFrom()).toBe(tomorrow);
    expect(t.daemon.service.horizonEnd()).toBe(addDays(tomorrow, 6));
    expect(t.daemon.store.getDay(addDays(tomorrow, 6)).items.length).toBeGreaterThan(0);
    expect(t.logs.some((l) => l.startsWith(`rollover ${DAY} -> ${tomorrow}`))).toBe(true);
    // rollover triggers an immediate sync attempt (not authorized here), recorded in the store
    const first = t.daemon.store.getDay(tomorrow).items[0]!;
    runUntil(t, Date.parse(first.start) + 30_000);
    expect(t.sink.records.some((r) => r.itemKey === first.key && r.type === "task_start")).toBe(true);
  });
});

describe("sinks", () => {
  it("coalesces task_end + rest_start into one toast with two records", () => {
    const d = dir();
    const t = daemon(d, `${DAY}T07:59:00`);
    const items = t.daemon.store.getDay(DAY).items;
    const i = items.findIndex((it, k) => it.kind === "task" && items[k + 1]?.kind === "rest" && items[k + 1]!.start === it.end);
    const [task, rest] = [items[i]!, items[i + 1]!];
    runUntil(t, Date.parse(task.end) + 30_000);
    const call = t.sink.calls.find((c) => c.records.some((r) => r.itemKey === task.key && r.type === "task_end"))!;
    expect(call.records.map((r) => `${r.itemKey}#${r.type}`)).toEqual([`${task.key}#task_end`, `${rest.key}#rest_start`]);
    expect(call.toast.title).toMatch(/^(Long rest|Rest) \d/);
    expect(call.toast.message).toMatch(/^Until \d\d:\d\d · (next: |then done)/);
    expect(t.daemon.store.hasNotification(task.key, "task_end")).toBe(true);
    expect(t.daemon.store.hasNotification(rest.key, "rest_start")).toBe(true);
    // task_start toast text
    const start = t.sink.calls.find((c) => c.records[0]!.type === "task_start")!;
    expect(start.toast.title).toMatch(/^Start: \S+ · /);
    expect(start.toast.message).toMatch(/^Until \d\d:\d\d · then /);
  });

  it("toast failures (callback error or throw) are swallowed; records and the log still happen", async () => {
    const d = dir();
    const failing: NotifierLike = { notify: (_o, cb) => cb?.(new Error("SnoreToast exploded"), "") };
    const throwing: NotifierLike = {
      notify: () => {
        throw new Error("spawn EACCES");
      },
    };
    const log = new LogSink(join(d, "notifications.log"));
    const mem = new MemorySink();
    const t = daemon(d, `${DAY}T07:59:00`, { sinks: [new ToastSink({ notifier: failing }), new ToastSink({ notifier: throwing }), log, mem] });
    expect(() => runUntil(t, `${DAY}T09:00:00+01:00`)).not.toThrow();
    await sleep(20);
    expect(mem.records.length).toBeGreaterThan(0);
    expect(existsSync(join(d, "notifications.log"))).toBe(true);
    expect(t.logs.filter((l) => l.startsWith("toast sink failed")).length).toBeGreaterThanOrEqual(2);
    expect(t.logs.some((l) => l.includes("SnoreToast exploded"))).toBe(true);
    expect(t.logs.some((l) => l.includes("spawn EACCES"))).toBe(true);
  });

  it("records each toast's outcome; an empty SnoreToast response is `unknown`, not a failure", async () => {
    const d = dir();
    const responses: [Error | null, string][] = [[null, "timeout"], [null, ""], [null, "activate"], [new Error("spawn failed"), ""]];
    const outcomes: ToastOutcome[] = [];
    const clicks: string[] = [];
    const nf: NotifierLike = { notify: (_o, cb) => { const [e, r] = responses.shift() ?? [null, "dismissed"]; cb?.(e, r); } };
    const logs: string[] = [];
    const sink = new ToastSink({ notifier: nf, log: (m) => logs.push(m), onResult: (_n, o) => outcomes.push(o), onClick: (n) => clicks.push(n.toast.title) });
    const n = (title: string) => ({ toast: { title, message: "m" }, records: [] });
    await sink.notify(n("a"));
    await sink.notify(n("b"));
    await sink.notify(n("c"));
    await expect(sink.notify(n("d"))).rejects.toThrow(/spawn failed/);
    expect(outcomes.map((o) => o.result)).toEqual(["timeout", "unknown", "activated", "failed"]);
    expect(outcomes.every((o) => o.appID === "Study Planner")).toBe(true);
    expect(clicks).toEqual(["c"]); // a click opens the web UI
    expect(logs).toEqual([]);
    expect(toastResult(null, "dismissed")).toBe("dismissed");
    expect(toastResult(null, "replied")).toBe("shown");
    expect(toastResult(null, undefined)).toBe("unknown");
    void d;
  });

  it("falls back to SnoreToast's default appID only after 3 consecutive definite errors, never re-sending", async () => {
    const seen: (string | undefined)[] = [];
    let fail = 5;
    const picky: NotifierLike = {
      notify: (o, cb) => {
        seen.push(o.appID as string | undefined);
        if (fail-- > 0 && o.appID) cb?.(new Error("toast failed"), "");
        else cb?.(null, "timeout");
      },
    };
    const logs: string[] = [];
    const sink = new ToastSink({ notifier: picky, appID: "Study Planner", log: (m) => logs.push(m) });
    const n = { toast: { title: "t", message: "m" }, records: [] };
    // unknown results do not count
    for (let i = 0; i < 3; i++) await sink.notify(n).catch(() => {});
    expect(seen).toEqual(["Study Planner", "Study Planner", "Study Planner"]); // one call per toast
    expect(sink.currentAppID).toBeUndefined();
    await sink.notify(n);
    expect(seen.at(-1)).toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/3 toasts in a row failed/);
    // a success in between resets the count
    let k = 0;
    const flaky: NotifierLike = { notify: (_o, cb) => cb?.(k++ % 3 === 2 ? null : new Error("x"), "timeout") };
    const s2 = new ToastSink({ notifier: flaky });
    for (let i = 0; i < 9; i++) await s2.notify(n).catch(() => {});
    expect(s2.currentAppID).toBe("Study Planner");
  });

  it("the JSONL log records toast results and skipped boundaries", () => {
    const d = dir();
    const file = join(d, "notifications.log");
    const sinks = sinksFromEnv({ PLANNER_NOTIFY: "toast,log" }, d);
    const toast = sinks.find((x) => x.name === "toast") as ToastSink;
    expect(toast).toBeDefined();
    const log = sinks.find((x) => x.name === "log") as LogSink;
    log.note({ at: "x", skipped: 3, from: "a", to: "b", reason: "downtime" });
    expect(JSON.parse(readFileSync(file, "utf8").trim())).toEqual({ at: "x", skipped: 3, from: "a", to: "b", reason: "downtime" });
  });

  it("first start on a fresh data dir says 'first start', and skipped boundaries go to the JSONL", () => {
    const d = dir();
    const t = daemon(d, `${DAY}T10:15:00`, { sinks: [new LogSink(join(d, "notifications.log"))] });
    t.daemon.tick();
    expect(t.logs.find((l) => l.includes("skipped"))).toMatch(/^first start: skipped 9 boundaries earlier today \(before 10:13\)/);
    const first = JSON.parse(readFileSync(join(d, "notifications.log"), "utf8").split("\n")[0]!);
    expect(first).toMatchObject({ skipped: 9, reason: "first_start", to: `${DAY}T10:13:00+01:00` });
  });

  it("PLANNER_NOTIFY selects sinks", () => {
    const d = dir();
    const mk = (v?: string) => daemon(d, `${DAY}T07:59:00`, { sinks: undefined, env: v === undefined ? {} : { PLANNER_NOTIFY: v } }).daemon.sinks.map((s) => s.name);
    expect(mk()).toEqual(["toast", "log"]);
    expect(mk("log")).toEqual(["log"]);
    expect(mk("toast")).toEqual(["toast"]);
    expect(mk("off")).toEqual([]);
    expect(() => mk("loud")).toThrow(/PLANNER_NOTIFY/);
  });
});

describe("calendar sync retries", () => {
  it("retries when pending, records the outcome like the API, logs missing auth once", async () => {
    const d = dir();
    let calls = 0;
    const t = daemon(d, `${DAY}T09:00:00`, {
      calendarClient: () => {
        calls++;
        return notAuthorized();
      },
      syncIntervalMs: 0,
    });
    t.daemon.tick();
    expect(calls).toBe(0); // nothing pending
    t.daemon.store.updateSyncState({ pending: true });
    t.daemon.tick();
    await t.daemon.sync.idle();
    t.daemon.tick();
    await t.daemon.sync.idle();
    expect(calls).toBe(2);
    const s = t.daemon.store.getSyncState();
    expect(s.pending).toBe(true);
    expect(s.lastError?.code).toBe("CALENDAR_NOT_AUTHORIZED");
    expect(s.lastAttemptAt).toBe("2026-09-28T09:00:00+01:00");
    expect(t.logs.filter((l) => l.startsWith("calendar not authorized")).length).toBe(1);
  });

  it("backs off between retries and records generic failures as CALENDAR_ERROR", async () => {
    const d = dir();
    let calls = 0;
    let real = 0;
    const t = daemon(d, `${DAY}T09:00:00`);
    const r = new SyncRetrier({ store: t.daemon.store, service: t.daemon.service, factory: () => { calls++; throw new Error("ECONNRESET"); }, intervalMs: 5 * MIN, realNow: () => real });
    t.daemon.store.updateSyncState({ pending: true, lastError: { code: "CALENDAR_ERROR", message: "x", at: "2026-09-28T08:00:00+01:00" } });
    await r.maybeRetry();
    expect(calls).toBe(1);
    real += 60_000;
    expect(r.maybeRetry()).toBeUndefined();
    real += 5 * MIN;
    await r.maybeRetry();
    expect(calls).toBe(2);
    expect(t.daemon.store.getSyncState().lastError).toMatchObject({ code: "CALENDAR_ERROR", message: "ECONNRESET" });
  });
});
