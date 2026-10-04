import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { MOCK, openToday, resetMock, T } from "./helpers";

/**
 * Active hours in the daily view: the owner's working window.
 *
 * The scheduling itself is proved in the core and API suites. What matters here is the one thing the
 * numbers do not say on their own — that the clock cost of work is stepped, so a window can quietly
 * grant less than was asked for — and that the panel says so instead of echoing the request back.
 */

const trigger = (page: Page) => page.getByTestId("settings-trigger");
const panel = (page: Page) => page.getByTestId("settings-popover");
const start = (page: Page) => page.getByTestId("settings-start");
const end = (page: Page) => page.getByTestId("settings-end");
const hours = (page: Page) => page.getByTestId("settings-hours");
const save = (page: Page) => page.getByTestId("settings-save");

const setHours = (request: APIRequestContext, activeHours: object, effective?: object) =>
  request.post(`${MOCK}/__mock/settings`, { data: { activeHours, ...(effective ? { effective } : {}) } });

async function open(page: Page) {
  await trigger(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(start(page)).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await resetMock(request, { now: T("10:20") });
  // The mock keeps the hours across resets, so each test states the ones it needs.
  await setHours(request, { dayStart: "08:00", dayEnd: "24:00", dailyTaskMin: 480, onMissed: "reflow" });
});

test("the panel opens from the header and shows the current hours", async ({ page }) => {
  await openToday(page);
  await expect(trigger(page)).toHaveAccessibleName("Working hours");
  await open(page);

  await expect(start(page)).toHaveValue("08:00");
  await expect(end(page)).toHaveValue("24:00");
  await expect(hours(page)).toHaveValue("8");
  // Save is inert until something changes, so the panel cannot be used to "confirm" a no-op.
  await expect(save(page)).toBeDisabled();
  await expect(page.getByTestId("settings-effective")).toContainText("Days hold");
});

test("changing the hours saves, re-plans, and reports the real outcome", async ({ page, request }) => {
  await openToday(page);
  await open(page);

  await start(page).fill("10:00");
  await expect(save(page)).toBeEnabled();
  // Before saving, the panel says what will be applied rather than what is current.
  await expect(page.getByTestId("settings-effective")).toContainText("10:00");
  await save(page).click();

  await expect(panel(page)).toBeHidden();
  await expect(page.getByText("Working hours saved")).toBeVisible();
  const after = await (await request.get(`${MOCK}/settings`)).json();
  expect(after.activeHours.dayStart).toBe("10:00");

  // Re-opening shows the saved value, read back from the server.
  await open(page);
  await expect(start(page)).toHaveValue("10:00");
});

test("a window that cannot hold the budget says so, and names the fix", async ({ page, request }) => {
  // 10 h of work inside 08:00-20:00: the window grants 8, because crossing 8 h buys a second
  // hour-long rest. This is the case a UI could most easily misreport.
  await setHours(request, { dayStart: "08:00", dayEnd: "20:00", dailyTaskMin: 600 });
  await openToday(page);
  await open(page);

  const warning = page.getByTestId("settings-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("does not fit before 20:00");
  // It explains the mechanism and what to do, not just that something is wrong.
  await expect(warning).toContainText("adds an hour of rest");
  await expect(page.getByTestId("settings-effective")).toContainText("Days hold");
  // And the figure shown is the granted one, not the request.
  await expect(page.getByTestId("settings-effective")).not.toContainText("10h");
});

test("no warning when the window has room for the budget", async ({ page, request }) => {
  await setHours(request, { dayStart: "08:00", dayEnd: "24:00", dailyTaskMin: 480 });
  await openToday(page);
  await open(page);
  await expect(page.getByTestId("settings-warning")).toHaveCount(0);
  await expect(page.getByTestId("settings-effective")).toContainText("Days hold 8h");
});

test("the missed-work choice is a decision, not a toggle, and it saves", async ({ page, request }) => {
  await openToday(page);
  await open(page);
  // Both answers are offered with what they mean; neither is "off".
  await expect(page.getByTestId("settings-missed-reflow")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("settings-missed-reflow")).toContainText("Re-time my day");
  await expect(page.getByTestId("settings-missed-notify")).toContainText("Just tell me");
  await expect(page.getByTestId("settings-missed-notify")).toContainText(/skip|roll over/i);

  await page.getByTestId("settings-missed-notify").click();
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(page.getByText("Working hours saved")).toBeVisible();
  expect((await (await request.get(`${MOCK}/settings`)).json()).activeHours.onMissed).toBe("notify");

  await open(page);
  await expect(page.getByTestId("settings-missed-notify")).toHaveAttribute("data-active", "true");
});

test("a window preset leaves the missed-work choice alone", async ({ page, request }) => {
  await setHours(request, { dayStart: "08:00", dayEnd: "24:00", dailyTaskMin: 480, onMissed: "notify" });
  await openToday(page);
  await open(page);
  await page.getByTestId("settings-preset-evenings").click();
  // The preset is about the window; it must not quietly re-enable re-timing.
  await expect(page.getByTestId("settings-missed-notify")).toHaveAttribute("data-active", "true");
});

test("a preset fills all three fields in one click", async ({ page }) => {
  await openToday(page);
  await open(page);
  await page.getByTestId("settings-preset-evenings").click();
  await expect(start(page)).toHaveValue("18:00");
  await expect(end(page)).toHaveValue("23:00");
  await expect(hours(page)).toHaveValue("4");
  await expect(save(page)).toBeEnabled();
  // The preset matching the current setting is marked, so the panel shows where you are.
  await page.getByTestId("settings-preset-default").click();
  await expect(page.getByTestId("settings-preset-default")).toHaveAttribute("data-active", "true");
  await expect(save(page)).toBeDisabled();
});

test("an impossible window is refused in the panel, before any request", async ({ page, request }) => {
  await openToday(page);
  await open(page);

  for (const [label, s, e, expected] of [
    ["the end before the start", "18:00", "09:00", /end after it starts/i],
    ["the end equal to the start", "09:00", "09:00", /end after it starts/i],
    ["a five-minute window", "08:00", "08:05", /less than 15 minutes/i],
    ["a time that is not a time", "08:00", "nope", /time like 20:00/i],
  ] as [string, string, string, RegExp][]) {
    await start(page).fill(s);
    await end(page).fill(e);
    await expect(page.getByTestId("settings-error"), label).toContainText(expected);
    await expect(save(page), label).toBeDisabled();
  }
  // Nothing reached the server.
  const after = await (await request.get(`${MOCK}/settings`)).json();
  expect(after.activeHours).toMatchObject({ dayStart: "08:00", dayEnd: "24:00", dailyTaskMin: 480 });
});

test("a budget outside the allowed range is refused too", async ({ page }) => {
  await openToday(page);
  await open(page);
  for (const [value, expected] of [
    ["0", /more than zero/i],
    ["25", /more than 24/i],
  ] as [string, RegExp][]) {
    await hours(page).fill(value);
    await expect(page.getByTestId("settings-error")).toContainText(expected);
    await expect(save(page)).toBeDisabled();
  }
});

test("a server refusal is shown as a toast, and the panel stays open", async ({ page }) => {
  await openToday(page);
  await open(page);
  // The panel's own check passes; the server refuses. (It rejects a wrapping window by name.)
  await page.route("**/settings", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INVALID_INPUT", message: "dayEnd (02:00) must be after dayStart (22:00)", hint: "Nothing was changed." } }),
    });
  });
  await hours(page).fill("6");
  await save(page).click();
  await expect(page.getByText("Could not save the hours")).toBeVisible();
  await expect(panel(page)).toBeVisible();
});

test("Cancel closes without saving", async ({ page, request }) => {
  await openToday(page);
  await open(page);
  await hours(page).fill("12");
  await page.getByTestId("settings-cancel").click();
  await expect(panel(page)).toBeHidden();
  const after = await (await request.get(`${MOCK}/settings`)).json();
  expect(after.activeHours.dailyTaskMin).toBe(480);
});

test("the panel owns the keyboard while it is open", async ({ page }) => {
  await openToday(page);
  await open(page);
  // `s` is the shift shortcut on the page; inside the panel it has to type, not open Shift.
  await hours(page).press("s");
  await expect(page.getByTestId("shift-popover")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
});

test("the panel is accessible", async ({ page }) => {
  await openToday(page);
  await open(page);
  const r = await new AxeBuilder({ page }).include("[data-testid=settings-popover]").analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  // Every field is labelled, which is what makes the panel usable without sight.
  for (const id of ["settings-start", "settings-end", "settings-hours"])
    await expect(page.getByTestId(id)).toHaveAccessibleName(/./);
});

test("the panel works at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openToday(page);
  await open(page);
  const box = (await panel(page).boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(390 - 16);
  expect(box.x).toBeGreaterThanOrEqual(0);
  // The touch targets stay reachable.
  for (const el of [start(page), end(page), hours(page), save(page)]) {
    const b = (await el.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(32);
  }
});
