import { expect, test, type Page } from "@playwright/test";
import { key, mockState, openToday, resetMock, row, T } from "./helpers";

const focusedKey = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.key ?? null);

test.beforeEach(async ({ request, context }) => {
  await resetMock(request, { now: T("10:20") });
  // never hit the real platforms from tests
  await context.route(/https:\/\/(leetcode\.com|www\.hackerrank\.com)\/.*/, (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: "<title>platform</title>ok" }),
  );
});

test("keyboard only: j/k move with a visible focus ring, x completes, o opens the link, u undoes", async ({
  page,
  request,
}) => {
  await openToday(page);
  await page.keyboard.press("j"); // lands on the current task
  expect(await focusedKey(page)).toBe(key("bcg/A10"));
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement!).boxShadow);
  expect(ring).not.toBe("none");

  await page.keyboard.press("j");
  expect(await focusedKey(page)).toBe(key("bcg/A11"));
  await page.keyboard.press("ArrowDown");
  expect(await focusedKey(page)).toBe(key("bcg/A12"));
  await page.keyboard.press("k");
  await page.keyboard.press("ArrowUp");
  expect(await focusedKey(page)).toBe(key("bcg/A10"));

  await page.keyboard.press("x");
  await expect(row(page, key("bcg/A10")).getByTestId("check")).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => (await mockState(request))[key("bcg/A10")]).toBe("done");
  await page.keyboard.press("u");
  await expect(row(page, key("bcg/A10")).getByTestId("check")).toHaveAttribute("aria-checked", "false");

  await page.keyboard.press(" ");
  await expect(row(page, key("bcg/A10")).getByTestId("check")).toHaveAttribute("aria-checked", "true");

  const [popup] = await Promise.all([page.waitForEvent("popup"), page.keyboard.press("o")]);
  expect(popup.url()).toBe("https://leetcode.com/problems/department-highest-salary/");
  await popup.close();

  // ? opens help, Esc closes it
  await page.keyboard.press("?");
  await expect(page.getByTestId("help-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("help-dialog")).toBeHidden();
});

test("keyboard only: s opens shift with previews, a digit confirms", async ({ page, request }) => {
  await openToday(page);
  await expect(page.getByTestId("summary")).toContainText("ends 18:30");
  await page.keyboard.press("s");
  await expect(page.getByTestId("shift-popover")).toBeVisible();
  await expect(page.getByTestId("preview-30m")).toHaveText(/Ends 19:00/);
  await expect(page.getByTestId("shift-15m")).toBeFocused();
  await page.keyboard.press("2");
  await expect(page.getByTestId("shift-popover")).toBeHidden();
  await expect(page.getByText("Shifted by 30 min")).toBeVisible();
  await expect(page.getByTestId("summary")).toContainText("ends 19:00");
  const today = await (await request.get("http://127.0.0.1:4318/today")).json();
  expect(today.day.items.at(-1).end).toBe(T("19:00"));
});

test("mouse: shift is two clicks and shows the new end of day before confirming", async ({ page }) => {
  await openToday(page);
  await page.getByTestId("shift-trigger").click(); // 1
  await expect(page.getByTestId("preview-1h")).toHaveText(/Ends 19:30/);
  await expect(page.getByTestId("preview-15m")).toHaveText(/Ends 18:45/);
  await expect(page.getByTestId("preview-1d")).toHaveText(/^Tue 29 Sep · \d+ of today's tasks? move$/);
  await page.getByTestId("shift-1h").click(); // 2
  await expect(page.getByTestId("summary")).toContainText("ends 19:30");
  // the current item keeps its times; the next one moved
  await expect(row(page, key("bcg/A10"))).toContainText("10:10–10:50");
  await expect(row(page, key("bcg/A11"))).toContainText("12:00–12:40");
});

test("custom shift previews as you type and confirms with Enter", async ({ page }) => {
  await openToday(page);
  await page.getByTestId("shift-trigger").click();
  await page.getByTestId("shift-amount").fill("20");
  await expect(page.getByTestId("preview-custom")).toHaveText(/Ends 18:50/);
  await page.getByTestId("shift-unit").selectOption("hours");
  await page.getByTestId("shift-amount").fill("2");
  await expect(page.getByTestId("preview-custom")).toHaveText(/Ends 20:30/);
  await page.getByTestId("shift-amount").press("Enter");
  await expect(page.getByTestId("summary")).toContainText("ends 20:30");
});
