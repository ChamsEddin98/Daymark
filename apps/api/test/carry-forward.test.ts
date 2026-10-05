/**
 * Unfinished work moves to the next day, by itself, for as long as it takes.
 *
 * The owner's words: "even if it affects the program length ... basically the tasks work
 * sequentially". So a day nobody touched must cost the plan a day, not cost the owner the work —
 * while `skipped` stays a separate, deliberate way to spend a task without doing it.
 *
 * These run against the **real** `resources/` folder, because the property being tested is about the
 * owner's actual plan surviving neglect, and a fixture could hide an interaction between the prep
 * queue, the capped lesson series and the uncapped portfolio block.
 */
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fixedClock } from "@planner/store";
import { createApi, type Api } from "../src/app.ts";
// These build an API over the owner's own plan files, which are gitignored.
import { hasRealPlans } from "../../../packages/core/test/real-plans.ts";
import { cleanup, enc, notAuthorized, tempDir } from "./helpers.ts";

const TZ = "Europe/Paris";
const RESOURCES = resolve(import.meta.dirname, "../../../resources");
const D1 = "2026-11-02"; // a Monday; no DST change inside the window
const at = (date: string, hhmm = "08:00") => `${date}T${hhmm}:00+01:00`;
const next = (date: string, n = 1) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const open: Api[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const a of open.splice(0)) await a.close();
  for (const d of dirs.splice(0)) cleanup(d);
});

/** The API on the real plan files, with a clock a test can walk forward a day at a time. */
async function realApi(now: string, dir?: string) {
  const d = dir ?? tempDir("planner-carry-");
  if (!dir) dirs.push(d);
  const api = await createApi({
    dataDir: d,
    resourcesDir: RESOURCES,
    clock: fixedClock(now, TZ),
    timeZone: TZ,
    horizon: 7,
    pollMs: 0,
    heartbeatMs: 0,
    logger: false,
    syncDebounceMs: 20,
    calendarClient: notAuthorized,
    env: {},
  });
  open.push(api);
  const call = async (m: "GET" | "POST", url: string, payload?: unknown) => {
    const res = await api.app.inject({ method: m, url, ...(payload !== undefined ? { payload: payload as object, headers: { "content-type": "application/json" } } : {}) });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };
  return { api, dir: d, get: (u: string) => call("GET", u), post: (u: string, p?: unknown) => call("POST", u, p) };
}

type T = Awaited<ReturnType<typeof realApi>>;

/** Minutes of one-off work still owed across the whole plan: the number that must never shrink. */
async function oneOffOwed(t: T): Promise<number> {
  const tasks = (await t.get("/tasks")).body.tasks as any[];
  return tasks.filter((x) => !x.repeat).reduce((n, x) => n + (x.status === "pending" ? (x.progress?.remainingMin ?? 0) : 0), 0);
}
const uidsOn = async (t: T, date: string) =>
  ((await t.get(`/plan?from=${date}&days=1`)).body.days[0].items as any[]).filter((i) => i.kind === "task").map((i) => i.taskUid as string);

/** Walk the clock to 08:00 on `date` in a fresh process, as the owner reopening the app would. */
async function nextMorning(t: T, date: string): Promise<T> {
  await t.api.close();
  open.splice(open.indexOf(t.api), 1);
  return realApi(at(date), t.dir);
}

describe.skipIf(!hasRealPlans)("a day nobody touched costs the plan a day, not the work", () => {
  it("every unfinished task from yesterday is on the plan again today", async () => {
    let t = await realApi(at(D1));
    const before = await uidsOn(t, D1);
    const owed = await oneOffOwed(t);
    expect(before.length).toBeGreaterThan(0);

    t = await nextMorning(t, next(D1)); // a whole day passed; nothing was checked
    const after = await uidsOn(t, next(D1));

    // The one-off work is all still owed, to the minute.
    expect(await oneOffOwed(t)).toBe(owed);
    // And yesterday's one-off tasks are scheduled again.
    const oneOff = (list: string[]) => list.filter((u) => !u.endsWith("/DAILY"));
    for (const uid of oneOff(before)) expect(after, `${uid} vanished instead of moving`).toContain(uid);
    // Yesterday keeps nothing: a pending item never happened (P7, history is immutable).
    const past = (await t.get(`/plan?from=${D1}&days=1`)).body.days[0];
    expect([...past.items, ...past.checked]).toEqual([]);
  });

  it("four ignored days lose no work at all, and the plan simply reaches further out", async () => {
    let t = await realApi(at(D1));
    const owed = await oneOffOwed(t);
    const firstEnd = (await t.get("/health")).body.horizon.end;

    let date = D1;
    for (let i = 0; i < 4; i++) {
      date = next(date);
      t = await nextMorning(t, date);
      expect(await oneOffOwed(t), `work was lost on day ${i + 2}`).toBe(owed);
    }
    // Nothing was dropped, and the horizon has rolled forward with the days: there is no fixed
    // programme end that neglect could run past.
    expect(await oneOffOwed(t)).toBe(owed);
    expect((await t.get("/health")).body.horizon.end > firstEnd).toBe(true);
    // Work is still being handed out, in order.
    expect((await uidsOn(t, date)).length).toBeGreaterThan(0);
  });

  it("a capped lesson series spends a session only when it is acted on", async () => {
    let t = await realApi(at(D1));
    const lessons = (await t.get("/tasks")).body.tasks.find((x: any) => x.uid === "lessons/DAILY");
    if (!lessons?.occurrences) return; // the real file has no cap: nothing to protect
    expect(lessons.progress.sessionsHeld ?? 0).toBe(0);

    // Three days ignored.
    let date = D1;
    for (let i = 0; i < 3; i++) {
      date = next(date);
      t = await nextMorning(t, date);
    }
    const after = (await t.get(`/tasks/${enc("lessons/DAILY")}`)).body;
    // This is the bug the owner's request exposed: a day that merely went by used to burn a lesson,
    // so three ignored days cost three of the series for ever. Now the series slides instead.
    expect(after.progress.sessionsHeld ?? 0, "an ignored day spent a lesson").toBe(0);
    expect(after.scheduledOn.length, "the series stopped being handed out").toBeGreaterThan(0);
  });

  it("but doing one, or skipping one, does spend a session", async () => {
    let t = await realApi(at(D1));
    const lessons = (await t.get("/tasks")).body.tasks.find((x: any) => x.uid === "lessons/DAILY");
    if (!lessons?.occurrences) return;

    expect((await t.post(`/tasks/${enc("lessons/DAILY")}/status`, { status: "done", date: D1 })).status).toBe(200);
    t = await nextMorning(t, next(D1));
    expect((await t.get(`/tasks/${enc("lessons/DAILY")}`)).body.progress.sessionsHeld).toBe(1);

    const d2 = next(D1);
    expect((await t.post(`/tasks/${enc("lessons/DAILY")}/status`, { status: "skipped", date: d2 })).status).toBe(200);
    t = await nextMorning(t, next(D1, 2));
    // Skipping is a decision, so it costs a session exactly as doing it does. That is what keeps
    // "skip" meaningful rather than a synonym for ignoring something.
    expect((await t.get(`/tasks/${enc("lessons/DAILY")}`)).body.progress.sessionsHeld).toBe(2);
  });
});

describe.skipIf(!hasRealPlans)("skip still removes work for good", () => {
  it("a skipped one-off task does not come back the next day", async () => {
    let t = await realApi(at(D1));
    const first = (await uidsOn(t, D1)).find((u) => !u.endsWith("/DAILY"))!;
    const owed = await oneOffOwed(t);
    const cost = (await t.get(`/tasks/${enc(first)}`)).body.progress.remainingMin;

    expect((await t.post(`/tasks/${enc(first)}/status`, { status: "skipped" })).status).toBe(200);
    expect(await oneOffOwed(t), "skipping did not reduce the work owed").toBe(owed - cost);

    t = await nextMorning(t, next(D1));
    expect(await uidsOn(t, next(D1)), `${first} came back after being skipped`).not.toContain(first);
    expect((await t.get(`/tasks/${enc(first)}`)).body.status).toBe("skipped");
    // Still skipped a week later: it is gone, not deferred.
    t = await nextMorning(t, next(D1, 7));
    expect((await t.get(`/tasks/${enc(first)}`)).body.status).toBe("skipped");
  });

  it("the order is preserved: the carried task leads the next day", async () => {
    let t = await realApi(at(D1));
    const before = (await uidsOn(t, D1)).filter((u) => !u.endsWith("/DAILY"));
    t = await nextMorning(t, next(D1));
    const after = (await uidsOn(t, next(D1))).filter((u) => !u.endsWith("/DAILY"));
    // Sequential: the work resumes where it stopped rather than jumping ahead in the queue.
    expect(after[0]).toBe(before[0]);
  });
});
