import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OAuth2Client } from "google-auth-library";
import {
  CalendarNotFoundError,
  ensureCalendar,
  listPlannerEvents,
  reconcile,
  syncPlan,
  type PlanItem,
} from "../src/index.ts";
import { startFakeGoogle, type FakeGoogle } from "./fake-google.ts";
import { TZ, WINDOW, at, fakeClient, makeItems, noSleep, shiftItems, shiftItemsMs } from "./helpers.ts";

let fake: FakeGoogle;
let client: OAuth2Client;
let calendarId: string;
const opts = { timeZone: TZ, retry: noSleep };
const tasks = (items: PlanItem[]) => items.filter((i) => i.kind === "task");

beforeAll(async () => {
  fake = await startFakeGoogle();
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(async () => {
  client = fakeClient(fake);
  let stored: string | undefined;
  calendarId = await ensureCalendar(client, {
    timeZone: TZ,
    stateGet: () => stored,
    stateSet: (id) => {
      stored = id;
    },
  });
  fake.resetLog();
});

describe("reconcile", () => {
  it("creates one event per task item (rests ignored) and reads them back", async () => {
    const items = makeItems(10);
    const r = await reconcile(client, calendarId, items, WINDOW, opts);
    expect(r).toEqual({ inserted: 10, patched: 0, deleted: 0, unchanged: 0, errors: [] });
    expect(fake.liveEvents(calendarId)).toHaveLength(10);

    const back = await listPlannerEvents(client, calendarId, WINDOW, opts);
    expect(back).toHaveLength(10);
    for (const t of tasks(items)) {
      const e = back.find((b) => b.plannerKey === t.key)!;
      expect(e.summary).toBe(t.title);
      expect(e.sourceUrl).toBe(t.links![0]!.url);
      expect(e.description!.split("\n")[0]).toBe(t.links![0]!.url);
      expect(Date.parse(e.start)).toBe(Date.parse(t.start));
      expect(Date.parse(e.end)).toBe(Date.parse(t.end));
    }
    // request budget: <= 2 requests per event (+ list pages)
    expect(fake.requests.length).toBeLessThanOrEqual(2 * 10 + 2);
  });

  it("second and third runs write nothing and create no duplicates", async () => {
    const items = makeItems(12);
    await reconcile(client, calendarId, items, WINDOW, opts);
    for (let run = 0; run < 2; run++) {
      fake.resetLog();
      const r = await reconcile(client, calendarId, items, WINDOW, opts);
      expect(r).toEqual({ inserted: 0, patched: 0, deleted: 0, unchanged: 12, errors: [] });
      expect(fake.eventWrites()).toHaveLength(0);
    }
    const keys = fake.liveEvents(calendarId).map((e) => e.extendedProperties!.private!.plannerKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(12);
  });

  /**
   * A resume (docs/PLAN.md, P8) shifts by the exact elapsed milliseconds, so every upcoming item
   * ends up on a fractional second. Google - and the fake - store whole seconds, so unless we floor
   * the times before writing them, the event we read back never equals the event we want and every
   * later sync patches it again. One tick of a checkbox would push an "event updated" for the whole
   * rest of the day, every time.
   */
  it("a fractional-second shift (a resume) patches once, then never again", async () => {
    const items = makeItems(9);
    await reconcile(client, calendarId, items, WINDOW, opts);
    const before = await listPlannerEvents(client, calendarId, WINDOW, opts);

    const resumed = shiftItemsMs(items, 1_317);
    expect(tasks(resumed)[0]!.start).toMatch(/\.317\+01:00$/);
    const r = await reconcile(client, calendarId, resumed, WINDOW, opts);
    expect(r).toEqual({ inserted: 0, patched: 9, deleted: 0, unchanged: 0, errors: [] });

    // Two more syncs of the same, unchanged, mid-second plan must write nothing at all.
    for (let run = 0; run < 2; run++) {
      fake.resetLog();
      const again = await reconcile(client, calendarId, resumed, WINDOW, opts);
      expect(again, `sync ${run + 2}`).toEqual({ inserted: 0, patched: 0, deleted: 0, unchanged: 9, errors: [] });
      expect(fake.eventWrites(), `sync ${run + 2} wrote nothing`).toHaveLength(0);
    }

    // The events moved by the whole second the shift crossed, and kept their ids.
    const after = await listPlannerEvents(client, calendarId, WINDOW, opts);
    expect(after.map((a) => a.eventId).sort()).toEqual(before.map((b) => b.eventId).sort());
    for (const a of after) {
      const b = before.find((x) => x.eventId === a.eventId)!;
      expect(Date.parse(a.start) - Date.parse(b.start)).toBe(1_000); // 1.317 s floored to 1 s
      expect(a.start, "stored with no fractional second").not.toMatch(/\.\d+Z$/);
    }
  });

  it("resumes inside the same second write nothing: the calendar cannot represent the difference", async () => {
    const items = makeItems(4);
    await reconcile(client, calendarId, items, WINDOW, opts);
    const none = { inserted: 0, patched: 0, deleted: 0, unchanged: 4, errors: [] };
    // 317 ms, then 717 ms: both floor to the same whole second as the original, so there is nothing
    // to tell the calendar. Without the flooring each of these would push an update for every event.
    expect(await reconcile(client, calendarId, shiftItemsMs(items, 317), WINDOW, opts), "+317 ms").toEqual(none);
    expect(await reconcile(client, calendarId, shiftItemsMs(items, 717), WINDOW, opts), "+717 ms").toEqual(none);
    // Crossing the second does patch - once.
    const over = shiftItemsMs(items, 1_200);
    expect((await reconcile(client, calendarId, over, WINDOW, opts)).patched, "+1200 ms").toBe(4);
    expect((await reconcile(client, calendarId, over, WINDOW, opts)).patched, "and then never again").toBe(0);
  });

  it("a server that stores a sub-second value of its own never starts a patch loop", async () => {
    // Belt and braces for the flooring above: whatever a calendar server does with sub-second values
    // (rounds up, keeps them, drops them), a difference under a second is never a manual edit, so it
    // must not be treated as drift. Without the tolerance this patches on every single sync.
    const items = makeItems(1);
    await reconcile(client, calendarId, items, WINDOW, opts);
    const [ev] = fake.liveEvents(calendarId);
    const off = (s: string) => new Date(Date.parse(s) + 300).toISOString();
    ev!.start = { dateTime: off(ev!.start.dateTime) };
    ev!.end = { dateTime: off(ev!.end.dateTime) };
    for (let run = 0; run < 3; run++) {
      const r = await reconcile(client, calendarId, items, WINDOW, opts);
      expect(r, `sync ${run + 1}`).toEqual({ inserted: 0, patched: 0, deleted: 0, unchanged: 1, errors: [] });
    }
    // A real manual edit - a whole minute - is still repaired.
    ev!.start = { dateTime: new Date(Date.parse(ev!.start.dateTime) + 60_000).toISOString() };
    expect((await reconcile(client, calendarId, items, WINDOW, opts)).patched).toBe(1);
  });

  it("shifting all items by 1 h patches only and keeps event ids", async () => {
    const items = makeItems(9);
    await reconcile(client, calendarId, items, WINDOW, opts);
    const before = await listPlannerEvents(client, calendarId, WINDOW, opts);
    const shifted = shiftItems(items, 60);
    const r = await reconcile(client, calendarId, shifted, WINDOW, opts);
    expect(r).toEqual({ inserted: 0, patched: 9, deleted: 0, unchanged: 0, errors: [] });
    const after = await listPlannerEvents(client, calendarId, WINDOW, opts);
    expect(after.map((a) => a.eventId).sort()).toEqual(before.map((b) => b.eventId).sort());
    for (const a of after) {
      const b = before.find((x) => x.eventId === a.eventId)!;
      expect(Date.parse(a.start) - Date.parse(b.start)).toBe(3600_000);
      expect(Date.parse(a.end) - Date.parse(b.end)).toBe(3600_000);
    }
    const again = await reconcile(client, calendarId, shifted, WINDOW, opts);
    expect(again.inserted + again.patched + again.deleted).toBe(0);
  });

  /**
   * The point of the setting: it has to reach the events that are already in the calendar. The plan
   * has not moved, so only the reminder policy can be what makes the patch happen - and the second
   * run proves the new value is what got stored rather than the event flapping on every sync.
   */
  it("turning reminders on patches existing events, then settles", async () => {
    const items = makeItems(9);
    await reconcile(client, calendarId, items, WINDOW, opts);
    for (const e of fake.liveEvents(calendarId)) expect(e.reminders).toEqual({ useDefault: false, overrides: [] });

    const withReminder = { ...opts, reminders: 10 as const };
    const r = await reconcile(client, calendarId, items, WINDOW, withReminder);
    expect(r).toEqual({ inserted: 0, patched: 9, deleted: 0, unchanged: 0, errors: [] });
    for (const e of fake.liveEvents(calendarId)) {
      expect(e.reminders).toEqual({ useDefault: false, overrides: [{ method: "popup", minutes: 10 }] });
    }

    const again = await reconcile(client, calendarId, items, WINDOW, withReminder);
    expect(again).toEqual({ inserted: 0, patched: 0, deleted: 0, unchanged: 9, errors: [] });

    // And back off again, so the setting is reversible rather than one-way.
    expect((await reconcile(client, calendarId, items, WINDOW, opts)).patched).toBe(9);
    for (const e of fake.liveEvents(calendarId)) expect(e.reminders).toEqual({ useDefault: false, overrides: [] });
  });

  it("omitting the policy keeps the silent default, so the sync is unchanged for everyone else", async () => {
    const items = makeItems(4);
    await reconcile(client, calendarId, items, WINDOW, { timeZone: TZ, retry: noSleep, reminders: "off" });
    const r = await reconcile(client, calendarId, items, WINDOW, opts);
    expect(r.patched).toBe(0);
    expect(r.unchanged).toBe(4);
  });

  it("deletes events whose item is no longer planned", async () => {
    const items = makeItems(5);
    await reconcile(client, calendarId, items, WINDOW, opts);
    const removed = tasks(items)[2]!;
    const r = await reconcile(client, calendarId, items.filter((i) => i.key !== removed.key), WINDOW, opts);
    expect(r).toEqual({ inserted: 0, patched: 0, deleted: 1, unchanged: 4, errors: [] });
    const keys = fake.liveEvents(calendarId).map((e) => e.extendedProperties!.private!.plannerKey);
    expect(keys).not.toContain(removed.key);
  });

  it("never touches events without plannerKey", async () => {
    const foreign = fake.addEvent(calendarId, {
      summary: "Dentist",
      start: { dateTime: at(0, 9 * 60) },
      end: { dateTime: at(0, 10 * 60) },
    });
    const foreignWithMarker = fake.addEvent(calendarId, {
      summary: "Hand-made",
      start: { dateTime: at(0, 11 * 60) },
      end: { dateTime: at(0, 12 * 60) },
      extendedProperties: { private: { plannerApp: "study-planner" } },
    });
    await reconcile(client, calendarId, makeItems(4), WINDOW, opts);
    const r = await reconcile(client, calendarId, [], WINDOW, opts); // everything unplanned
    expect(r.deleted).toBe(4);
    const live = fake.liveEvents(calendarId);
    expect(live.map((e) => e.id).sort()).toEqual([foreign.id, foreignWithMarker.id].sort());
    expect(fake.liveEvents(calendarId).find((e) => e.id === foreign.id)!.etag).toBe(foreign.etag);
    expect(fake.eventWrites().some((w) => w.path.endsWith(foreign.id) || w.path.endsWith(foreignWithMarker.id))).toBe(false);
  });

  it("paginates beyond 250 events", async () => {
    const items = makeItems(300);
    const r1 = await reconcile(client, calendarId, items, WINDOW, opts);
    expect(r1.inserted).toBe(300);
    fake.resetLog();
    const r2 = await reconcile(client, calendarId, items, WINDOW, opts);
    expect(r2).toEqual({ inserted: 0, patched: 0, deleted: 0, unchanged: 300, errors: [] });
    const lists = fake.requests.filter((q) => q.method === "GET" && q.path.endsWith("/events"));
    expect(lists).toHaveLength(2);
    expect(lists[1]!.query.get("pageToken")).toBeTruthy();
    expect(lists[0]!.query.getAll("privateExtendedProperty")).toEqual(["plannerApp=study-planner"]);
    expect(await listPlannerEvents(client, calendarId, WINDOW, opts)).toHaveLength(300);
  });

  it("retries 429 with exponential backoff and succeeds", async () => {
    const delays: number[] = [];
    const retry = { baseDelayMs: 100, sleep: async (ms: number) => void delays.push(ms) };
    fake.injectFault({ count: 3, status: 429, method: "POST", pathIncludes: "/events" });
    const r = await reconcile(client, calendarId, makeItems(3), WINDOW, { timeZone: TZ, retry });
    expect(r).toEqual({ inserted: 3, patched: 0, deleted: 0, unchanged: 0, errors: [] });
    expect(fake.liveEvents(calendarId)).toHaveLength(3);
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeGreaterThanOrEqual(50);
    expect(delays[0]).toBeLessThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(100);
    expect(delays[2]).toBeGreaterThanOrEqual(200);
  });

  it("gives up after 5 tries, reports the error, and carries on", async () => {
    fake.injectFault({ count: 5, status: 503, method: "POST", pathIncludes: "/events" });
    const r = await reconcile(client, calendarId, makeItems(2), WINDOW, opts);
    expect(r.inserted).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ op: "insert", status: 503 });
    const r2 = await reconcile(client, calendarId, makeItems(2), WINDOW, opts);
    expect(r2).toMatchObject({ inserted: 1, unchanged: 1, errors: [] });
  });

  it("treats 404/410 on delete as success", async () => {
    await reconcile(client, calendarId, makeItems(2), WINDOW, opts);
    fake.injectFault({ count: 1, status: 410, method: "DELETE" });
    fake.injectFault({ count: 1, status: 404, method: "DELETE" });
    const r = await reconcile(client, calendarId, [], WINDOW, opts);
    expect(r).toEqual({ inserted: 0, patched: 0, deleted: 2, unchanged: 0, errors: [] });
  });

  it("does not duplicate an item that moved in from outside the window", async () => {
    const items = makeItems(1);
    const far = shiftItems(items, 70 * 24 * 60); // beyond WINDOW.to
    await reconcile(client, calendarId, far, { from: WINDOW.from, to: at(90, 0) }, opts);
    const r = await reconcile(client, calendarId, items, WINDOW, opts);
    expect(r).toMatchObject({ inserted: 0, patched: 1 });
    expect(fake.liveEvents(calendarId)).toHaveLength(1);
  });

  it("removes duplicate events carrying the same plannerKey", async () => {
    const items = makeItems(1);
    await reconcile(client, calendarId, items, WINDOW, opts);
    const [ev] = fake.liveEvents(calendarId);
    const { id: _id, etag: _e, ...copy } = ev!;
    fake.addEvent(calendarId, copy);
    const r = await reconcile(client, calendarId, items, WINDOW, opts);
    expect(r).toMatchObject({ deleted: 1, unchanged: 1 });
    expect(fake.liveEvents(calendarId)).toHaveLength(1);
  });

  it("repairs manual edits made in Google Calendar", async () => {
    const items = makeItems(1);
    await reconcile(client, calendarId, items, WINDOW, opts);
    const [ev] = fake.liveEvents(calendarId);
    ev!.start = { dateTime: "2026-09-28T15:00:00Z" };
    ev!.end = { dateTime: "2026-09-28T16:00:00Z" };
    const r = await reconcile(client, calendarId, items, WINDOW, opts);
    expect(r.patched).toBe(1);
    expect(Date.parse(fake.liveEvents(calendarId)[0]!.start.dateTime)).toBe(Date.parse(tasks(items)[0]!.start));
  });

  it("clears source when the item loses its links", async () => {
    const items = makeItems(1);
    await reconcile(client, calendarId, items, WINDOW, opts);
    const noLinks = items.map((i) => ({ ...i, links: [] }));
    await reconcile(client, calendarId, noLinks, WINDOW, opts);
    const [ev] = fake.liveEvents(calendarId);
    expect(ev!.source).toBeUndefined();
    expect(ev!.description).toBe("Track: bcg · Type: lesson");
  });

  it("throws CalendarNotFoundError when the calendar vanished", async () => {
    fake.deleteCalendarExternally(calendarId);
    await expect(reconcile(client, calendarId, makeItems(1), WINDOW, opts)).rejects.toBeInstanceOf(CalendarNotFoundError);
  });
});

describe("ensureCalendar / syncPlan", () => {
  it("reuses the stored calendar, recreates it after external deletion", async () => {
    let stored: string | undefined;
    const sets: string[] = [];
    const state = {
      timeZone: TZ,
      stateGet: () => stored,
      stateSet: (id: string) => {
        stored = id;
        sets.push(id);
      },
    };
    const id1 = await ensureCalendar(client, state);
    const id2 = await ensureCalendar(client, state);
    expect(id2).toBe(id1);
    expect(sets).toEqual([id1]);
    expect(fake.calendars.get(id1)).toMatchObject({ summary: "Daymark", timeZone: TZ });

    fake.deleteCalendarExternally(id1);
    const id3 = await ensureCalendar(client, state);
    expect(id3).not.toBe(id1);
    expect(sets).toEqual([id1, id3]);
    expect(stored).toBe(id3);
  });

  it("syncPlan recreates a deleted calendar and repopulates it", async () => {
    let stored: string | undefined;
    const input = {
      timeZone: TZ,
      stateGet: () => stored,
      stateSet: (id: string) => {
        stored = id;
      },
      items: makeItems(3),
      window: WINDOW,
    };
    const first = await syncPlan(client, input, { retry: noSleep });
    expect(first.inserted).toBe(3);
    fake.deleteCalendarExternally(first.calendarId);
    const second = await syncPlan(client, input, { retry: noSleep });
    expect(second.calendarId).not.toBe(first.calendarId);
    expect(second.inserted).toBe(3);
    expect(fake.liveEvents(second.calendarId)).toHaveLength(3);
  });
});
