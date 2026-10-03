/**
 * Randomized driver: 400+ seeded operations (status by item key and by uid, daily status with a date,
 * undo, minute/hour/day shifts, regenerate from today and from a future date, clock advances across
 * midnight, and server restarts on the same database).
 *
 * After EVERY operation it asserts P7's six invariants (docs/PLAN.md) plus the timeline invariants:
 *  1. every pending task with remaining > 0 is on the plan (checked over a 120-day projection);
 *  2. a task's done minutes never exceed its duration, and no minute is placed twice;
 *  3. a daily task with `occurrences: N` has exactly N sessions held + planned;
 *  4. a prep track never starts while a lower-priority prep track has remaining work;
 *  5. a status change followed by its undo leaves the task pending AND scheduled;
 *  6. only POST /plan/regenerate clears a day off; a replan never does.
 * Plus: no 5xx, no pending item off the timeline, no pending item on a past date, and the same seed
 * replayed on a fresh database gives the identical plan (keys included).
 */
import { afterEach, describe, expect, it } from "vitest";
import { TODAY, checkDay, cleanup, enc, makeApi, ms, type TestApi } from "./helpers.ts";

const open: TestApi[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
  for (const d of dirs.splice(0)) cleanup(d);
});

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const OCCURRENCES = 3; // fixtures: lessons.md occurrences: 3
const DAILY = ["lessons/DAILY", "portfolio/DAILY"];
const PRIORITY: Record<string, number> = { alpha: 1, beta: 2 };
const HORIZON = 120; // the projection used for invariant 1

interface State {
  /**
   * Dates a days shift left without work to do, with the instant from which they must stay empty
   * (today keeps what already started). Only POST /plan/regenerate may fill one (invariant 6).
   */
  daysOff: Map<string, { since: number; op: string }>;
}

async function assertInvariants(t: TestApi, st: State, where: string): Promise<void> {
  const today = (await t.get("/today")).body.date;
  const days = (await t.get(`/plan?from=${today}&days=${HORIZON}`)).body.days;
  const tasks = (await t.get("/tasks")).body.tasks;
  const byUid = new Map<string, any>(tasks.map((x: any) => [x.uid, x]));
  const on = new Map<string, any[]>();
  for (const d of days) for (const i of [...d.items, ...d.checked]) if (i.taskUid) on.set(i.taskUid, [...(on.get(i.taskUid) ?? []), i]);

  for (const d of days.slice(0, 21)) {
    try {
      checkDay(d);
    } catch (e) {
      throw new Error(`${where}, day ${d.date}: ${(e as Error).message}`);
    }
  }
  // History holds only what happened: nothing pending survives before today, of any kind.
  const past = (await t.get(`/plan?from=2026-09-01&days=30`)).body.days.filter((d: any) => d.date < today);
  for (const d of past)
    for (const i of d.items) expect(i.status, `${where}: ${i.key} is pending on a past date`).not.toBe("pending");

  for (const task of tasks) {
    const items = on.get(task.uid) ?? [];
    const mine = items.filter((i: any) => i.status === "pending");
    if (task.repeat === "daily") {
      // 3. sessions held + planned == occurrences.
      if (task.occurrences !== undefined) {
        const dates = new Set<string>(t.api.store.heldSessionDates(task.uid));
        for (const d of days) if ([...d.items, ...d.checked].some((i: any) => i.taskUid === task.uid)) dates.add(d.date);
        for (const d of past) if (d.items.some((i: any) => i.taskUid === task.uid)) dates.add(d.date);
        expect([...dates].sort().length, `${where}: ${task.uid} sessions held + planned (${[...dates].sort().join(",")})`).toBe(task.occurrences);
      }
      continue;
    }
    // 2. done minutes and placed minutes never exceed the duration.
    const { doneMin, partsDone, remainingMin } = task.progress;
    expect(doneMin, `${where}: ${task.uid} doneMin`).toBeLessThanOrEqual(task.durationMin);
    expect(remainingMin, `${where}: ${task.uid} remainingMin`).toBe(task.durationMin - doneMin);
    expect(partsDone, `${where}: ${task.uid} partsDone`).toBeGreaterThanOrEqual(0);
    const placed = mine.reduce((n: number, i: any) => n + (ms(i.end) - ms(i.start)) / 60_000, 0);
    expect(placed, `${where}: ${task.uid} placed ${placed} min with ${remainingMin} left`).toBeLessThanOrEqual(remainingMin);
    const idx = mine.map((i: any) => i.part?.index ?? 1);
    expect(new Set(idx).size, `${where}: ${task.uid} duplicate part numbers ${idx.join(",")}`).toBe(idx.length);
    // 1. pending with work left => on the plan.
    if (task.status === "pending" && remainingMin > 0)
      expect(mine.length, `${where}: ${task.uid} is pending with ${remainingMin} min left and scheduled nowhere`).toBeGreaterThan(0);
    // A pending item is never off the timeline.
    for (const d of days) expect(d.checked.every((i: any) => i.status !== "pending"), `${where}: pending item in ${d.date} checked`).toBe(true);
  }

  // 4. track order: no beta minute while alpha still has work.
  const rem = new Map<string, number>();
  for (const task of tasks) if (PRIORITY[task.track] && task.status === "pending") rem.set(task.uid, task.progress.remainingMin);
  const openTrack = (track: string) => [...rem].some(([u, m]) => m > 0 && byUid.get(u).track === track);
  const now = ms((await t.get("/today")).body.now);
  for (const d of days)
    for (const i of d.items) {
      if (i.kind !== "task" || !PRIORITY[i.track]) continue;
      // An item that has already started is under way: only what is still ahead can "start" a track.
      for (const [track, p] of Object.entries(PRIORITY))
        if (ms(i.start) >= now && p < PRIORITY[i.track]! && openTrack(track))
          throw new Error(
            `${where}: ${d.date} ${i.key} placed while ${track} still has remaining work ` +
              `(${[...rem].filter(([u, m]) => m > 0 && byUid.get(u).track === track).map(([u, m]) => `${u}:${m}`).join(",")})`,
          );
      rem.set(i.taskUid, (rem.get(i.taskUid) ?? 0) - (ms(i.end) - ms(i.start)) / 60_000);
    }

  // 6. a day off is still off.
  for (const d of days) {
    const off = st.daysOff.get(d.date);
    if (off)
      expect(
        d.items.filter((i: any) => i.kind === "task" && i.status === "pending" && ms(i.start) >= off.since).map((i: any) => i.key),
        `${where}: ${d.date} was a day off (${off.op})`,
      ).toEqual([]);
  }
}

async function runSequence(seed: number, ops: number, check: boolean) {
  let t = await makeApi({ now: "2026-09-28T07:30:00+01:00" });
  open.push(t);
  dirs.push(t.dir);
  const rnd = mulberry32(seed);
  const st: State = { daysOff: new Map() };
  const log: string[] = [];
  const oneOff = ["alpha/A1", "alpha/A2", "alpha/A3", "alpha/A4", "alpha/A5", "alpha/A6", "beta/B1", "beta/B2", "beta/B7"];
  let advanced = 0;

  for (let n = 0; n < ops; n++) {
    const today = (await t.get("/today")).body;
    const week = (await t.get(`/plan?from=${today.date}&days=7`)).body.days;
    const pick = <T,>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(rnd() * xs.length)] : undefined);
    const r = rnd();
    let res: { status: number; body: any } | undefined;
    let op = "";

    if (r < 0.24) {
      const pool: any[] = week.flatMap((d: any) => [...d.items.filter((i: any) => i.kind === "task"), ...d.checked]);
      const it = pick(pool);
      if (it) {
        const status = pick(it.status === "pending" ? ["done", "done", "skipped"] : ["pending", "pending", "done"])!;
        op = `item ${it.key} ${status}`;
        res = await t.post(`/items/${enc(it.key)}/status`, { status });
      }
    } else if (r < 0.34) {
      const uid = pick(oneOff)!;
      const status = pick(["done", "skipped", "pending"])!;
      op = `task ${uid} ${status}`;
      res = await t.post(`/tasks/${enc(uid)}/status`, { status });
    } else if (r < 0.42) {
      // Daily task by uid, with a date (required).
      const uid = pick(DAILY)!;
      const date = pick(week.filter((d: any) => [...d.items, ...d.checked].some((i: any) => i.taskUid === uid)).map((d: any) => d.date));
      if (date) {
        const status = pick(["done", "skipped", "pending"])!;
        op = `daily ${uid}@${date} ${status}`;
        res = await t.post(`/tasks/${enc(uid)}/status`, { status, date });
      }
    } else if (r < 0.5) {
      // Invariant 5: a change and its undo leave the task pending AND scheduled.
      const uid = pick(oneOff)!;
      const status = pick(["done", "skipped"])!;
      op = `${status} + undo ${uid}`;
      await t.post(`/tasks/${enc(uid)}/status`, { status });
      res = await t.post(`/tasks/${enc(uid)}/status`, { status: "pending" });
      if (check && res.status === 200) {
        const view = (await t.get(`/tasks/${enc(uid)}`)).body;
        expect(view.status, `${op}: status after undo`).toBe("pending");
        expect(view.progress).toMatchObject({ doneMin: 0, partsDone: 0 });
        expect(view.scheduledOn.length, `${op}: pending and scheduled nowhere (ops: ${log.slice(-5).join(" | ")})`).toBeGreaterThan(0);
      }
    } else if (r < 0.68) {
      const unit = pick(["minutes", "minutes", "hours", "days"])!;
      const amount = unit === "minutes" ? 5 + Math.floor(rnd() * 120) : unit === "hours" ? 1 + Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 2);
      op = `shift ${amount} ${unit}`;
      res = await t.post("/plan/shift", { amount, unit });
      if (res.status === 200 && unit === "days") {
        // Every date the shift actually emptied - up to the day the work landed on, not just `amount`
        // days - must stay empty until POST /plan/regenerate says otherwise.
        const landed = res.body.regenerated[0] ?? today.date;
        const span = Math.max(1, Math.round((ms(`${landed}T12:00:00Z`) - ms(`${today.date}T12:00:00Z`)) / 86_400_000));
        const after = (await t.get(`/plan?from=${today.date}&days=${span}`)).body.days;
        for (const d of after) {
          if (d.date >= landed) continue;
          const since = d.date > today.date ? 0 : ms(today.now);
          if (!d.items.some((i: any) => i.kind === "task" && i.status === "pending" && ms(i.start) >= since)) st.daysOff.set(d.date, { since, op: `op ${n} ${op}` });
        }
      }
    } else if (r < 0.82) {
      const from = rnd() < 0.5 ? today.date : week[1 + Math.floor(rnd() * 3)].date;
      op = `regenerate ${from}`;
      res = await t.post("/plan/regenerate", { from });
      if (res.status === 200) for (const d of [...st.daysOff.keys()]) if (d >= from) st.daysOff.delete(d);
    } else if (r < 0.94) {
      const minutes = 20 + Math.floor(rnd() * 600);
      advanced += minutes;
      op = `advance ${minutes}m`;
      t.clock.advance(minutes * 60_000);
      res = await t.get("/today");
      for (const d of [...st.daysOff.keys()]) if (d < (res.body as any).date) st.daysOff.delete(d);
    } else {
      // Restart the server on the same database.
      op = "restart";
      const dir = t.dir;
      const at = t.clock.now();
      await t.close();
      open.splice(open.indexOf(t), 1);
      t = await makeApi({ dir, now: new Date(at).toISOString() });
      open.push(t);
      res = await t.get("/today");
    }
    if (!op) continue;
    log.push(op);
    if (!check || !res) continue;
    expect(res.status, `op ${n} ${op}: ${JSON.stringify(res.body)}`).toBeLessThan(500);
    if (res.status >= 400) expect([400, 404, 409]).toContain(res.status);
    await assertInvariants(t, st, `after op ${n} (${op}); ops: ${log.slice(-6).join(" | ")}`);
  }
  expect(advanced, "the clock crossed midnight at least once").toBeGreaterThan(1440);
  const final = (await t.get(`/plan?from=${TODAY}&days=21`)).body.days;
  return { final, log, progress: [...t.api.store.getProgress()].sort(), sessions: [...t.api.store.allHeldSessions()].sort() };
}

describe("randomized sequence", () => {
  it("400 ops keep P7's six invariants", { timeout: 900_000 }, async () => {
    const { log } = await runSequence(20260928, 400, true);
    expect(log.length).toBeGreaterThanOrEqual(380);
  });

  it("the same seed on a fresh database gives the identical plan, progress and sessions", { timeout: 300_000 }, async () => {
    const a = await runSequence(7, 90, false);
    const b = await runSequence(7, 90, false);
    expect(b.log).toEqual(a.log);
    expect(b.final).toEqual(a.final);
    expect(b.progress).toEqual(a.progress);
    expect(b.sessions).toEqual(a.sessions);
  });
});
