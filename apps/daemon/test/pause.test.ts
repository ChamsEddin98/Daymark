/**
 * P8 rule 5 / invariant 5: no boundary notification fires for an instant inside a pause, and nothing
 * is recorded for those instants, so a resume never replays them. After the resume the boundaries fire
 * at their NEW times. The daemon reads the pause from the store, so it follows one within a tick.
 *
 * Fixture day (see test/fixtures/resources): F3 09:50-10:50, rest|3 10:50-11:00, F4 11:00-11:40.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PlanService, PlannerStore, compressedClock, loadResources, type Clock } from "@planner/store";
import type { Daemon } from "../src/daemon.ts";
import { DAY, RESOURCES, TZ, cleanup, makeDaemon, runUntil, sleep, tempDir, waitFor, type TestDaemon } from "./helpers.ts";

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
/** The API's view of the same database: it owns pause and resume. */
function apiService(d: string, clock: Clock): PlanService {
  const store = new PlannerStore({ dir: d });
  stores.push(store);
  return new PlanService({ store, clock, timeZone: TZ, horizon: 7, files: loadResources(RESOURCES).files });
}
afterEach(async () => {
  for (const x of daemons.splice(0)) await x.stop();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) cleanup(d);
});

const boundary = (t: TestDaemon, key: string, type: string) => t.daemon.store.listNotifications(10_000).find((r) => r.itemKey === key && r.type === type);
const fired = (t: TestDaemon, key: string, type: string) => t.sink.records.filter((r) => r.itemKey === key && r.type === type);

describe("no boundary fires or is recorded inside a pause (P8 invariant 5)", () => {
  it("the two boundaries at 10:50 are skipped entirely, and the ones after the resume fire at their new times", () => {
    const d = dir();
    const t = daemon(d, `${DAY}T10:49:00`);
    const api = apiService(d, t.clock);
    const day = t.daemon.store.getDay(DAY).items;
    const f3 = day.find((i) => i.taskUid === "fx/F3")!;
    const rest = day.find((i) => i.key === `${DAY}|rest|3`)!;
    const f4 = day.find((i) => i.taskUid === "fx/F4")!;
    expect([f3.end, rest.start, rest.end, f4.start]).toEqual([`${DAY}T10:50:00+01:00`, `${DAY}T10:50:00+01:00`, `${DAY}T11:00:00+01:00`, `${DAY}T11:00:00+01:00`]);

    t.daemon.tick(); // establishes the scan window before the pause
    api.pause();
    expect(t.daemon.store.pausedSince()).toBe(Date.parse(`${DAY}T10:49:00+01:00`));

    // 10:49 -> 10:52, straight over the 10:50 boundaries.
    runUntil(t, `${DAY}T10:52:00+01:00`, 15_000);
    expect(t.logs.some((l) => l.startsWith("plan paused")), "the daemon followed the pause").toBe(true);
    for (const [key, type] of [[f3.key, "task_end"], [rest.key, "rest_start"]] as const) {
      expect(fired(t, key, type), `${key} ${type} fired inside the pause`).toEqual([]);
      expect(boundary(t, key, type), `${key} ${type} recorded inside the pause`).toBeUndefined();
    }

    // Resume: 3 minutes, so rest|3 ends and F4 starts 3 minutes later than planned.
    const r = api.resume();
    expect(r.pausedSec).toBe(180);
    const movedRest = api.store.getItem(rest.key)!;
    const movedF4 = api.store.getItem(f4.key)!;
    expect(movedRest.start, "the rest in progress keeps its start").toBe(rest.start);
    expect(movedRest.end).toBe(`${DAY}T11:03:00+01:00`);
    expect(movedF4.start).toBe(`${DAY}T11:03:00+01:00`);

    // The one boundary the pause would swallow for good - the end of the task that was under way -
    // fires once at the resume instant, with the rest that starts there, as one toast.
    runUntil(t, `${DAY}T11:01:00+01:00`, 15_000);
    const end = boundary(t, f3.key, "task_end");
    expect(end, "the end of the task under way is not lost").toBeDefined();
    const endCall = t.sink.calls.find((c) => c.records.some((x) => x.itemKey === f3.key && x.type === "task_end"))!;
    expect(endCall.records.map((x) => `${x.type}@${x.due}`)).toEqual([`task_end@${f3.end}`, `rest_start@${rest.start}`]);
    expect(Date.parse(endCall.records[0]!.at), "delivered at the resume instant, not at 10:50").toBeGreaterThanOrEqual(Date.parse(`${DAY}T10:52:00+01:00`));
    // Everything else stays quiet: the old 11:00 instant passes with nothing.
    expect(fired(t, f4.key, "task_start")).toEqual([]);
    expect(fired(t, rest.key, "rest_end")).toEqual([]);
    // And it is fired exactly once, however many ticks follow.
    runUntil(t, `${DAY}T11:02:00+01:00`, 15_000);
    expect(t.sink.records.filter((x) => x.itemKey === f3.key && x.type === "task_end")).toHaveLength(1);

    // The NEW instant fires both, as one coalesced toast.
    runUntil(t, `${DAY}T11:04:00+01:00`, 15_000);
    expect(boundary(t, f4.key, "task_start")).toBeDefined();
    const call = t.sink.calls.find((c) => c.records.some((x) => x.itemKey === f4.key && x.type === "task_start"))!;
    expect(call.records.map((x) => `${x.type}@${x.due}`)).toEqual([`rest_end@${movedRest.end}`, `task_start@${movedF4.start}`]);
    expect(t.logs.some((l) => l.startsWith("plan resumed"))).toBe(true);
  });

  it("a task due to start inside the pause is not lost: it moves out and fires at its new time", () => {
    // P8 rule 2, corrected cut point: F4 is due at 11:00. Pause at 10:59, resume at 11:02, so F4 runs
    // at 11:03 - it never runs unattended, and its task_start is announced then, not swallowed.
    const d = dir();
    const t = daemon(d, `${DAY}T10:59:00`);
    const api = apiService(d, t.clock);
    const f4 = t.daemon.store.getDay(DAY).items.find((i) => i.taskUid === "fx/F4")!;
    const rest = t.daemon.store.getDay(DAY).items.find((i) => i.key === `${DAY}|rest|3`)!;
    expect([rest.end, f4.start]).toEqual([`${DAY}T11:00:00+01:00`, `${DAY}T11:00:00+01:00`]);

    t.daemon.tick();
    api.pause();
    runUntil(t, `${DAY}T11:02:00+01:00`, 15_000);
    expect(fired(t, f4.key, "task_start"), "nothing fired at the old 11:00").toEqual([]);
    expect(boundary(t, f4.key, "task_start")).toBeUndefined();
    expect(boundary(t, rest.key, "rest_end")).toBeUndefined();

    expect(api.resume().pausedSec).toBe(180);
    const moved = api.store.getItem(f4.key)!;
    expect(moved.start, "it moved by the whole pause").toBe(`${DAY}T11:03:00+01:00`);
    expect(api.store.getItem(rest.key)!.start, "the rest that was running keeps its start").toBe(rest.start);

    runUntil(t, `${DAY}T11:04:00+01:00`, 15_000);
    const rec = t.sink.records.find((x) => x.itemKey === f4.key && x.type === "task_start")!;
    expect(rec, "it fires at the new time").toBeDefined();
    expect(rec.due).toBe(moved.start);
  });

  it("a pause taken before a boundary and held past it leaves the record table untouched", () => {
    const d = dir();
    const t = daemon(d, `${DAY}T10:49:00`);
    const api = apiService(d, t.clock);
    t.daemon.tick();
    const before = t.daemon.store.listNotifications(10_000).map((r) => `${r.itemKey}#${r.type}`).sort();
    const delivered = t.sink.calls.length; // the startup "Now: …" toast for the item in progress
    api.pause();
    runUntil(t, `${DAY}T12:30:00+01:00`, 60_000); // over several boundaries
    expect(t.daemon.store.listNotifications(10_000).map((r) => `${r.itemKey}#${r.type}`).sort(), "nothing at all was recorded").toEqual(before);
    expect(t.sink.calls.length, "and nothing more was delivered").toBe(delivered);
  });

  it("the daemon picks the pause up within one tick, and does not busy-loop while paused", () => {
    const d = dir();
    const t = daemon(d, `${DAY}T10:49:50`);
    const api = apiService(d, t.clock);
    t.daemon.tick();
    expect(t.daemon.scanner.frozen).toBe(false);
    api.pause();
    t.daemon.tick();
    expect(t.daemon.scanner.frozen).toBe(true);
    api.resume();
    t.daemon.tick();
    expect(t.daemon.scanner.frozen).toBe(false);
  });

  it("a pause older than 24 h stops freezing the daemon, while a 1 h pause still does", () => {
    // A pause nobody resumed must not silence every toast for ever (P8 rule 8): once it is too old to
    // be applied it stops freezing the notifier, exactly as it stops refusing shifts on the API side.
    const at = Date.parse(`${DAY}T10:49:00+01:00`);
    for (const [label, ago, shouldFire] of [["26 h", 26 * 3_600_000, true], ["1 h", 3_600_000, false]] as const) {
      const d = dir();
      const t = daemon(d, `${DAY}T10:49:00`);
      const api = apiService(d, t.clock);
      const f3 = t.daemon.store.getDay(DAY).items.find((i) => i.taskUid === "fx/F3")!;
      t.daemon.tick();
      api.store.setPausedSince(at - ago);

      t.daemon.tick();
      expect(t.daemon.scanner.frozen, `${label}: frozen`).toBe(!shouldFire);
      runUntil(t, `${DAY}T10:51:00+01:00`, 15_000);
      expect(boundary(t, f3.key, "task_end") !== undefined, `${label}: the 10:50 task_end fired`).toBe(shouldFire);

      // The API and the daemon agree, because both ask the store the same question.
      expect(api.store.freshPausedSince(t.clock.now()) !== undefined, `${label}: live`).toBe(!shouldFire);
      expect(api.store.pausedSince(), `${label}: the pause is still recorded either way`).toBe(at - ago);
      expect(api.paused()!.since, `${label}: and still reported`).toBeTruthy();
      if (shouldFire) expect(() => api.shift(10, "minutes"), `${label}: shifts allowed`).not.toThrow();
      else expect(() => api.shift(10, "minutes"), `${label}: shifts refused`).toThrow(/paused/);
    }
  });

  it("a pause that goes stale while frozen announces nothing from the window it silenced", () => {
    const d = dir();
    const t = daemon(d, `${DAY}T10:49:00`);
    const api = apiService(d, t.clock);
    const f3 = t.daemon.store.getDay(DAY).items.find((i) => i.taskUid === "fx/F3")!;
    t.daemon.tick();
    api.pause(); // live: the 10:50 boundaries are frozen
    runUntil(t, `${DAY}T10:52:00+01:00`, 15_000);
    expect(t.daemon.scanner.frozen).toBe(true);
    expect(boundary(t, f3.key, "task_end")).toBeUndefined();

    // Nobody resumes. A day and a bit later the pause can no longer be applied.
    t.clock.set(Date.parse(`${DAY}T10:49:00+01:00`) + 26 * 3_600_000);
    const calls = t.sink.boundaryCalls.length;
    t.daemon.tick();
    expect(t.daemon.scanner.frozen, "it stopped freezing").toBe(false);
    // Boundary calls only: the stale pause replays no boundary. A `missed` notice about the day that
    // went by while nobody resumed is a different thing, and it is allowed to appear.
    expect(t.sink.boundaryCalls.length, "and replayed nothing: the plan was never moved").toBe(calls);
    expect(boundary(t, f3.key, "task_end"), "no stale 'that task is over' from two days ago").toBeUndefined();
    expect(t.logs.some((l) => l.includes("older than 24 h"))).toBe(true);
  });

  it("sleeps a normal tick while paused, even with a boundary milliseconds away", () => {
    const d = dir();
    const start = Date.parse(`${DAY}T07:59:55+01:00`); // 5 s before 08:00
    const t = daemon(d, `${DAY}T07:00:00`, { clock: { kind: "compressed", speed: 2400, now: () => start } });
    expect(t.daemon.sleepMs(), "unpaused: wakes just before the boundary").toBe(4);
    apiService(d, { kind: "fixed", speed: 0, now: () => start }).pause();
    expect(t.daemon.sleepMs(), "paused: nothing to wake up for").toBe(t.daemon.tickMs());
  });
});

describe("compressed clock: a pause window fires nothing, the new times do", () => {
  it("runs the real loop over the 10:50 boundaries while paused, then fires F4 at its new start", async () => {
    const d = dir();
    // The compressed clock starts when the loop starts (building the plan takes real time).
    let c: ReturnType<typeof compressedClock> | undefined;
    const start = Date.parse(`${DAY}T10:49:50+01:00`);
    const clock: Clock = { kind: "compressed", speed: 600, now: () => (c ? c.now() : start) };
    const t = daemon(d, `${DAY}T10:49:50`, { clock });
    const api = apiService(d, clock);
    const day = t.daemon.store.getDay(DAY).items;
    const f3 = day.find((i) => i.taskUid === "fx/F3")!;
    const rest = day.find((i) => i.key === `${DAY}|rest|3`)!;
    const f4 = day.find((i) => i.taskUid === "fx/F4")!;

    // Paused before the loop runs at all, so the daemon never sees the plan unpaused.
    api.pause();
    c = compressedClock(start, 600, TZ);
    t.daemon.start();
    // 1 s real = 10 simulated minutes: wait until simulated 10:51, well past the 10:50 boundaries.
    await waitFor(() => clock.now() >= Date.parse(`${DAY}T10:51:00+01:00`), 10_000);
    for (const [key, type] of [[f3.key, "task_end"], [rest.key, "rest_start"]] as const) {
      expect(t.daemon.store.listNotifications(10_000).some((r) => r.itemKey === key && r.type === type), `${key} ${type}`).toBe(false);
    }

    const r = api.resume();
    expect(r.pausedSec).toBeGreaterThan(60);
    const movedF4 = api.store.getItem(f4.key)!;
    expect(Date.parse(movedF4.start), "F4 moved by the pause").toBeGreaterThan(Date.parse(f4.start));

    await waitFor(() => t.sink.records.some((x) => x.itemKey === f4.key && x.type === "task_start"), 10_000);
    const rec = t.sink.records.find((x) => x.itemKey === f4.key && x.type === "task_start")!;
    expect(rec.due, "it fired at the NEW start, not the old one").toBe(movedF4.start);
    // The end of the task that was under way is the one boundary the resume replays, exactly once.
    const ends = t.daemon.store.listNotifications(10_000).filter((x) => x.itemKey === f3.key && x.type === "task_end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.title).toMatch(/^End: /);
    await sleep(20);
  }, 30_000);
});
