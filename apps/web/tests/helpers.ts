import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const MOCK = "http://127.0.0.1:4318";
export const DAY = "2026-09-28";
export const T = (hhmm: string) => `${DAY}T${hhmm}:00+01:00`;
export const key = (uid: string, part = 1) => `${DAY}|${uid}|${part}`;

export async function resetMock(
  request: APIRequestContext,
  opts: { now: string; scenario?: "auto" | "missed" | "fresh" | "alldone"; latencyMs?: number; failNext?: number },
) {
  const r = await request.post(`${MOCK}/__mock/reset`, { data: { latencyMs: 0, ...opts } });
  expect(r.ok()).toBeTruthy();
}

/** Backdates a pause so a resume reports a known duration (mock-only control). */
export async function pauseMock(request: APIRequestContext, agoMs = 0) {
  const r = await request.post(`${MOCK}/__mock/pause`, { data: { agoMs } });
  expect(r.ok()).toBeTruthy();
}

/** "1:12" -> 72 */
export const clockSec = (text: string) =>
  text
    .trim()
    .split(":")
    .map(Number)
    .reduce((a, n) => a * 60 + n, 0);

export async function mockState(request: APIRequestContext): Promise<Record<string, string>> {
  const r = await request.get(`${MOCK}/__mock/state`);
  return (await r.json()).statuses;
}

export async function openToday(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("timeline")).toBeVisible();
}

export const row = (page: Page, k: string) => page.locator(`[data-testid=task-row][data-key="${k}"]`);
