import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NotAuthorizedError } from "@planner/calendar";
import { fixedClock, type ManualClock } from "@planner/store";
import { zonedMs, type PlanDay, type PlanItem } from "@planner/core";
import { expect } from "vitest";
import { createApi, type Api, type ApiOptions } from "../src/app.ts";

export const TZ = "Africa/Tunis"; // UTC+01:00, no DST
export const NOW = "2026-09-28T10:15:00+01:00";
export const TODAY = "2026-09-28";
export const TOMORROW = "2026-09-29";
export const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/resources");

export const notAuthorized = () => {
  throw new NotAuthorizedError("No Google token (test)");
};

export function tempDir(prefix = "planner-api-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A copy of the fixtures that a test may break. */
export function tempResources(): string {
  const d = tempDir("planner-res-");
  cpSync(FIXTURES, d, { recursive: true });
  return d;
}

export function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold WAL files briefly */
  }
}

export interface TestApi {
  api: Api;
  dir: string;
  clock: ManualClock;
  get<T = any>(url: string): Promise<{ status: number; body: T }>;
  post<T = any>(url: string, payload?: unknown): Promise<{ status: number; body: T }>;
  patch<T = any>(url: string, payload?: unknown): Promise<{ status: number; body: T }>;
  del<T = any>(url: string, payload?: unknown): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

export async function makeApi(o: Partial<ApiOptions> & { now?: string; dir?: string } = {}): Promise<TestApi> {
  const dir = o.dir ?? tempDir();
  const clock = fixedClock(o.now ?? NOW, TZ);
  const { now: _now, dir: _dir, ...rest } = o;
  const api = await createApi({
    dataDir: dir,
    resourcesDir: FIXTURES,
    clock,
    timeZone: TZ,
    horizon: 7,
    pollMs: 0,
    heartbeatMs: 0,
    logger: false,
    syncDebounceMs: 20,
    calendarClient: notAuthorized,
    env: {},
    ...rest,
  });
  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
    const res = await api.app.inject({
      method,
      url,
      ...(payload !== undefined ? { payload: payload as object, headers: { "content-type": "application/json" } } : {}),
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };
  return {
    api,
    dir,
    clock,
    get: (url) => call("GET", url),
    post: (url, payload) => call("POST", url, payload),
    patch: (url, payload) => call("PATCH", url, payload),
    del: (url, payload) => call("DELETE", url, payload),
    close: () => api.close(),
  };
}

export const enc = encodeURIComponent;
export const tasksOf = (d: PlanDay): any[] => d.items.filter((i) => i.kind === "task");
export const shape = (items: PlanItem[]) => items.map((i) => `${i.key} ${i.start} ${i.end}`);
export const ms = (iso: string) => Date.parse(iso);

export function expectError(res: { status: number; body: any }, status: number, code: string) {
  if (res.status !== status || res.body?.error?.code !== code)
    throw new Error(`expected ${status} ${code}, got ${res.status} ${JSON.stringify(res.body)}`);
  const e = res.body.error;
  if (typeof e.message !== "string" || typeof e.hint !== "string") throw new Error(`error shape: ${JSON.stringify(res.body)}`);
  return e as { code: string; message: string; hint: string; details?: any };
}

export const mins = (i: any) => (ms(i.end) - ms(i.start)) / 60_000;
export const at = (date: string, hhmm: string) => ms(`${date}T${hhmm}:00+01:00`);
export const nextDate = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Timeline invariants every stored day must satisfy. */
export function checkDay(day: any, timeZone = TZ) {
  const items = day.items;
  const dayStart = zonedMs(day.date, 8 * 60, timeZone);
  const midnight = zonedMs(nextDate(day.date), 0, timeZone);
  for (let k = 1; k < items.length; k++) expect(ms(items[k].start), `${items[k - 1].key} overlaps ${items[k].key}`).toBeGreaterThanOrEqual(ms(items[k - 1].end));
  for (const i of [...items, ...day.checked]) {
    expect(i.date).toBe(day.date);
    expect(ms(i.start), `${i.key} starts before 08:00`).toBeGreaterThanOrEqual(dayStart);
    expect(ms(i.start), `${i.key} starts after midnight`).toBeLessThan(midnight);
  }
  for (const c of day.checked) {
    expect(c.kind).toBe("task");
    expect(c.status, `pending item ${c.key} off the timeline`).not.toBe("pending");
  }
  expect(items.filter((i: any) => i.kind === "task").reduce((n: number, i: any) => n + mins(i), 0)).toBeLessThanOrEqual(480);
  const rests = items.filter((i: any) => i.kind === "rest");
  expect(rests.map((r: any) => r.key)).toEqual(rests.map((_: any, n: number) => `${day.date}|rest|${n + 1}`));
  for (let k = 1; k < items.length; k++) expect(items[k - 1].kind === "rest" && items[k].kind === "rest", `two rests in a row at ${items[k].key}`).toBe(false);
  // Rest lengths follow the block marks: a long rest exactly after each 240 task minutes.
  let taskMin = 0;
  for (const i of items) {
    if (i.kind === "task") taskMin += mins(i);
    else if (i.restKind === "long") expect(taskMin % 240, `long rest ${i.key} after ${taskMin} task min`).toBe(0);
  }
}

