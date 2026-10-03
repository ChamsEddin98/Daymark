import { expect, test, type Page } from "@playwright/test";
import { key, MOCK, openToday, resetMock, row, T } from "./helpers";

/** The now panel (or the empty-state card that replaces it) must never be scrolled out of view. */
async function panelBox(page: Page) {
  const panel = page
    .getByTestId("state-now")
    .or(page.getByTestId("state-done"))
    .or(page.getByTestId("state-before"))
    .or(page.getByTestId("state-after"))
    .first();
  await expect(panel).toBeVisible();
  return (await panel.boundingBox())!;
}

test.describe("390 px: the now panel stays on screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  for (const [name, now, scenario] of [
    ["during the long rest (13:10)", "13:10", "auto"],
    ["late in the day with missed work (16:00)", "16:00", "missed"],
    ["all done", "18:40", "alldone"],
  ] as const) {
    test(name, async ({ page, request }) => {
      await resetMock(request, { now: T(now), scenario });
      await openToday(page);
      await page.waitForTimeout(600); // let the initial scroll settle
      const b = await panelBox(page);
      expect(b.y, `panel top ${b.y}`).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height).toBeLessThanOrEqual(844);
      // and it still says what comes next
      const text = (await page.getByTestId("state-now").or(page.getByTestId("state-done")).first().textContent())!;
      expect(text.length).toBeGreaterThan(10);
    });
  }

  test("the panel survives scrolling to the bottom of the timeline", async ({ page, request }) => {
    await resetMock(request, { now: T("13:10") });
    await openToday(page);
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(400);
    const b = await panelBox(page);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.y + b.height).toBeLessThanOrEqual(844);
  });

  test("during the long rest the panel names the boundary and the band shows the time left", async ({
    page,
    request,
  }) => {
    await resetMock(request, { now: T("13:10") });
    await openToday(page);
    await expect(page.getByTestId("boundary")).toHaveText(/^Back to work in (50|49) min$/);
    await expect(page.getByTestId("long-rest")).toContainText(/(50|49)m left/);
  });

  test("at 16:00 the missed banner is on the first screen", async ({ page, request }) => {
    await resetMock(request, { now: T("16:00"), scenario: "missed" });
    await openToday(page);
    await page.waitForTimeout(600);
    const banner = page.getByTestId("missed-banner");
    await expect(banner).toBeVisible();
    const b = (await banner.boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.y + b.height).toBeLessThanOrEqual(844);
  });
});

test("a days shift keeps 'Tomorrow starts with …' in the now panel, not just the toast", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  await page.keyboard.press("s");
  await expect(page.getByTestId("preview-1d")).toContainText("Sep");
  await page.keyboard.press("4");
  const line = page.getByTestId("upcoming-line");
  await expect(line).toBeVisible();
  await expect(line).toContainText("Nothing else starts today.");
  await expect(line).toContainText(/Tomorrow starts with .+ at \d\d:\d\d\./);
});

test("+1 and +2 days are told apart by the date they land on", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  await page.getByTestId("shift-trigger").click();
  await expect(page.getByTestId("preview-1d")).toContainText("Tue 29 Sep");
  await page.getByTestId("shift-unit").selectOption("days");
  await page.getByTestId("shift-amount").fill("2");
  await expect(page.getByTestId("preview-custom")).toContainText("Wed 30 Sep");
});

test("dropped daily sessions are named, in the preview and the toast", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  await page.getByTestId("shift-trigger").click();
  await page.getByTestId("shift-unit").selectOption("hours");
  await page.getByTestId("shift-amount").fill("12");
  const warning = page.getByTestId("preview-custom-warning");
  await expect(warning).toContainText("2 daily sessions dropped: AI engineering lessons and Portfolio project");
  await page.getByTestId("shift-amount").press("Enter");
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Shifted by 12 h" })).toContainText(
    "AI engineering lessons and Portfolio project",
  );
});

test("a task is 'unchecked' during its own rest and 'missed' once the next task starts", async ({ page, request }) => {
  // 10:52 is inside A10's trailing rest (10:50–11:00); A11 starts at 11:00.
  await resetMock(request, { now: T("10:52"), scenario: "fresh" });
  await openToday(page);
  const a10 = row(page, key("bcg/A10"));
  await expect(a10).toHaveAttribute("data-late", "unchecked");
  await expect(a10.getByTestId("missed-tag")).toHaveText("Unchecked");
  await expect(a10).not.toHaveAttribute("data-missed", "true");

  await resetMock(request, { now: T("11:05"), scenario: "fresh" });
  await page.reload();
  await expect(row(page, key("bcg/A10"))).toHaveAttribute("data-late", "missed");
  await expect(row(page, key("bcg/A10")).getByTestId("missed-tag")).toHaveText("Missed");
});

test("the side column never contradicts the now panel", async ({ page, request }) => {
  await resetMock(request, { now: T("18:40"), scenario: "alldone" });
  await openToday(page);
  const aside = page.getByTestId("day-aside");
  await expect(page.getByTestId("state-done")).toBeVisible();
  await expect(aside).not.toContainText(/Rest in|Day ends in|Back to work/);
  await expect(aside).toContainText("nothing left");

  // with missed work, "no work left" would be wrong: it says how much is still open
  await resetMock(request, { now: T("16:00"), scenario: "missed" });
  await page.reload();
  await expect(page.getByTestId("day-aside")).toContainText("1 open from earlier");
});

test("desktop chrome states each fact once", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  // innerText, not textContent: responsive copy stays in the DOM and must not be counted when hidden.
  const body = await page.evaluate(() => document.body.innerText);
  expect(body.match(/of work left/g) ?? []).toHaveLength(0); // the aside card owns minutes left
  expect(body.match(/to go/g) ?? []).toHaveLength(1);
  expect(body.match(/Rest in \d+ min/g) ?? []).toHaveLength(1);
  expect(body.match(/ends 18:30/g) ?? []).toHaveLength(1);
});

test("a superseded change drops its older toast", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  await page.keyboard.press("j");
  const focused = row(page, key("bcg/A10"));
  await page.keyboard.press("d"); // skipped
  await expect(focused).toHaveAttribute("data-status", "skipped");
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Skipped" })).toBeVisible();
  await page.keyboard.press("d"); // back to pending
  await expect(focused).toHaveAttribute("data-status", "pending");
  await page.keyboard.press("x"); // done
  await expect(focused).toHaveAttribute("data-status", "done");
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Completed" })).toBeVisible();
  // Every superseded toast for this item is gone; only the newest one is left standing.
  const live = page.locator('[data-sonner-toast][data-removed="false"]');
  await expect(live.filter({ hasText: "Skipped" })).toHaveCount(0);
  await expect(live.filter({ hasText: "Marked not done" })).toHaveCount(0);
  await expect(live.filter({ hasText: "Completed" })).toHaveCount(1);
});

test("a dropped live stream shows a retry bar; API errors are plain English", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  await expect(page.getByTestId("live-bar")).toHaveCount(0);
  // kill only the SSE stream: /today keeps answering
  await page.route(`${MOCK}/events*`, (r) => r.abort("connectionrefused"));
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await page.reload();
  await expect(page.getByTestId("live-bar")).toBeVisible();
  await expect(page.getByTestId("live-bar")).toContainText("Disconnected — retrying");
  await expect(page.getByTestId("timeline")).toBeVisible();

  await page.route(`${MOCK}/**`, (r) => r.abort("connectionrefused"));
  await page.reload();
  const down = page.getByTestId("state-down");
  await expect(down).toBeVisible();
  await expect(down).toContainText("No response from the API — it looks stopped.");
  await expect(down).not.toContainText("Failed to fetch");
});

test("the API-down commands carry the port when it is not the default", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await page.route(`${MOCK}/**`, (r) => r.abort("connectionrefused"));
  await page.goto("/");
  const down = page.getByTestId("state-down");
  await expect(down).toBeVisible();
  // the test API runs on 4318, not 4317
  await expect(down.getByTestId("start-command")).toHaveText("PLANNER_API_PORT=4318 npm start");
  await expect(down).toContainText("PLANNER_API_PORT=4318 npm run api");
  await expect(down.getByTestId("port-note")).toContainText("expects the API on port 4318");
});
