import { createHash } from "node:crypto";
import { toIso } from "@planner/core";
// Type-only import (erased at runtime). @planner/core's index does not re-export the schedule types yet.
import type { PlanItem } from "../../core/src/schedule/types.ts";

export type { PlanItem };

/** Marker stored on every event we create, so listing can filter server-side. */
export const PLANNER_APP = "study-planner";

export interface EventDateTime {
  dateTime: string;
  timeZone?: string;
}

/** The subset of the Google Calendar Event resource this package writes. */
export interface CalendarEventBody {
  summary: string;
  description?: string;
  start: EventDateTime;
  end: EventDateTime;
  source?: { title: string; url: string };
  reminders: { useDefault: boolean; overrides: { method: string; minutes: number }[] };
  transparency: "opaque" | "transparent";
  extendedProperties: { private: { plannerKey: string; plannerHash: string; plannerApp: string } };
}

export function buildDescription(item: PlanItem): string | undefined {
  const lines: string[] = [];
  const links = item.links ?? [];
  const [primary, ...others] = links;
  if (primary) lines.push(primary.url);
  for (const l of others) lines.push(`${l.label} — ${l.url}`);
  const meta: string[] = [];
  if (item.track) meta.push(`Track: ${item.track}`);
  if (item.type) meta.push(`Type: ${item.type}`);
  if (meta.length) lines.push(meta.join(" · "));
  return lines.length ? lines.join("\n") : undefined;
}

/** Stable content hash of everything we write except the hash itself. */
export function contentHash(body: Omit<CalendarEventBody, "extendedProperties">, key: string): string {
  const canonical = JSON.stringify([
    "v1",
    key,
    body.summary,
    body.description ?? null,
    body.start.dateTime,
    body.start.timeZone ?? null,
    body.end.dateTime,
    body.end.timeZone ?? null,
    body.source ? [body.source.title, body.source.url] : null,
    body.reminders,
    body.transparency,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Google Calendar stores whole seconds and normalizes anything finer away, so a plan time that
 * carries a fractional second - which every upcoming item does after a resume (docs/PLAN.md, P8) -
 * has to be floored HERE, before it is written and before `contentHash` reads it. Sending `.317`
 * would mean the event we read back never equals the event we want, and every sync of an unchanged
 * plan would patch it again, for ever.
 */
export const wholeSecond = (iso: string, timeZone: string): string => toIso(Math.floor(Date.parse(iso) / 1000) * 1000, timeZone);

/**
 * Pure mapping PlanItem -> Google Calendar event body. Title is used verbatim (it already carries
 * " (part i/n)" when split). Only task items should be passed; rests throw. Times are floored to
 * whole seconds (see `wholeSecond`).
 */
/**
 * How a planner event fills Google's `reminders`.
 *
 * - `"off"` (the default): `useDefault: false` with no overrides, so Google never notifies. The
 *   planner's own daemon already fires four native toasts per task - start, end, rest start, rest
 *   end - and a Google reminder on top would double every one of them on the machine running it.
 * - `"inherit"`: `useDefault: true`, so the event obeys whatever that calendar's own "Event
 *   notifications" say. Note that a freshly created secondary calendar has **none** by default, so
 *   this is silent until you add one in Google Calendar.
 * - a number: minutes before the start, as a popup. This is the one that reaches a phone without any
 *   further setup, which is the whole reason it exists - the daemon's toasts only reach the desk.
 */
export type ReminderPolicy = "off" | "inherit" | number;

/** The `reminders` field for a policy. Invalid input falls back to `off` rather than throwing: a bad
 *  setting must never be able to stop a sync. */
export function remindersFor(policy: ReminderPolicy): CalendarEventBody["reminders"] {
  if (policy === "inherit") return { useDefault: true, overrides: [] };
  if (typeof policy === "number" && Number.isInteger(policy) && policy >= 0 && policy <= 40_320)
    return { useDefault: false, overrides: [{ method: "popup", minutes: policy }] };
  return { useDefault: false, overrides: [] };
}

export function toEvent(item: PlanItem, timeZone: string, reminders: ReminderPolicy = "off"): CalendarEventBody {
  if (item.kind !== "task") throw new Error(`toEvent: only task items become events (got ${item.kind} ${item.key})`);
  const primary = item.links?.[0];
  const description = buildDescription(item);
  const body: Omit<CalendarEventBody, "extendedProperties"> = {
    summary: item.title,
    ...(description !== undefined ? { description } : {}),
    start: { dateTime: wholeSecond(item.start, timeZone), timeZone },
    end: { dateTime: wholeSecond(item.end, timeZone), timeZone },
    ...(primary ? { source: { title: primary.label, url: primary.url } } : {}),
    reminders: remindersFor(reminders),
    transparency: "opaque",
  };
  return {
    ...body,
    extendedProperties: {
      private: { plannerKey: item.key, plannerHash: contentHash(body, item.key), plannerApp: PLANNER_APP },
    },
  };
}
