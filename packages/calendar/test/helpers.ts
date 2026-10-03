import { OAuth2Client } from "google-auth-library";
import type { PlanItem } from "../src/mapping.ts";
import { withBaseUrl } from "../src/http.ts";
import type { FakeGoogle } from "./fake-google.ts";

export const TZ = "Africa/Tunis"; // UTC+01:00, no DST

/** A client already holding a valid fake access token. */
export function fakeClient(fake: FakeGoogle): OAuth2Client {
  const client = new OAuth2Client({ clientId: fake.clientId, clientSecret: fake.clientSecret, endpoints: fake.endpoints });
  client.setCredentials({
    access_token: fake.issueAccessToken(),
    refresh_token: fake.issueRefreshToken(),
    expiry_date: Date.now() + 3600_000,
    token_type: "Bearer",
  });
  return withBaseUrl(client, fake.calendarBaseUrl);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local "+01:00" timestamp for day offset d (from 2026-09-28) at minute-of-day m. */
export function at(d: number, m: number): string {
  const date = new Date(Date.UTC(2026, 8, 28 + d));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(Math.floor(m / 60))}:${pad(m % 60)}:00+01:00`;
}

/** n task items of 50 min spread over days, 8 per day, with a rest after each. */
export function makeItems(n: number): PlanItem[] {
  const items: PlanItem[] = [];
  for (let i = 0; i < n; i++) {
    const d = Math.floor(i / 8);
    const slot = i % 8;
    const startMin = 8 * 60 + slot * 60;
    const date = at(d, 0).slice(0, 10);
    items.push({
      key: `${date}|T${i}|1`,
      date,
      kind: "task",
      start: at(d, startMin),
      end: at(d, startMin + 50),
      taskUid: `T${i}`,
      track: "bcg",
      title: `Task number ${i}`,
      links: [
        { label: "Platform", url: `https://example.com/course/${i}` },
        { label: "Notes", url: `https://example.com/notes/${i}` },
      ],
      type: "lesson",
      status: "pending",
    });
    items.push({
      key: `${date}|rest|${slot}`,
      date,
      kind: "rest",
      start: at(d, startMin + 50),
      end: at(d, startMin + 60),
      title: "Rest",
      restKind: "short",
      status: "pending",
    });
  }
  return items;
}

export function shiftItems(items: PlanItem[], minutes: number): PlanItem[] {
  const move = (s: string) => {
    const t = new Date(Date.parse(s) + minutes * 60_000 + 3600_000); // render in +01:00
    return t.toISOString().replace(/\.000Z$/, "+01:00");
  };
  return items.map((i) => ({ ...i, start: move(i.start), end: move(i.end) }));
}

export const WINDOW = { from: at(0, 0), to: at(60, 0) };

export const noSleep = { sleep: async () => {} };

/**
 * Shift every item by an exact number of milliseconds, the way a resume does (docs/PLAN.md, P8).
 * The result carries a fractional second, which is what the calendar has to cope with.
 */
export function shiftItemsMs(items: PlanItem[], msDelta: number): PlanItem[] {
  const move = (s: string) => {
    const t = Date.parse(s) + msDelta + 3600_000; // render in +01:00
    return new Date(t).toISOString().replace(/(\.000)?Z$/, "+01:00");
  };
  return items.map((i) => ({ ...i, start: move(i.start), end: move(i.end) }));
}
