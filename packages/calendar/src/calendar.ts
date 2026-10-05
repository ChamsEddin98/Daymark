import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CalendarApiError } from "./errors.ts";
import { DEFAULT_CALENDAR_NAME } from "@planner/core";
import { call, seg, type CalendarOptions, type RequestClient } from "./http.ts";

export interface CalendarState {
  /** Returns the stored calendar id, if any. */
  stateGet: () => string | null | undefined | Promise<string | null | undefined>;
  /** Persists the calendar id. */
  stateSet: (calendarId: string) => void | Promise<void>;
}

export interface EnsureCalendarInput extends CalendarState {
  /**
   * A calendar the planner does **not** own, given by configuration (`CALENDAR_ID`). When set it is
   * authoritative: `ensureCalendar` returns it and never creates anything, not even if Google says
   * it is gone.
   *
   * That "not even if it is gone" is the whole point. Creating a replacement is right for a calendar
   * the planner made itself, and wrong for one the owner made and shared: a service account that
   * created a calendar would *own* it, and an owned calendar is invisible in the owner's Google
   * Calendar. Every sync would then report success for ever while nothing ever appeared. A 404 here
   * means the id is wrong or the sharing was removed, and saying so is the only useful answer.
   */
  calendarId?: string;
  /**
   * What the calendar is called. Default `DEFAULT_CALENDAR_NAME`.
   *
   * It is used when the planner creates a calendar, and - for a calendar the planner **owns** - to
   * rename it when the owner changes the setting. It is ignored for a calendar given by
   * `calendarId`: that one belongs to the owner, who names it in Google Calendar themselves, and
   * the `calendar.events` scope cannot read or write a Calendar resource at all.
   */
  summary?: string;
  /** IANA time zone for the calendar, e.g. "Africa/Tunis". */
  timeZone: string;
  description?: string;
}

interface CalendarResource {
  id: string;
  summary?: string;
  timeZone?: string;
}

/**
 * Returns the id of the dedicated planner calendar. Uses the stored id if the calendar still
 * exists (GET /calendars/{id}); if it was deleted (404/410) or none is stored, creates a new one
 * (calendars.insert) and stores its id.
 */
export async function ensureCalendar(
  client: RequestClient,
  input: EnsureCalendarInput,
  opts?: CalendarOptions,
): Promise<string> {
  if (input.calendarId) {
    // Recorded so GET /sync/status reports the calendar actually in use. Not verified here: the
    // events call that follows does that anyway, and `calendar.events` cannot read a Calendar
    // resource, so a GET /calendars/{id} would 403 on exactly the setup this branch exists for.
    const stored = await input.stateGet();
    if (stored !== input.calendarId) await input.stateSet(input.calendarId);
    return input.calendarId;
  }
  const want = input.summary ?? DEFAULT_CALENDAR_NAME;
  const stored = await input.stateGet();
  if (stored) {
    const res = await call<CalendarResource>(
      client,
      { method: "GET", path: `/calendars/${seg(stored)}` },
      { ...opts, okStatuses: [404, 410] },
    );
    if (res.status < 300 && res.data?.id) {
      // The planner owns this calendar, so the name setting is allowed to reach it. Patched only on
      // a real difference: a PATCH on every sync would be a write per sync for no change.
      if (res.data.summary !== want)
        await call(client, { method: "PATCH", path: `/calendars/${seg(res.data.id)}`, data: { summary: want } }, opts);
      return res.data.id;
    }
  }
  const created = await call<CalendarResource>(
    client,
    {
      method: "POST",
      path: "/calendars",
      data: {
        summary: want,
        timeZone: input.timeZone,
        description: input.description ?? "Managed by the study planner. Events here are rewritten on every sync.",
      },
    },
    opts,
  );
  if (!created.data?.id) throw new CalendarApiError("calendars.insert returned no id", created.status);
  await input.stateSet(created.data.id);
  return created.data.id;
}

/** Simple JSON-file implementation of CalendarState (used by the CLI). Writes atomically. */
export function jsonFileState(path: string, key = "calendarId"): CalendarState {
  const read = (): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  };
  return {
    stateGet: () => {
      const v = read()[key];
      return typeof v === "string" ? v : undefined;
    },
    stateSet: (id: string) => {
      const next = { ...read(), [key]: id };
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2));
      renameSync(tmp, path);
    },
  };
}
