import { ensureCalendar, type EnsureCalendarInput } from "./calendar.ts";
import { CalendarApiError, CalendarNotFoundError, NotAuthorizedError } from "./errors.ts";
import { call, seg, type CalendarOptions, type RequestClient } from "./http.ts";
import { PLANNER_APP, toEvent, type CalendarEventBody, type PlanItem } from "./mapping.ts";

export interface SyncWindow {
  /** Inclusive lower bound (RFC 3339 with offset, or Date). Events ending after this are in the window. */
  from: string | Date;
  /** Exclusive upper bound. Events starting before this are in the window. */
  to: string | Date;
}

/** Raw Google event (fields we read). */
export interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  source?: { title?: string; url?: string };
  extendedProperties?: { private?: Record<string, string>; shared?: Record<string, string> };
}

export interface PlannerEvent {
  eventId: string;
  plannerKey: string;
  summary: string;
  start: string;
  end: string;
  sourceUrl?: string;
  description?: string;
}

export interface ReconcileError {
  key: string;
  op: "insert" | "patch" | "delete";
  eventId?: string;
  status?: number;
  message: string;
}

export interface ReconcileResult {
  inserted: number;
  patched: number;
  deleted: number;
  unchanged: number;
  errors: ReconcileError[];
}

export interface ReconcileOptions extends CalendarOptions {
  /** Time zone written on events. Default: the system zone. */
  timeZone?: string;
  /** Page size for events.list (Google max 2500, default 250). */
  pageSize?: number;
}

const iso = (d: string | Date) => (typeof d === "string" ? d : d.toISOString());
const ms = (s: string | undefined) => (s ? Date.parse(s) : NaN);
const defaultZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function eventsPath(calendarId: string, eventId?: string) {
  return `/calendars/${seg(calendarId)}/events${eventId ? `/${seg(eventId)}` : ""}`;
}

async function listEvents(
  client: RequestClient,
  calendarId: string,
  params: Record<string, unknown>,
  opts?: ReconcileOptions,
): Promise<GoogleEvent[]> {
  const out: GoogleEvent[] = [];
  let pageToken: string | undefined;
  do {
    const res = await call<{ items?: GoogleEvent[]; nextPageToken?: string }>(
      client,
      {
        method: "GET",
        path: eventsPath(calendarId),
        params: {
          ...params,
          singleEvents: true,
          showDeleted: false,
          maxResults: opts?.pageSize ?? 250,
          pageToken,
        },
      },
      { ...opts, okStatuses: [404, 410] },
    );
    if (res.status === 404 || res.status === 410) throw new CalendarNotFoundError(calendarId);
    for (const e of res.data.items ?? []) {
      if (e.status !== "cancelled") out.push(e);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

/** All events with a plannerKey in the window (paginated; filtered server-side by our marker). */
async function listPlannerRaw(
  client: RequestClient,
  calendarId: string,
  window: SyncWindow,
  opts?: ReconcileOptions,
): Promise<GoogleEvent[]> {
  const events = await listEvents(
    client,
    calendarId,
    { timeMin: iso(window.from), timeMax: iso(window.to), privateExtendedProperty: [`plannerApp=${PLANNER_APP}`] },
    opts,
  );
  return events.filter((e) => typeof e.extendedProperties?.private?.plannerKey === "string");
}

/** Read-back: planner-managed events in the window, normalized and sorted by start. */
export async function listPlannerEvents(
  client: RequestClient,
  calendarId: string,
  window: SyncWindow,
  opts?: ReconcileOptions,
): Promise<PlannerEvent[]> {
  const raw = await listPlannerRaw(client, calendarId, window, opts);
  return raw
    .map((e) => ({
      eventId: e.id,
      plannerKey: e.extendedProperties!.private!.plannerKey!,
      summary: e.summary ?? "",
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
      ...(e.source?.url ? { sourceUrl: e.source.url } : {}),
      ...(e.description !== undefined ? { description: e.description } : {}),
    }))
    .sort((a, b) => ms(a.start) - ms(b.start) || a.plannerKey.localeCompare(b.plannerKey));
}

/**
 * Same instant as far as a calendar server is concerned. Google stores whole seconds and we write
 * whole seconds, but a server that rounds or normalizes sub-second values differently must never be
 * able to start a patch loop: nobody drags an event by less than a second, so a difference below 1 s
 * is never a manual edit.
 */
const sameInstant = (a: string | undefined, b: string): boolean => Math.abs(ms(a) - ms(b)) < 1000;

function needsPatch(existing: GoogleEvent, desired: CalendarEventBody): boolean {
  if (existing.extendedProperties?.private?.plannerHash !== desired.extendedProperties.private.plannerHash) return true;
  // Cheap drift detection for manual edits in Google Calendar (hash would still match).
  if (!sameInstant(existing.start?.dateTime, desired.start.dateTime)) return true;
  if (!sameInstant(existing.end?.dateTime, desired.end.dateTime)) return true;
  if ((existing.summary ?? "") !== desired.summary) return true;
  return false;
}

/** Patch body: full desired content, with explicit nulls to clear fields that are now absent. */
function patchBody(desired: CalendarEventBody): Record<string, unknown> {
  return { description: null, source: null, ...desired };
}

function inWindow(item: PlanItem, from: number, to: number): boolean {
  return ms(item.end) > from && ms(item.start) < to;
}

/**
 * Makes the calendar match `items` inside `window`:
 * - inserts task items with no event, patches events whose content hash (or times/title) differ,
 * - deletes planner events (with plannerKey) whose key is no longer planned, plus duplicates.
 * Events without plannerKey are never touched. Rest items are ignored. Items outside the window
 * are ignored (pass a window covering every item you care about).
 * Before inserting, an event with the same plannerKey outside the window is looked up by
 * privateExtendedProperty and patched instead, so moving an item across the window edge never
 * duplicates it. Per-event failures are collected in `errors`; list failures throw.
 */
export async function reconcile(
  client: RequestClient,
  calendarId: string,
  items: PlanItem[],
  window: SyncWindow,
  opts?: ReconcileOptions,
): Promise<ReconcileResult> {
  const timeZone = opts?.timeZone ?? defaultZone();
  const from = ms(iso(window.from));
  const to = ms(iso(window.to));
  if (!(from < to)) throw new RangeError(`reconcile: invalid window ${iso(window.from)} .. ${iso(window.to)}`);

  const desired = new Map<string, CalendarEventBody>();
  for (const item of items) {
    if (item.kind !== "task" || !inWindow(item, from, to) || desired.has(item.key)) continue;
    desired.set(item.key, toEvent(item, timeZone));
  }

  const existing = await listPlannerRaw(client, calendarId, window, opts);
  const byKey = new Map<string, GoogleEvent[]>();
  for (const e of existing) {
    const k = e.extendedProperties!.private!.plannerKey!;
    const list = byKey.get(k) ?? [];
    list.push(e);
    byKey.set(k, list);
  }

  const result: ReconcileResult = { inserted: 0, patched: 0, deleted: 0, unchanged: 0, errors: [] };

  const fail = (key: string, op: ReconcileError["op"], err: unknown, eventId?: string) => {
    if (err instanceof NotAuthorizedError || err instanceof CalendarNotFoundError) throw err;
    result.errors.push({
      key,
      op,
      ...(eventId ? { eventId } : {}),
      ...(err instanceof CalendarApiError && err.status !== undefined ? { status: err.status } : {}),
      message: err instanceof Error ? err.message : String(err),
    });
  };

  const del = async (key: string, eventId: string) => {
    try {
      const res = await call(client, { method: "DELETE", path: eventsPath(calendarId, eventId) }, {
        ...opts,
        okStatuses: [404, 410],
      });
      if (res.status < 300 || res.status === 404 || res.status === 410) result.deleted++;
    } catch (err) {
      fail(key, "delete", err, eventId);
    }
  };

  const patch = async (key: string, eventId: string, body: CalendarEventBody) => {
    try {
      const res = await call(client, { method: "PATCH", path: eventsPath(calendarId, eventId), data: patchBody(body) }, {
        ...opts,
        okStatuses: [404, 410],
      });
      if (res.status === 404 || res.status === 410) {
        // Deleted between list and patch: recreate it.
        await call(client, { method: "POST", path: eventsPath(calendarId), data: body }, opts);
        result.inserted++;
      } else result.patched++;
    } catch (err) {
      fail(key, "patch", err, eventId);
    }
  };

  // 1. Deletions: keys no longer planned, and duplicates of planned keys.
  for (const [key, events] of byKey) {
    const keep = desired.has(key) ? 1 : 0;
    for (const e of events.slice(keep)) await del(key, e.id);
  }

  // 2. Patches and inserts.
  for (const [key, body] of desired) {
    const current = byKey.get(key)?.[0];
    if (current) {
      if (needsPatch(current, body)) await patch(key, current.id, body);
      else result.unchanged++;
      continue;
    }
    try {
      // An event for this key may exist outside the window (item moved across the edge).
      const elsewhere = (
        await listEvents(client, calendarId, { privateExtendedProperty: [`plannerKey=${key}`] }, opts)
      ).filter((e) => e.extendedProperties?.private?.plannerKey === key);
      if (elsewhere.length > 0) {
        await patch(key, elsewhere[0]!.id, body);
        for (const dup of elsewhere.slice(1)) await del(key, dup.id);
        continue;
      }
      await call(client, { method: "POST", path: eventsPath(calendarId), data: body }, opts);
      result.inserted++;
    } catch (err) {
      fail(key, "insert", err);
    }
  }
  return result;
}

export interface SyncPlanInput extends Omit<EnsureCalendarInput, "timeZone"> {
  items: PlanItem[];
  window: SyncWindow;
  timeZone: string;
}

/**
 * Convenience for callers (API / daemon): ensureCalendar + reconcile. If the calendar vanishes
 * mid-sync (CalendarNotFoundError), it is recreated once and the reconcile is retried - unless the
 * calendar id came from configuration, in which case there is nothing to recreate (see
 * `EnsureCalendarInput.calendarId`) and the retry would only repeat the same 404.
 */
export async function syncPlan(
  client: RequestClient,
  input: SyncPlanInput,
  opts?: ReconcileOptions,
): Promise<ReconcileResult & { calendarId: string }> {
  const run = async () => {
    const calendarId = await ensureCalendar(client, input, opts);
    const r = await reconcile(client, calendarId, input.items, input.window, { ...opts, timeZone: input.timeZone });
    return { calendarId, ...r };
  };
  try {
    return await run();
  } catch (err) {
    if (err instanceof CalendarNotFoundError && !input.calendarId) return run();
    if (err instanceof CalendarNotFoundError && input.calendarId)
      throw new CalendarNotFoundError(
        input.calendarId,
        `Calendar ${input.calendarId} is not reachable. Either CALENDAR_ID is wrong, or the calendar is no longer shared with this credential. ` +
          "Open that calendar's \"Settings and sharing\" in Google Calendar and check it still grants \"Make changes to events\" to the service account's email.",
      );
    throw err;
  }
}
