import { expect, test } from "@playwright/test";
import { key, MOCK, mockState, openToday, resetMock, row, T } from "./helpers";

test.beforeEach(async ({ context }) => {
  await context.route(/https:\/\/(leetcode\.com|www\.hackerrank\.com)\/.*/, (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: "ok" }),
  );
});

test("Tab reaches a checkbox and it shows a visible focus ring", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  let role: string | null = null;
  for (let i = 0; i < 12 && role !== "checkbox"; i++) {
    await page.keyboard.press("Tab");
    role = await page.evaluate(() => document.activeElement?.getAttribute("role") ?? null);
  }
  expect(role).toBe("checkbox");
  const style = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement!);
    return { outlineStyle: cs.outlineStyle, outlineWidth: parseFloat(cs.outlineWidth), boxShadow: cs.boxShadow };
  });
  const visible = (style.outlineStyle !== "none" && style.outlineWidth >= 2) || style.boxShadow !== "none";
  expect(visible, JSON.stringify(style)).toBe(true);
  expect(style.outlineStyle).toBe("solid");
});

test("+1 day: popover and toast report the same numbers; checked items move to 'Done earlier'", async ({
  page,
  request,
}) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  // A12 is done ahead of its slot; the day shift takes it off the timeline.
  await row(page, key("bcg/A12")).getByTestId("check").click();
  await expect.poll(async () => (await mockState(request))[key("bcg/A12")]).toBe("done");

  await page.keyboard.press("s");
  const preview = page.getByTestId("preview-1d");
  await expect(preview).toHaveText(/^Tue 29 Sep · \d+ of today's tasks? move$/);
  const detail = page.getByTestId("preview-1d-detail");
  await expect(detail).toHaveText(/^\d+ items in all · today ends 10:50$/);
  const n = (await detail.textContent())!.match(/(\d+) items/)![1];
  const api = await (await request.post(`${MOCK}/plan/shift/preview`, { data: { amount: 1, unit: "days" } })).json();
  expect(Number(n)).toBe(api.moved);

  await page.getByTestId("shift-1d").click();
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Shifted by 1 day" });
  await expect(toast).toContainText(`${n} items in all`);
  await expect(toast).toContainText("Tuesday 29 September starts with A11 · GroupBy → filter at 11:00.");

  const done = page.getByTestId("done-earlier");
  await expect(done).toBeVisible();
  await expect(done.getByTestId("checked-row")).toHaveCount(1);
  await expect(done).toContainText("A12 · Ranking");
  await expect(done).toContainText("11:50–12:30");

  // header count comes from the API's progress (timeline + checked)
  const today = await (await request.get(`${MOCK}/today`)).json();
  await expect(page.getByTestId("count")).toHaveText(`${today.progress.done}/${today.progress.total}`);
  expect(today.progress.total).toBe(5);
});

test("minute/hour shifts warn about dropped daily sessions, in the preview and the toast", async ({ page }) => {
  await openTodayAt(page, "10:20");
  await page.getByTestId("shift-trigger").click();
  await page.getByTestId("shift-unit").selectOption("hours");
  await page.getByTestId("shift-amount").fill("12");
  await expect(page.getByTestId("preview-custom-warning")).toHaveText(/2 daily sessions dropped/);
  const warning = (await page.getByTestId("preview-custom-warning").textContent())!;
  await page.getByTestId("shift-amount").press("Enter");
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Shifted by 12 h" });
  await expect(toast).toContainText(warning.trim());
});

test("missed tasks are marked, counted in the now panel, and can be skipped or done by keyboard", async ({
  page,
  request,
}) => {
  await resetMock(request, { now: T("10:20"), scenario: "missed" });
  await openToday(page);
  const a9 = row(page, key("bcg/A9"));
  await expect(a9).toHaveAttribute("data-missed", "true");
  await expect(a9.getByTestId("missed-tag")).toBeVisible();
  await expect(a9).toHaveAttribute("data-late", "missed");
  await expect(row(page, key("bcg/A11"))).not.toHaveAttribute("data-missed", "true");
  const banner = page.getByTestId("missed-banner");
  await expect(banner).toContainText("1 earlier task unchecked");

  await banner.getByRole("button", { name: "Review" }).click();
  expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe(key("bcg/A9"));
  await page.keyboard.press("d");
  await expect(a9).toHaveAttribute("data-status", "skipped");
  await expect.poll(async () => (await mockState(request))[key("bcg/A9")]).toBe("skipped");
  await expect(page.getByTestId("missed-banner")).toHaveCount(0);

  await page.keyboard.press("u");
  await expect(a9).toHaveAttribute("data-status", "pending");
  await page.keyboard.press("x");
  await expect(a9).toHaveAttribute("data-status", "done");
  await expect.poll(async () => (await mockState(request))[key("bcg/A9")]).toBe("done");
});

test("the Skip button on a missed row works by mouse", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20"), scenario: "missed" });
  await openToday(page);
  await row(page, key("bcg/A9")).getByTestId("skip").click();
  await expect(row(page, key("bcg/A9"))).toHaveAttribute("data-status", "skipped");
});

test("o on a task without a link says so", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  await page.keyboard.press("j");
  for (let i = 0; i < 12; i++) await page.keyboard.press("j"); // to the last rows (lessons, portfolio)
  expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.key)).toBe(key("portfolio/DAILY"));
  await page.keyboard.press("o");
  await expect(page.getByText("No link for this task")).toBeVisible();
});

test("a stretched long rest shows its real length, not '4 h' copy", async ({ page, request }) => {
  await resetMock(request, { now: T("12:50") });
  await openToday(page);
  await page.getByTestId("shift-trigger").click();
  await page.getByTestId("shift-15m").click();
  const band = page.getByTestId("long-rest");
  await expect(band).toContainText("13:00–14:15");
  await expect(band).toContainText("1 h 15 min");
  await expect(band).not.toContainText("After 4 h");
});

test("wide screens get a side column with progress, countdown and tracks", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  const aside = page.getByTestId("day-aside");
  await expect(aside).toBeVisible();
  await expect(aside.getByTestId("aside-count")).toHaveText((await page.getByTestId("count").textContent())!);
  // The next boundary lives in the now panel only: the aside must not repeat it.
  await expect(aside).toContainText("to go");
  await expect(aside.getByTestId("aside-countdown")).toHaveCount(0);
  await expect(aside.getByTestId("aside-tracks")).toContainText("BCG");
  const box = await aside.boundingBox();
  const main = await page.getByTestId("timeline").boundingBox();
  expect(box!.x).toBeGreaterThan(main!.x + main!.width);
});

test.describe("390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("the toast's Undo is at least 40×40", async ({ page, request }) => {
    await resetMock(request, { now: T("10:20") });
    await openToday(page);
    await row(page, key("bcg/A11")).getByTestId("check").tap();
    const undo = page.getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();
    const b = (await undo.boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(40);
    expect(b.width).toBeGreaterThanOrEqual(40);
  });

  test("the now panel shows the whole title and the next start time", async ({ page, request }) => {
    await resetMock(request, { now: T("10:20") });
    await openToday(page);
    const title = page.getByTestId("now-title");
    const clipped = await title.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    expect(clipped).toBe(false);
    await expect(page.getByTestId("state-now")).toContainText("then A11 · GroupBy → filter at 11:00");
  });
});

async function openTodayAt(page: import("@playwright/test").Page, hhmm: string) {
  await page.request.post(`${MOCK}/__mock/reset`, { data: { now: T(hhmm), latencyMs: 0 } });
  await openToday(page);
}
