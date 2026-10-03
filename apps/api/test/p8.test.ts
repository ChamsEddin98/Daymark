/**
 * P8 · Pause and Resume (docs/PLAN.md). The five invariants, the exactness rule, the freeze, the
 * limits and the surface (`paused` on /health and /today, SSE, the calendar sync).
 *
 * Fixture day 1: A1 08:00-08:50, rest, A2 09:00-09:50, rest, A4 10:00-10:50, rest, A3 11:00-12:30,
 * long rest 12:30-13:30, A5 13:30-14:20, rest, lessons 14:30-16:30, rest, portfolio 16:40-17:40.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PlanItem } from "@planner/core";
import type { BusEvent } from "../src/sse.ts";
import { startFakeGoogle } from "../../../packages/calendar/test/fake-google.ts";
import { fakeClient } from "../../../packages/calendar/test/helpers.ts";
import { NOW, TODAY, TOMORROW, TZ, checkDay, cleanup, enc, expectError, makeApi, ms, type TestApi } from "./helpers.ts";

const apis: TestApi[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of apis.splice(0)) await a.close().catch(() => {});
  for (const d of dirs.splice(0)) cleanup(d);
});

async function api(o: Parameters<typeof makeApi>[0] = {}): Promise<TestApi> {
  const t = await makeApi(o);
  apis.push(t);
  if (!o.dir) dirs.push(t.dir);
  return t;
}

const line = (i: PlanItem) => `${i.key} ${i.start} ${i.end}`;
const dur = (i: PlanItem) => ms(i.end) - ms(i.start);
const today = async (t: TestApi) =>
  (await t.get(`/today`)).body as {
    date: string;
    now: string;
    day: { items: PlanItem[]; checked: PlanItem[] };
    current: PlanItem | null;
    next: PlanItem | null;
    currentTask: PlanItem | null;
    nextTask: PlanItem | null;
    paused: { since: string; elapsedSec: number } | null;
  };
const items = async (t: TestApi) => (await today(t)).day.items;
const plan = async (t: TestApi, days = 4) => (await t.get(`/plan?days=${days}`)).body.days as { date: string; items: PlanItem[]; checked: PlanItem[] }[];

/**
 * Invariants 1 and 2, checked against the timeline as it stood before the pause. The cut is the
 * **pause** instant: every item starting at or after it moved by exactly `d` ms and nothing else did;
 * durations, order and the gaps between the moved items are byte-identical. The one allowance is the
 * gap-to-rest rule: the rest right after the item under way stretches over the pause instead of
 * moving, which is how the widened gap becomes rest time (rule 2).
 */
function assertExactMove(before: PlanItem[], after: PlanItem[], d: number, pausedAt = ms(NOW)): void {
  expect(after.map((i) => i.key), "order and identity are untouched").toEqual(before.map((i) => i.key));
  const cut = pausedAt;
  let head = true;
  for (const [i, it] of before.entries()) {
    const a = after[i]!;
    if (ms(it.start) < cut) {
      expect(a.start, `${it.key} start frozen`).toBe(it.start);
      if (a.end !== it.end) expect(a.kind, `${it.key}: only a rest absorbs the pause`).toBe("rest");
      continue;
    }
    expect(ms(a.end) - ms(it.end), `${it.key} end + ${d} ms`).toBe(d);
    if (head && it.kind === "rest") {
      expect(a.start, `${it.key} absorbs the pause`).toBe(it.start);
      expect(dur(a) - dur(it), `${it.key} grew by exactly the pause`).toBe(d);
    } else {
      expect(ms(a.start) - ms(it.start), `${it.key} start + ${d} ms`).toBe(d);
      expect(dur(a), `${it.key} duration unchanged`).toBe(dur(it));
      expect({ ...a, start: it.start, end: it.end }, `${it.key}: only its times changed`).toEqual(it);
    }
    head = false;
  }
  // No holes before or after, so every inter-item gap is byte-identical (zero).
  for (const list of [before, after]) for (let k = 1; k < list.length; k++) expect(ms(list[k]!.start), `${list[k]!.key} contiguous`).toBe(ms(list[k - 1]!.end));
}

describe("P8 · the surface", () => {
  it("GET /health and GET /today carry paused: null while the plan runs", async () => {
    const t = await api();
    expect((await t.get("/health")).body.paused).toBeNull();
    expect((await today(t)).paused).toBeNull();
  });

  it("POST /plan/pause returns { paused: { since } } and both reads show { since, elapsedSec }", async () => {
    const t = await api();
    t.clock.advance(317);
    const p = await t.post("/plan/pause");
    expect(p.status).toBe(200);
    expect(p.body).toEqual({ paused: { since: "2026-09-28T10:15:00.317+01:00" } });
    t.clock.advance(45_000);
    for (const url of ["/health", "/today"]) {
      const body = (await t.get(url)).body;
      expect(body.paused, url).toEqual({ since: "2026-09-28T10:15:00.317+01:00", elapsedSec: 45 });
    }
  });

  it("POST /plan/resume returns { pausedSec, moved, endOfDay, day } with a fractional pausedSec", async () => {
    const t = await api();
    await t.post("/plan/pause");
    t.clock.advance(45_317);
    const r = await t.post("/plan/resume");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["day", "endOfDay", "moved", "pausedSec"]);
    expect(r.body.pausedSec).toBe(45.317);
    expect(r.body.moved).toBeGreaterThan(0);
    expect(r.body.day.date).toBe(TODAY);
    expect(r.body.endOfDay).toBe("2026-09-28T17:40:45.317+01:00");
    expect((await today(t)).paused).toBeNull();
  });

  it("freezes current/next/currentTask/nextTask at the pause instant, while now keeps running", async () => {
    const t = await api(); // 10:15, alpha/A4 10:00-10:50 under way, A3 due 11:00
    const at0 = await today(t);
    expect(at0.currentTask!.taskUid).toBe("alpha/A4");
    await t.post("/plan/pause");
    t.clock.advance(35 * 60_000); // 10:50 - the owner is away; A4 has not been worked on

    const paused = await today(t);
    expect(paused.currentTask!.taskUid, "still the task that was under way when they paused").toBe("alpha/A4");
    expect(paused.current!.key).toBe(at0.current!.key);
    expect(paused.next!.key).toBe(at0.next!.key);
    expect(paused.nextTask!.taskUid).toBe(at0.nextTask!.taskUid);
    expect(paused.now, "but `now` is live").toBe("2026-09-28T10:50:00+01:00");
    expect(paused.paused!.elapsedSec, "and so is the elapsed time").toBe(2_100);

    // After the resume it is live again, and A4 is still the task in progress because it kept its times.
    await t.post("/plan/resume");
    const after = await today(t);
    expect(after.currentTask, "10:50 is now inside the stretched rest after A4").toBeNull();
    expect(after.next!.taskUid).toBe("alpha/A3");
  });

  it("a stale pause (> 24 h) no longer freezes the reads", async () => {
    const t = await api();
    await t.post("/plan/pause");
    t.clock.advance(25 * 3_600_000);
    const v = await today(t);
    expect(v.paused!.since, "still reported").toBe(NOW);
    expect(v.date, "but the reads have moved on with the clock").toBe("2026-09-29");
  });

  it("a pause moves nothing at all", async () => {
    const t = await api();
    const before = (await items(t)).map(line);
    await t.post("/plan/pause");
    t.clock.advance(10 * 60_000);
    expect((await items(t)).map(line), "the plan is frozen, not moved").toEqual(before);
    expect((await plan(t)).flatMap((d) => d.items.map(line)).length).toBeGreaterThan(before.length);
  });
});

describe("P8 invariants 1 and 2 · exact, and durations/order/gaps preserved", () => {
  // 45 s, an odd fraction of a second, just under a second, 3 ms, and 2 h.
  for (const d of [45_000, 45_317, 999, 3, 2 * 60 * 60_000]) {
    it(`a ${d} ms pause moves every item starting at or after the pause instant by exactly ${d} ms`, async () => {
      const t = await api();
      const before = await items(t);
      await t.post("/plan/pause");
      t.clock.advance(d);
      const r = await t.post("/plan/resume");
      expect(r.body.pausedSec).toBe(d / 1000);
      assertExactMove(before, await items(t), d);
      checkDay((await today(t)).day);
    });
  }

  it("never rounds to a minute: 3 ms and 999 ms both show in the stored times", async () => {
    for (const [d, iso] of [[3, "2026-09-28T11:00:00.003+01:00"], [999, "2026-09-28T11:00:00.999+01:00"]] as const) {
      const t = await api();
      await t.post("/plan/pause");
      t.clock.advance(d);
      await t.post("/plan/resume");
      const a3 = (await items(t)).find((i) => i.key === `${TODAY}|alpha/A3|1`)!;
      expect(a3.start, `${d} ms`).toBe(iso);
    }
  });

  it("rule 2: a task due to start during the pause moves by the WHOLE pause, it never runs unattended", async () => {
    // A4 is due at 10:00. Pause at 09:59, resume at 10:04 (5 min): A4 must run at 10:05. If the cut
    // were the resume instant it would still sit at 10:00 and the owner would silently lose 5 of its
    // minutes to a task they were not there for.
    const t = await api({ now: "2026-09-28T09:59:00+01:00" });
    const before = await items(t);
    const a4 = before.find((i) => i.taskUid === "alpha/A4")!;
    expect(a4.start).toBe("2026-09-28T10:00:00+01:00");
    await t.post("/plan/pause");
    t.clock.advance(5 * 60_000);
    expect((await t.post("/plan/resume")).body.pausedSec).toBe(300);
    const after = await items(t);
    const moved = after.find((i) => i.key === a4.key)!;
    expect(moved.start).toBe("2026-09-28T10:05:00+01:00");
    expect(moved.end).toBe("2026-09-28T10:55:00+01:00");
    assertExactMove(before, after, 5 * 60_000, ms("2026-09-28T09:59:00+01:00"));
    checkDay((await today(t)).day);
  });

  it("only the item in progress at the pause instant keeps its times", async () => {
    const t = await api(); // 10:15, A4 10:00-10:50 under way
    const before = await items(t);
    const inProgress = before.find((i) => ms(i.start) <= ms(NOW) && ms(NOW) < ms(i.end))!;
    expect(inProgress.taskUid).toBe("alpha/A4");
    await t.post("/plan/pause");
    t.clock.advance(20 * 60_000);
    await t.post("/plan/resume");
    const after = await items(t);
    expect(line(after.find((i) => i.key === inProgress.key)!), "it was under way, so it keeps its times").toBe(line(inProgress));
    // Every later item, including the ones that were due while the owner was away, moved 20 minutes.
    for (const it of before.filter((i) => ms(i.start) >= ms(NOW))) {
      const a = after.find((x) => x.key === it.key)!;
      expect(ms(a.end) - ms(it.end), `${it.key}`).toBe(20 * 60_000);
    }
    checkDay((await today(t)).day);
  });

  it("two pauses in a row compose exactly", async () => {
    const t = await api();
    const before = await items(t);
    await t.post("/plan/pause");
    t.clock.advance(45_317);
    await t.post("/plan/resume");
    await t.post("/plan/pause");
    t.clock.advance(1_683);
    const r = await t.post("/plan/resume");
    expect(r.body.pausedSec).toBe(1.683);
    // The second resume instant is 47 s after the first pause, and both resume instants fall inside
    // the same item, so the total is the two deltas.
    assertExactMove(before, await items(t), 47_000);
  });
});

describe("P8 invariant 3 · every day rule still holds after a resume", () => {
  it("a pause spanning a short rest: the rest stretches, keeps its kind, nothing else changes", async () => {
    const t = await api({ now: "2026-09-28T10:55:00+01:00" }); // inside rest|3 (10:50-11:00)
    const before = await items(t);
    await t.post("/plan/pause");
    t.clock.advance(45_000);
    await t.post("/plan/resume");
    const after = await items(t);
    const rest = after.find((i) => i.key === `${TODAY}|rest|3`)!;
    expect(rest.restKind).toBe("short");
    expect(rest.start).toBe("2026-09-28T10:50:00+01:00");
    expect(dur(rest)).toBe(10 * 60_000 + 45_000);
    expect(after.find((i) => i.key === `${TODAY}|alpha/A3|1`)!.start).toBe("2026-09-28T11:00:45+01:00");
    for (const [i, it] of before.entries()) if (it.kind === "task" && ms(it.start) < ms("2026-09-28T10:55:00+01:00")) expect(line(after[i]!)).toBe(line(it));
    checkDay((await today(t)).day);
  });

  it("a pause spanning the long rest: it stays long and still sits at exactly 240 task minutes", async () => {
    const t = await api({ now: "2026-09-28T13:00:00+01:00" }); // inside the long rest (12:30-13:30)
    await t.post("/plan/pause");
    t.clock.advance(137_000);
    await t.post("/plan/resume");
    const day = (await today(t)).day;
    const long = day.items.find((i) => i.restKind === "long")!;
    expect(long.start).toBe("2026-09-28T12:30:00+01:00");
    expect(dur(long)).toBe(60 * 60_000 + 137_000);
    expect(day.items.find((i) => i.key === `${TODAY}|alpha/A5|1`)!.start).toBe("2026-09-28T13:32:17+01:00");
    checkDay(day); // asserts a long rest only ever sits on a 240-task-minute mark
  });

  it("a pause spanning midnight: a daily item pushed past it is dropped, the day stays legal", async () => {
    // Pause at 09:00, resume at 16:30: portfolio 16:40 -> 00:10 no longer fits today.
    const t = await api({ now: "2026-09-28T09:00:00+01:00" });
    const day2Before = (await plan(t))[1]!.items.map(line);
    await t.post("/plan/pause");
    t.clock.advance(7.5 * 60 * 60_000);
    const r = await t.post("/plan/resume");
    expect(r.body.pausedSec).toBe(27_000);
    const after = await items(t);
    expect(after.some((i) => i.taskUid === "portfolio/DAILY"), "it left today").toBe(false);
    // Everything that had not begun at 09:00 moved 7.5 h; what then fell past midnight left the day.
    expect(after.find((i) => i.key === `${TODAY}|alpha/A2|1`)!.start).toBe("2026-09-28T16:30:00+01:00");
    expect(after.find((i) => i.key === `${TODAY}|lessons/DAILY|1`)!.start).toBe("2026-09-28T22:00:00+01:00");
    expect(after.at(-1)!.taskUid, "and the day ends on a task, never a trailing rest").toBe("lessons/DAILY");
    const midnight = ms(`${TOMORROW}T00:00:00+01:00`);
    for (const i of after) expect(ms(i.start), `${i.key} before midnight`).toBeLessThan(midnight);
    const days = await plan(t);
    expect(days[1]!.items.map(line), "tomorrow has its own daily instance and is untouched").toEqual(day2Before);
    for (const d of days) checkDay(d);
  });

  it("a pause that pushes a one-off task past midnight carries it to the next day", async () => {
    // Pause at 02:00, resume at 13:00 (11 h): A5 13:30 -> 00:30 no longer fits today.
    const t = await api({ now: "2026-09-28T02:00:00+01:00" });
    await t.post("/plan/pause");
    t.clock.advance(11 * 60 * 60_000);
    const r = await t.post("/plan/resume");
    expect(r.body.pausedSec).toBe(39_600);
    const days = await plan(t);
    expect(days.find((d) => d.date === TOMORROW)!.items.some((i) => i.taskUid === "alpha/A5"), "A5 was carried").toBe(true);
    for (const d of days) checkDay(d);
  });

  it("a pause on an existing day off resumes cleanly and leaves the day off empty", async () => {
    const t = await api();
    await t.post("/plan/shift", { amount: 2, unit: "days" }); // leaves TOMORROW off
    t.clock.set("2026-09-29T09:00:00+01:00"); // that day off is now today
    expect((await items(t)).filter((i) => i.kind === "task"), "today is the day off").toEqual([]);
    await t.post("/plan/pause");
    t.clock.advance(45_000);
    const r = await t.post("/plan/resume");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ pausedSec: 45, moved: 0, endOfDay: null });
    const days = await plan(t);
    expect(days[0]!.date).toBe(TOMORROW);
    expect(days[0]!.items.filter((i) => i.kind === "task"), "a resume never refills a day off").toEqual([]);
    expect((await t.get("/health")).body.paused).toBeNull();
    for (const d of days) checkDay(d);
  });
});

describe("P8 · a pause that crosses local midnight", () => {
  it("cuts at midnight, so the whole new day moves by the pause and the cut stays inside today", async () => {
    const t = await api({ now: "2026-09-28T23:30:00+01:00" });
    await t.post("/plan/pause");
    t.clock.set("2026-09-29T01:30:00+01:00"); // 2 h later, and a day later
    // The rollover has run by the time we read the plan, so this is the new day as generated.
    const before = await items(t);
    expect((await today(t)).date).toBe(TOMORROW);
    expect(before[0]!.start, "the new day starts at 08:00 as usual").toBe(`${TOMORROW}T08:00:00+01:00`);

    const r = await t.post("/plan/resume");
    expect(r.body.pausedSec).toBe(7_200);
    const after = await items(t);
    // Nothing of the new day had begun when the owner paused, so all of it moves by the whole pause.
    expect(after[0]!.start).toBe(`${TOMORROW}T10:00:00+01:00`);
    for (const [i, it] of before.entries()) {
      expect(ms(after[i]!.start) - ms(it.start), `${it.key} start`).toBe(2 * 60 * 60_000);
      expect(dur(after[i]!), `${it.key} duration`).toBe(dur(it));
    }
    expect((await t.get("/health")).body.paused).toBeNull();
    for (const d of await plan(t)) checkDay(d);
  });
});

describe("P8 invariant 4 · the pause survives a restart", () => {
  it("a new process sees the pause and the resume uses the original instant", async () => {
    const dir = (await makeApi()).dir; // a directory we own; the api below opens it
    dirs.push(dir);
    const a = await api({ dir });
    const before = await items(a);
    await a.post("/plan/pause");
    expect((await a.get("/health")).body.paused.since).toBe(NOW);
    await a.close();
    apis.splice(apis.indexOf(a), 1);

    const b = await api({ dir, now: "2026-09-28T10:15:45.317+01:00" });
    expect((await b.get("/health")).body.paused).toEqual({ since: NOW, elapsedSec: 45.317 });
    const r = await b.post("/plan/resume");
    expect(r.body.pausedSec, "measured from the original instant, not from the restart").toBe(45.317);
    assertExactMove(before, await items(b), 45_317);
  });
});

describe("P8 rule 4 · while paused the plan is frozen", () => {
  const frozen: [string, unknown][] = [
    ["/plan/shift", { amount: 30, unit: "minutes" }],
    ["/plan/shift/preview", { amount: 30, unit: "minutes" }],
    ["/plan/regenerate", { from: TOMORROW }],
  ];

  it("shift, preview and regenerate all answer 409 PAUSED with a hint naming POST /plan/resume", async () => {
    const t = await api();
    await t.post("/plan/pause");
    t.clock.advance(2_500);
    for (const [url, body] of frozen) {
      const e = expectError(await t.post(url, body), 409, "PAUSED");
      expect(e.hint, url).toContain("POST /plan/resume");
      expect(e.details, url).toEqual({ paused: { since: NOW, elapsedSec: 2.5 } });
    }
    // And they all work again straight after the resume.
    await t.post("/plan/resume");
    for (const [url, body] of frozen) expect((await t.post(url, body)).status, url).toBe(200);
  });

  it("the request is still validated first: a bad shift is 400, not 409", async () => {
    const t = await api();
    await t.post("/plan/pause");
    expectError(await t.post("/plan/shift", { amount: 1.5, unit: "minutes" }), 400, "INVALID_INPUT");
    expectError(await t.post("/plan/shift", { amount: 30, unit: "weeks" }), 400, "INVALID_INPUT");
    expectError(await t.post("/plan/regenerate", { from: "2026-09-27" }), 400, "INVALID_INPUT");
  });

  it("a status change, and its undo, still work and still re-plan later days (P7 intact)", async () => {
    const t = await api();
    await t.post("/plan/pause");
    const a1 = `${TODAY}|alpha/A1|1`;
    const done = await t.post(`/items/${enc(a1)}/status`, { status: "done" });
    expect(done.status).toBe(200);
    expect(done.body.item.status).toBe("done");
    expect(done.body.regenerated.length, "later days are re-planned").toBeGreaterThan(0);
    expect((await t.get("/tasks/alpha%2FA1")).body.progress).toMatchObject({ doneMin: 50, partsDone: 1, remainingMin: 0 });
    expect((await t.get("/health")).body.paused.since, "the pause is untouched").toBe(NOW);

    const undone = await t.post(`/items/${enc(a1)}/status`, { status: "pending" });
    expect(undone.status).toBe(200);
    const task = (await t.get("/tasks/alpha%2FA1")).body;
    expect(task.status).toBe("pending");
    expect(task.progress).toMatchObject({ doneMin: 0, partsDone: 0, remainingMin: 50 });
    expect(task.scheduledOn.length, "pending means scheduled").toBeGreaterThan(0);
    expect((await t.get("/health")).body.paused.since).toBe(NOW);
    for (const d of await plan(t)) checkDay(d);

    // And the resume afterwards is still exact.
    const before = await items(t);
    t.clock.advance(4_242);
    const r = await t.post("/plan/resume");
    expect(r.body.pausedSec).toBe(4.242);
    assertExactMove(before, await items(t), 4_242);
  });
});

describe("P8 rule 7 · limits", () => {
  it("pause while paused is 409 CONFLICT and carries the current state", async () => {
    const t = await api();
    await t.post("/plan/pause");
    t.clock.advance(1_500);
    const e = expectError(await t.post("/plan/pause"), 409, "CONFLICT");
    expect(e.details).toEqual({ paused: { since: NOW, elapsedSec: 1.5 } });
    expect((await t.get("/health")).body.paused.since, "the original instant is kept").toBe(NOW);
  });

  it("resume while not paused is 409 CONFLICT with paused: null", async () => {
    const t = await api();
    const e = expectError(await t.post("/plan/resume"), 409, "CONFLICT");
    expect(e.details).toEqual({ paused: null });
  });

  it("a pause longer than 24 h is 400 INVALID_INPUT and the pause is still there", async () => {
    const t = await api();
    const before = (await items(t)).map(line);
    await t.post("/plan/pause");
    t.clock.advance(25 * 3_600_000);
    const e = expectError(await t.post("/plan/resume"), 400, "INVALID_INPUT");
    expect(e.hint).toContain('"unit": "days"');
    expect(e.details).toMatchObject({ paused: { since: NOW } });
    expect((await t.get("/health")).body.paused.since, "nothing is lost").toBe(NOW);
    // Yesterday's plan rolled over on the clock move, but the pause itself is untouched.
    expect(before.length).toBeGreaterThan(0);
    // The day shift the hint names is allowed, and it clears the pause the resume could not apply.
    expect((await t.post("/plan/shift", { amount: 1, unit: "days" })).status).toBe(200);
    expect((await t.get("/health")).body.paused).toBeNull();
  });

  it("exactly 24 h still resumes", async () => {
    const t = await api();
    await t.post("/plan/pause");
    t.clock.advance(24 * 3_600_000);
    const r = await t.post("/plan/resume");
    expect(r.status).toBe(200);
    expect(r.body.pausedSec).toBe(86_400);
  });
});

describe("P8 rules 5 and 6 · events and the calendar", () => {
  it("pause publishes the state and queues no sync; resume publishes it and queues one", async () => {
    const t = await api();
    const seen: BusEvent[] = [];
    t.api.bus.on((e) => seen.push(e));
    expect(t.api.sync.queued).toBe(false);

    await t.post("/plan/pause");
    expect(seen.map((e) => e.event)).toEqual(["plan"]);
    expect(seen[0]!.data).toEqual({ dates: [], reason: "pause", paused: { since: NOW, elapsedSec: 0 } });
    expect(t.api.sync.queued, "a pause changes nothing, so it syncs nothing").toBe(false);

    t.clock.advance(45_000);
    await t.post("/plan/resume");
    const last = seen.at(-1)!;
    expect(last.event).toBe("plan");
    expect(last.data).toMatchObject({ reason: "resume", paused: null });
    expect((last.data as { dates: string[] }).dates).toContain(TODAY);
    expect(t.api.sync.queued, "resume queues the usual debounced sync").toBe(true);
  });

  it("the calendar view of a resumed item is whole seconds, so a sync does not patch it for ever", async () => {
    const t = await api();
    await t.post("/plan/pause");
    t.clock.advance(45_317);
    await t.post("/plan/resume");
    const { calendarView } = await import("@planner/store");
    const { toEvent } = await import("@planner/calendar");
    // Every upcoming item is now mid-minute, which is exactly the case that could churn.
    const upcoming = (await items(t)).filter((i) => i.kind === "task" && ms(i.start) > ms(NOW));
    // All but the rest that absorbed the pause now start mid-minute.
    expect(upcoming.filter((i) => i.start.endsWith(":45.317+01:00")).length).toBeGreaterThan(3);
    for (const it of upcoming) {
      const sent = toEvent(calendarView(it), TZ);
      // What we send has no fraction, so it is exactly what Google stores and reads back. `needsPatch`
      // compares the two as instants, so a second sync of an unchanged item is a no-op.
      expect(sent.start.dateTime, `${it.key} sent without a fraction`).not.toMatch(/\.\d+\+/);
      expect(Date.parse(sent.start.dateTime)).toBe(Math.floor(ms(it.start) / 1000) * 1000);
      expect(Date.parse(sent.end.dateTime)).toBe(Math.floor(ms(it.end) / 1000) * 1000);
      expect(Date.parse(toEvent(calendarView(it), TZ).start.dateTime), "stable across calls").toBe(Date.parse(sent.start.dateTime));
    }
  });

  it("a second sync of a resumed, mid-minute plan writes nothing: no insert, no patch", async () => {
    const fake = await startFakeGoogle();
    try {
      const client = fakeClient(fake);
      const t = await api({ calendarClient: () => client, calendarOptions: { retry: { maxTries: 2, sleep: async () => {} } } });
      await t.post("/plan/pause");
      t.clock.advance(45_317);
      await t.post("/plan/resume");
      await t.api.sync.flush();
      const first = (await t.get("/sync/status")).body.lastResult;
      expect(first.inserted).toBeGreaterThan(0);
      // Nothing changed in between, and every upcoming item now sits mid-minute. Google keeps whole
      // seconds, so without the truncation in `calendarView` this second pass would patch them all.
      const second = (await t.post("/sync", {})).body;
      expect({ inserted: second.inserted, patched: second.patched, deleted: second.deleted }, "nothing churns").toEqual({ inserted: 0, patched: 0, deleted: 0 });
      expect(second.unchanged).toBeGreaterThan(0);
    } finally {
      await fake.stop();
    }
  });
});
