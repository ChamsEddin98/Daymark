/**
 * Missed work, and the two things the owner can ask for when it happens.
 *
 * `onMissed: "reflow"` (the default) takes the work back and lays the rest of the day out again from
 * now, so a late start slides the day. `onMissed: "notify"` touches nothing and only says so, leaving
 * the decision — do it, skip it, or let it roll over tonight — to the owner.
 *
 * Both are tested here against the daemon's own fixture day, because the property that matters is
 * the *reaction*: what the plan looks like, and what the owner is told, a few hours into a day they
 * have not touched.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DAY, MIN, TZ, cleanup, makeDaemon, runUntil, tempDir, type TestDaemon } from "./helpers.ts";

const dirs: string[] = [];
const live: TestDaemon[] = [];
afterEach(async () => {
  for (const t of live.splice(0)) await t.daemon.stop();
  for (const d of dirs.splice(0)) cleanup(d);
});

function start(onMissed: "reflow" | "notify", at = `${DAY}T07:59:00`) {
  const d = tempDir();
  dirs.push(d);
  const t = makeDaemon(d, at, { onMissed });
  live.push(t);
  return t;
}

const tasksToday = (t: TestDaemon) => t.daemon.store.getDay(DAY).items.filter((i) => i.kind === "task");
const pendingToday = (t: TestDaemon) => tasksToday(t).filter((i) => i.status === "pending");
const missedNotices = (t: TestDaemon) => t.daemon.store.listNotifications(1000).filter((r) => r.type === "missed");
const hhmm = (iso: string) => iso.slice(11, 16);
/** Minutes of task time still standing on today's timeline. */
const minsToday = (t: TestDaemon) => tasksToday(t).reduce((n, i) => n + (Date.parse(i.end) - Date.parse(i.start)) / MIN, 0);

describe("reflow (the default)", () => {
  it("a task whose slot went by is taken off the past and re-placed from now", () => {
    const t = start("reflow");
    const first = tasksToday(t)[0]!;
    expect(hhmm(first.start)).toBe("08:00");

    // 10:30: the first two slots have gone by and nothing was touched.
    runUntil(t, `${DAY}T10:30:00+01:00`);

    // Nothing is left stranded in the past...
    const stranded = pendingToday(t).filter((i) => Date.parse(i.end) <= Date.parse(`${DAY}T10:30:00+01:00`));
    expect(stranded, `${stranded.map((i) => i.key).join(", ")} left behind in the past`).toEqual([]);
    // ...and the work is on the timeline again, still ahead of now: the task the owner never got to
    // is either running right now or yet to come, never behind them. (After repeated reflows the
    // first task ends up in progress, which is the whole point - the day caught up to them.)
    const alive = pendingToday(t).filter((i) => Date.parse(i.end) > Date.parse(`${DAY}T10:30:00+01:00`));
    expect(alive.length).toBeGreaterThan(0);
    expect(alive.some((i) => i.taskUid === first.taskUid), "the first task was dropped rather than moved").toBe(true);
    // And the day is in queue order from there, not reshuffled.
    expect(alive[0]!.taskUid).toBe(first.taskUid);
  });

  it("the vacated morning reads as time off, not as an unlabelled hole", () => {
    const t = start("reflow");
    runUntil(t, `${DAY}T11:00:00+01:00`);
    const items = t.daemon.store.getDay(DAY).items;
    // Contiguous: every item starts when the one before it ended.
    for (let k = 1; k < items.length; k++)
      expect(Date.parse(items[k]!.start), `hole before ${items[k]!.key}`).toBe(Date.parse(items[k - 1]!.end));
    // And whatever covers the time nobody worked is a rest, named so it cannot read as a 10-minute one.
    const long = items.filter((i) => i.kind === "rest" && Date.parse(i.end) - Date.parse(i.start) > 60 * MIN);
    for (const r of long) expect(r.title).toMatch(/extended/i);
  });

  it("the day's budget is not charged for work nobody did", () => {
    const a = start("reflow");
    const planned = minsToday(a);
    runUntil(a, `${DAY}T11:30:00+01:00`);
    // Less of the day is left, so less fits before the day ends - but the minutes still on the
    // timeline are all minutes that can actually be worked, never ones already gone by.
    for (const i of pendingToday(a)) expect(Date.parse(i.end)).toBeGreaterThan(Date.parse(`${DAY}T11:30:00+01:00`));
    expect(minsToday(a)).toBeLessThanOrEqual(planned);
  });

  it("says what moved, once per task", () => {
    const t = start("reflow");
    runUntil(t, `${DAY}T10:30:00+01:00`);
    const notices = missedNotices(t);
    expect(notices.length).toBeGreaterThan(0);
    // One row per item, never two for the same one.
    expect(new Set(notices.map((n) => n.itemKey)).size).toBe(notices.length);
    const toast = t.sink.calls.map((c) => c.toast).filter((x) => x.title.startsWith("Missed:"));
    expect(toast.length).toBeGreaterThan(0);
    expect(toast[0]!.message).toMatch(/re-timed/i);
    expect(t.logs.some((l) => l.includes("reflowed today"))).toBe(true);
  });

  it("work that no longer fits today is on a later day, never lost", () => {
    const t = start("reflow");
    const owed = () =>
      t.daemon.service.tasks
        .filter((x) => !x.repeat)
        .reduce((n, x) => n + Math.max(0, x.durationMin - t.daemon.store.getTaskProgress(x.uid).doneMin), 0);
    const before = owed();
    runUntil(t, `${DAY}T22:00:00+01:00`); // a whole day gone by, nothing done
    expect(owed(), "minutes were lost rather than deferred").toBe(before);
    const later = t.daemon.store.getItemsBetween(DAY, "9999-12-31").filter((i) => i.kind === "task" && i.date > DAY);
    expect(later.length).toBeGreaterThan(0);
  });
});

describe("notify (reflow turned off)", () => {
  it("changes nothing at all, and says the task is still pending", () => {
    const t = start("notify");
    const before = t.daemon.store.getDay(DAY).items.map((i) => `${i.key}@${i.start}`);
    runUntil(t, `${DAY}T10:30:00+01:00`);

    // The plan is byte-for-byte what it was: nothing moved behind the owner's back.
    expect(t.daemon.store.getDay(DAY).items.map((i) => `${i.key}@${i.start}`)).toEqual(before);
    // The missed task is still sitting where it was planned.
    const stranded = pendingToday(t).filter((i) => Date.parse(i.end) <= Date.parse(`${DAY}T10:30:00+01:00`));
    expect(stranded.length).toBeGreaterThan(0);

    const toast = t.sink.calls.map((c) => c.toast).filter((x) => x.title.startsWith("Missed:"));
    expect(toast.length).toBeGreaterThan(0);
    // The owner is told, and told what the choices are.
    expect(toast[0]!.message).toMatch(/still pending/i);
    expect(toast[0]!.message).toMatch(/skip/i);
    expect(toast[0]!.message).toMatch(/roll over/i);
    expect(t.logs.some((l) => l.includes("onMissed=notify"))).toBe(true);
  });

  it("still carries the work to the next day at midnight", () => {
    const t = start("notify");
    const owed = () =>
      t.daemon.service.tasks
        .filter((x) => !x.repeat)
        .reduce((n, x) => n + Math.max(0, x.durationMin - t.daemon.store.getTaskProgress(x.uid).doneMin), 0);
    const before = owed();
    runUntil(t, `${DAY}T10:30:00+01:00`);
    expect(owed()).toBe(before); // nothing done, nothing lost
    // Over midnight: the rollover takes the untouched items and the work reappears.
    t.clock.set(Date.parse(`${DAY}T23:59:00+01:00`) + 2 * MIN);
    t.daemon.tick();
    expect(owed(), "the rollover lost work").toBe(before);
    expect(t.daemon.store.getDay(DAY).items.filter((i) => i.status === "pending"), "a pending item survived on a past date").toEqual([]);
  });
});

describe("either way", () => {
  it("a task that was done is never called missed", () => {
    const t = start("reflow");
    const first = tasksToday(t)[0]!;
    t.daemon.service.setItemStatus(first.key, "done");
    runUntil(t, `${DAY}T10:30:00+01:00`);
    expect(missedNotices(t).some((n) => n.itemKey === first.key), "a finished task was reported missed").toBe(false);
  });

  it("a task that was skipped is never called missed", () => {
    const t = start("reflow");
    const first = tasksToday(t)[0]!;
    t.daemon.service.setItemStatus(first.key, "skipped");
    runUntil(t, `${DAY}T10:30:00+01:00`);
    expect(missedNotices(t).some((n) => n.itemKey === first.key)).toBe(false);
  });

  it("nothing is missed while the plan is paused", () => {
    const t = start("reflow", `${DAY}T08:10:00`);
    // Paused inside the first task, then two hours go by frozen.
    t.daemon.service.pause();
    const before = t.daemon.store.getDay(DAY).items.map((i) => `${i.key}@${i.start}`);
    runUntil(t, `${DAY}T10:10:00+01:00`);
    // A slot going by during a pause is exactly what a pause means, so nothing is missed and the
    // frozen plan is untouched.
    expect(missedNotices(t)).toEqual([]);
    expect(t.daemon.store.getDay(DAY).items.map((i) => `${i.key}@${i.start}`)).toEqual(before);
  });

  it("the policy is read live, so changing it takes effect without a restart", () => {
    const t = start("notify");
    runUntil(t, `${DAY}T09:00:00+01:00`);
    const stranded = pendingToday(t).filter((i) => Date.parse(i.end) <= Date.parse(`${DAY}T09:00:00+01:00`));
    expect(stranded.length).toBeGreaterThan(0); // notify: left where it was

    t.daemon.service.setActiveHours({ onMissed: "reflow" });
    t.daemon.tick();
    expect(pendingToday(t).filter((i) => Date.parse(i.end) <= Date.parse(`${DAY}T09:00:00+01:00`))).toEqual([]);
  });
});
