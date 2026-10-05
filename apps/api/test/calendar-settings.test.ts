/**
 * The two calendar settings over HTTP: `calendarReminders` and `calendarName`.
 *
 * The mapping is proved in `packages/calendar/test/mapping.test.ts` and the patching in
 * `reconcile.test.ts`. What is tested here is the part neither can see: that the setting is durable,
 * that both processes read the same answer, that it does **not** move the plan, and - the whole
 * point of the feature - that changing it over HTTP ends up on the events in the calendar.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PlanService, PlannerStore, fixedClock, loadResources } from "@planner/store";
import { startFakeGoogle, type FakeGoogle } from "../../../packages/calendar/test/fake-google.ts";
import { fakeClient } from "../../../packages/calendar/test/helpers.ts";
import { FIXTURES, NOW, TZ, cleanup, expectError, makeApi, type TestApi } from "./helpers.ts";

let fake: FakeGoogle;
beforeAll(async () => {
  fake = await startFakeGoogle();
});
afterAll(async () => {
  await fake.stop();
});

let t: TestApi;
afterEach(async () => {
  if (t) {
    await t.close();
    cleanup(t.dir);
  }
});

const noRetry = { retry: { maxTries: 2, sleep: async () => {} } };

describe("GET /settings", () => {
  it("reports off by default: the daemon notifies, so Google does not", async () => {
    t = await makeApi();
    expect((await t.get("/settings")).body.calendarReminders).toBe("off");
  });
});

describe("PATCH /settings { calendarReminders }", () => {
  it("stores a number of minutes and reads it back", async () => {
    t = await makeApi();
    const r = await t.patch("/settings", { calendarReminders: 10 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ calendarReminders: 10, changed: true, sync: "queued" });
    expect((await t.get("/settings")).body.calendarReminders).toBe(10);
  });

  it("accepts off and inherit", async () => {
    t = await makeApi();
    expect((await t.patch("/settings", { calendarReminders: "inherit" })).body.calendarReminders).toBe("inherit");
    expect((await t.patch("/settings", { calendarReminders: "off" })).body.calendarReminders).toBe("off");
  });

  it("accepts a numeric string, because a form field and a query parameter both send one", async () => {
    t = await makeApi();
    expect((await t.patch("/settings", { calendarReminders: "15" })).body.calendarReminders).toBe(15);
  });

  /**
   * The distinguishing property of this setting: it changes how the day is *announced*, never when
   * it runs. A reminder change that re-planned the day would re-time work the owner is in the middle
   * of, which is exactly what the active hours have to do and this must not.
   */
  it("regenerates nothing: the plan does not move", async () => {
    t = await makeApi();
    const before = (await t.get("/today")).body;
    const r = await t.patch("/settings", { calendarReminders: 30 });
    expect(r.body.regenerated).toEqual([]);
    const after = (await t.get("/today")).body;
    expect(after.items).toEqual(before.items);
  });

  it("still queues a sync, because the events have to be rewritten", async () => {
    t = await makeApi();
    expect((await t.patch("/settings", { calendarReminders: 30 })).body.sync).toBe("queued");
  });

  it("reports changed: false and skips the sync when the value is already set", async () => {
    t = await makeApi();
    await t.patch("/settings", { calendarReminders: 10 });
    const r = await t.patch("/settings", { calendarReminders: 10 });
    expect(r.body).toMatchObject({ calendarReminders: 10, changed: false, sync: "skipped" });
  });

  it("can be set together with the active hours in one call", async () => {
    t = await makeApi();
    const r = await t.patch("/settings", { calendarReminders: 5, dayEnd: "20:00" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.calendarReminders).toBe(5);
    expect(r.body.activeHours.dayEnd).toBe("20:00");
    // The hours did move the plan, so this call regenerates where the reminder alone would not.
    expect(r.body.regenerated.length).toBeGreaterThan(0);
  });

  it("refuses what Google cannot represent, and says what the choices mean", async () => {
    t = await makeApi();
    for (const bad of [-1, 40_321, 10.5, true, {}, "soon"]) {
      const r = await t.patch("/settings", { calendarReminders: bad });
      expectError(r, 400, "INVALID_INPUT");
      expect(r.body.error.hint).toMatch(/minutes before the start/);
    }
    // Nothing was stored by any of those.
    expect((await t.get("/settings")).body.calendarReminders).toBe("off");
  });

  it("dryRun validates without storing", async () => {
    t = await makeApi();
    const ok = await t.patch("/settings?dryRun=1", { calendarReminders: 20 });
    expect(ok.body).toMatchObject({ calendarReminders: 20, dryRun: true, sync: "skipped" });
    expect((await t.get("/settings")).body.calendarReminders).toBe("off");
    // A preview that passes cannot be followed by a commit that fails, and vice versa.
    expectError(await t.patch("/settings?dryRun=1", { calendarReminders: 99_999 }), 400, "INVALID_INPUT");
  });

  /** The API and the daemon hold separate services, so the value must come off disk every time. */
  it("is durable and visible to a second process", async () => {
    t = await makeApi();
    await t.patch("/settings", { calendarReminders: 25 });

    const store = new PlannerStore({ dir: t.dir });
    try {
      const other = new PlanService({ store, clock: fixedClock(NOW, TZ), timeZone: TZ, horizon: 7, files: loadResources(FIXTURES).files });
      expect(other.calendarReminders()).toBe(25);
      // And it keeps up with a later change rather than holding the value it first read.
      await t.patch("/settings", { calendarReminders: 35 });
      expect(other.calendarReminders()).toBe(35);
    } finally {
      store.close();
    }
  });
});

/**
 * `calendarName` sits on the same endpoint but describes the calendar, not the plan. The honest
 * part matters most: it can only reach Google for a calendar the planner owns, so an owner-supplied
 * calendar has to be told the setting will not apply rather than being left to assume it did.
 */
describe("PATCH /settings { calendarName }", () => {
  it("defaults to Daymark and is reported as applying when the planner owns the calendar", async () => {
    t = await makeApi();
    const r = (await t.get("/settings")).body;
    expect(r.calendarName).toBe("Daymark");
    expect(r.calendarNameApplies).toBe(true);
  });

  it("stores a name and reads it back", async () => {
    t = await makeApi();
    const r = await t.patch("/settings", { calendarName: "My Study Plan" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ calendarName: "My Study Plan", changed: true, sync: "queued" });
    expect((await t.get("/settings")).body.calendarName).toBe("My Study Plan");
  });

  it("trims, and null restores the default", async () => {
    t = await makeApi();
    expect((await t.patch("/settings", { calendarName: "  Padded  " })).body.calendarName).toBe("Padded");
    expect((await t.patch("/settings", { calendarName: null })).body.calendarName).toBe("Daymark");
  });

  it("does not move the plan: a name is not a schedule", async () => {
    t = await makeApi();
    const before = (await t.get("/today")).body;
    const r = await t.patch("/settings", { calendarName: "Renamed" });
    expect(r.body.regenerated).toEqual([]);
    expect((await t.get("/today")).body.items).toEqual(before.items);
    // But a sync is queued, because the calendar itself has to be renamed.
    expect(r.body.sync).toBe("queued");
  });

  it("refuses an empty, over-long or multi-line name", async () => {
    t = await makeApi();
    for (const bad of ["", "   ", "a".repeat(201), "two\nlines", "tab\there", 5, {}]) {
      expectError(await t.patch("/settings", { calendarName: bad }), 400, "INVALID_INPUT");
    }
    expect((await t.get("/settings")).body.calendarName).toBe("Daymark");
  });

  it("reports changed: false when the name is already set", async () => {
    t = await makeApi();
    await t.patch("/settings", { calendarName: "Same" });
    expect((await t.patch("/settings", { calendarName: "Same" })).body).toMatchObject({ changed: false, sync: "skipped" });
  });

  it("dryRun validates without storing", async () => {
    t = await makeApi();
    expect((await t.patch("/settings?dryRun=1", { calendarName: "Preview" })).body).toMatchObject({ calendarName: "Preview", dryRun: true });
    expect((await t.get("/settings")).body.calendarName).toBe("Daymark");
    expectError(await t.patch("/settings?dryRun=1", { calendarName: "" }), 400, "INVALID_INPUT");
  });

  it("can be set with the reminders and the hours in one call", async () => {
    t = await makeApi();
    const r = await t.patch("/settings", { calendarName: "All At Once", calendarReminders: 15, dayEnd: "21:00" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ calendarName: "All At Once", calendarReminders: 15 });
    expect(r.body.activeHours.dayEnd).toBe("21:00");
  });

  /** The whole reason the flag exists: a setting the credential cannot apply must say so. */
  it("says it does not apply to a calendar the owner supplied", async () => {
    t = await makeApi({ calendarId: "owner-made@group.calendar.google.com" });
    expect((await t.get("/settings")).body.calendarNameApplies).toBe(false);
    // Still stored rather than refused - the credential can change later - but reported honestly.
    const r = await t.patch("/settings", { calendarName: "Wishful" });
    expect(r.body).toMatchObject({ calendarName: "Wishful", calendarNameApplies: false, changed: true });
  });
});

describe("the setting reaches the calendar", () => {
  it("a sync after PATCH /settings writes the popup onto every event", async () => {
    const client = fakeClient(fake);
    const calendarId = fake.addCalendar("owner-made@group.calendar.google.com");
    t = await makeApi({ calendarClient: () => client, calendarOptions: noRetry, calendarId });

    const first = await t.post("/sync");
    expect(first.body.inserted).toBeGreaterThan(0);
    for (const e of fake.liveEvents(calendarId)) expect(e.reminders).toEqual({ useDefault: false, overrides: [] });

    expect((await t.patch("/settings", { calendarReminders: 10 })).status).toBe(200);
    const second = await t.post("/sync");
    // Every event is patched and none recreated: the plan did not move, only the body changed.
    expect(second.body.patched).toBe(first.body.inserted);
    expect(second.body.inserted).toBe(0);
    for (const e of fake.liveEvents(calendarId)) {
      expect(e.reminders).toEqual({ useDefault: false, overrides: [{ method: "popup", minutes: 10 }] });
    }

    // And it settles: the next sync has nothing to do.
    const third = await t.post("/sync");
    expect(third.body.patched + third.body.inserted + third.body.deleted).toBe(0);
  });

  /** End to end for the name: PATCH /settings renames the calendar the planner owns, in place. */
  it("a sync after PATCH /settings renames the planner's own calendar, keeping its events", async () => {
    const client = fakeClient(fake);
    t = await makeApi({ calendarClient: () => client, calendarOptions: noRetry });

    const first = await t.post("/sync");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.inserted).toBeGreaterThan(0);
    expect(fake.calendarSummary(first.body.calendarId)).toBe("Daymark");

    expect((await t.patch("/settings", { calendarName: "FDE Prep" })).status).toBe(200);
    const second = await t.post("/sync");
    expect(second.body.calendarId, "renamed in place, not replaced").toBe(first.body.calendarId);
    expect(fake.calendarSummary(second.body.calendarId)).toBe("FDE Prep");
    expect(fake.liveEvents(second.body.calendarId)).toHaveLength(first.body.inserted);
    expect(second.body.inserted).toBe(0);
  });
});
