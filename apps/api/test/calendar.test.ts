import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeGoogle, type FakeGoogle } from "../../../packages/calendar/test/fake-google.ts";
import { fakeClient } from "../../../packages/calendar/test/helpers.ts";
import { cleanup, enc, expectError, makeApi, ms, type TestApi } from "./helpers.ts";

let fake: FakeGoogle;
beforeAll(async () => {
  fake = await startFakeGoogle();
});
afterAll(async () => {
  await fake.stop();
});

let t: TestApi;
afterEach(async () => {
  await t.close();
  cleanup(t.dir);
});

const noRetry = { retry: { maxTries: 2, sleep: async () => {} } };

async function withCalendar() {
  const client = fakeClient(fake);
  t = await makeApi({ calendarClient: () => client, calendarOptions: noRetry });
  return t;
}

describe("a calendar the owner supplied (CALENDAR_ID)", () => {
  it("syncs into it, reports it, and never creates one of its own", async () => {
    const client = fakeClient(fake);
    // A calendar the owner made and shared: the planner writes into it and must not replace it.
    const calendarId = fake.addCalendar("owner-made@group.calendar.google.com");
    fake.resetLog();
    t = await makeApi({ calendarClient: () => client, calendarOptions: noRetry, calendarId });

    const health = (await t.get("/health")).body;
    expect(health.calendar).toMatchObject({ calendarId, owned: false });
    expect((await t.get("/sync/status")).body).toMatchObject({ calendarId, owned: false });

    const r = await t.post("/sync");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.calendarId).toBe(calendarId);
    expect(r.body.inserted).toBeGreaterThan(0);
    // The request that must never happen: calendars.insert. A calendar the planner created would
    // belong to the credential, not to the owner, and would be invisible in their Google Calendar.
    expect(fake.requests.filter((q) => q.method === "POST" && /\/calendars\/?$/.test(q.path))).toEqual([]);
    expect(fake.liveEvents(calendarId).length).toBe(r.body.inserted);

    // Idempotent into a calendar we do not own, exactly as into one we do.
    const again = await t.post("/sync");
    expect(again.body).toMatchObject({ inserted: 0, patched: 0, deleted: 0 });

    // And the id is what GET /calendar/events reads back from.
    const events = (await t.get("/calendar/events")).body;
    expect(events.length).toBe(r.body.inserted);
  });

  it("a configured calendar that is not reachable is reported, not replaced", async () => {
    const client = fakeClient(fake);
    fake.resetLog();
    t = await makeApi({ calendarClient: () => client, calendarOptions: noRetry, calendarId: "never-shared@group.calendar.google.com" });
    const e = expectError(await t.post("/sync"), 502, "CALENDAR_ERROR");
    expect(e.message).toMatch(/never-shared/);
    expect(e.message).toMatch(/shared|sharing|CALENDAR_ID/i);
    expect(fake.requests.filter((q) => q.method === "POST" && /\/calendars\/?$/.test(q.path))).toEqual([]);
    // The local plan is untouched by a calendar problem.
    expect((await t.get("/today")).body.day.items.length).toBeGreaterThan(0);
  });
});

describe("calendar sync against the fake Google server", () => {
  it("mutations sync events with titles, links and times; resync is a no-op; a 1 h shift patches the same events", async () => {
    await withCalendar();
    const key = (await t.get("/today")).body.day.items[0].key;
    expect((await t.post(`/items/${enc(key)}/status`, { status: "done" })).status).toBe(200);
    expect(t.api.sync.queued).toBe(true);
    await t.api.sync.flush();

    const status = (await t.get("/sync/status")).body;
    expect(status).toMatchObject({ authorized: true, pending: false, lastError: null });
    const calendarId = status.calendarId as string;
    expect(calendarId).toBeTruthy();

    const plan = (await t.get("/plan")).body.days;
    const tasks = plan.flatMap((d: any) => d.items).filter((i: any) => i.kind === "task");
    expect(status.lastResult).toMatchObject({ inserted: tasks.length, patched: 0, deleted: 0 });
    const live = fake.liveEvents(calendarId);
    expect(live).toHaveLength(tasks.length);
    const byKey = new Map(live.map((e) => [e.extendedProperties!.private!.plannerKey, e]));
    for (const it of tasks) {
      const ev = byKey.get(it.key)! as any;
      expect(ev.summary).toBe(it.title);
      expect(ms(ev.start.dateTime)).toBe(ms(it.start));
      expect(ms(ev.end.dateTime)).toBe(ms(it.end));
      if (it.links?.[0]) {
        expect(ev.source.url).toBe(it.links[0].url);
        expect(ev.description.split("\n")[0]).toBe(it.links[0].url);
      }
    }
    // Read-back through the API.
    const events = (await t.get("/calendar/events")).body;
    expect(events).toHaveLength(tasks.length);
    const a1 = events.find((e: any) => e.plannerKey === key);
    expect(a1).toMatchObject({ summary: "A1 · Alpha task 1", sourceUrl: "https://example.com/alpha/1" });

    // Two more syncs: zero writes.
    fake.resetLog();
    for (let i = 0; i < 2; i++) {
      const r = await t.post("/sync", {});
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ inserted: 0, patched: 0, deleted: 0, unchanged: tasks.length });
    }
    expect(fake.eventWrites()).toHaveLength(0);
    expect(fake.liveEvents(calendarId)).toHaveLength(tasks.length);

    // Shift 1 h: same event ids, times moved, patched not re-created.
    const idsBefore = new Map(fake.liveEvents(calendarId).map((e) => [e.extendedProperties!.private!.plannerKey, e.id]));
    const todayBefore = (await t.get("/today")).body;
    const moving = todayBefore.day.items.filter((i: any) => i.kind === "task" && ms(i.start) >= ms(todayBefore.now));
    fake.resetLog();
    expect((await t.post("/plan/shift", { amount: 1, unit: "hours" })).status).toBe(200);
    await t.api.sync.flush();
    const last = (await t.get("/sync/status")).body.lastResult;
    expect(last).toMatchObject({ inserted: 0, deleted: 0, patched: moving.length });
    const after = new Map(fake.liveEvents(calendarId).map((e) => [e.extendedProperties!.private!.plannerKey, e]));
    for (const it of moving) {
      const ev = after.get(it.key)!;
      expect(ev.id).toBe(idsBefore.get(it.key));
      expect(ms(ev.start.dateTime)).toBe(ms(it.start) + 3600_000);
    }
    expect(fake.eventWrites().every((w) => w.method === "PATCH")).toBe(true);
  });

  it("a checked item off the timeline keeps its event untouched; a checked item never gets a new event", async () => {
    await withCalendar();
    // Checked before any sync: no event is ever created for it.
    const early = (await t.get("/plan?from=2026-09-30&days=1")).body.days[0].items.find((i: any) => i.kind === "task" && !i.taskUid.endsWith("/DAILY") && !i.part);
    await t.post(`/items/${enc(early.key)}/status`, { status: "skipped" });
    await t.post("/sync", {});
    const calendarId = (await t.get("/sync/status")).body.calendarId;
    expect(fake.liveEvents(calendarId).some((e) => e.extendedProperties!.private!.plannerKey === early.key)).toBe(false);

    const tomorrow = (await t.get("/plan?from=2026-09-29&days=1")).body.days[0];
    const item = tomorrow.items.find((i: any) => i.kind === "task" && !i.taskUid.endsWith("/DAILY") && !i.part);
    const eventBefore = fake.liveEvents(calendarId).find((e) => e.extendedProperties!.private!.plannerKey === item.key)!;
    fake.resetLog();
    expect((await t.post(`/items/${enc(item.key)}/status`, { status: "done" })).status).toBe(200);
    const day = (await t.get("/plan?from=2026-09-29&days=1")).body.days[0];
    expect(day.items.some((i: any) => i.key === item.key)).toBe(false);
    expect(day.checked.find((i: any) => i.key === item.key)).toMatchObject({ status: "done", start: item.start, plannedStart: item.start, plannedEnd: item.end });
    await t.api.sync.flush();
    const eventAfter = fake.liveEvents(calendarId).find((e) => e.extendedProperties!.private!.plannerKey === item.key)!;
    expect(eventAfter.id).toBe(eventBefore.id);
    expect(ms(eventAfter.start.dateTime)).toBe(ms(item.start));
    expect(eventAfter.etag).toBe(eventBefore.etag); // not patched
    expect(fake.eventWrites().some((w) => w.path.endsWith(eventBefore.id))).toBe(false);
    for (const e of fake.liveEvents(calendarId)) expect(ms(e.start.dateTime)).toBeGreaterThanOrEqual(ms(`${e.start.dateTime.slice(0, 10)}T07:00:00Z`));
  });

  it("Google errors: POST /sync returns 502 CALENDAR_ERROR, the mutation still succeeds", async () => {
    await withCalendar();
    await t.post("/sync", {});
    fake.injectFault({ count: 50, status: 500, method: "GET", pathIncludes: "/events" });
    const key = (await t.get("/today")).body.day.items[2].key;
    expect((await t.post(`/items/${enc(key)}/status`, { status: "done" })).status).toBe(200);
    const e = expectError(await t.post("/sync", {}), 502, "CALENDAR_ERROR");
    expect(e.hint).toMatch(/Local state is saved/);
    expect((await t.get("/sync/status")).body).toMatchObject({ pending: true, lastError: { code: "CALENDAR_ERROR" } });
    expect((await t.get("/today")).body.day.items[2].status).toBe("done");
    (fake as any).faults = [];
    expect((await t.post("/sync", {})).status).toBe(200);
    expect((await t.get("/sync/status")).body).toMatchObject({ pending: false, lastError: null });
  });
});
