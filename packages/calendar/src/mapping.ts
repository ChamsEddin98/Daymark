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
export function toEvent(item: PlanItem, timeZone: string): CalendarEventBody {
  if (item.kind !== "task") throw new Error(`toEvent: only task items become events (got ${item.kind} ${item.key})`);
  const primary = item.links?.[0];
  const description = buildDescription(item);
  const body: Omit<CalendarEventBody, "extendedProperties"> = {
    summary: item.title,
    ...(description !== undefined ? { description } : {}),
    start: { dateTime: wholeSecond(item.start, timeZone), timeZone },
    end: { dateTime: wholeSecond(item.end, timeZone), timeZone },
    ...(primary ? { source: { title: primary.label, url: primary.url } } : {}),
    reminders: { useDefault: false, overrides: [] },
    transparency: "opaque",
  };
  return {
    ...body,
    extendedProperties: {
      private: { plannerKey: item.key, plannerHash: contentHash(body, item.key), plannerApp: PLANNER_APP },
    },
  };
}
