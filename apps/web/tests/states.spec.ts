import { expect, test } from "@playwright/test";
import { openToday, resetMock, T } from "./helpers";

test("mid-task: current item highlighted with time left and the next boundary named", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  const now = page.getByTestId("state-now");
  await expect(now.getByTestId("now-title")).toHaveText("A10 · GroupBy → transform");
  await expect(now.getByTestId("now-left")).toHaveText(/^(30|29) min left$/);
  await expect(now.getByTestId("boundary")).toHaveText(/^Rest in (30|29) min$/);
  const cur = page.locator("[data-testid=task-row][data-current]");
  await expect(cur).toHaveCount(1);
  await expect(cur).toContainText("left");
  // timeline structure: 11 tasks, 9 short rests, 1 long rest, split task around it
  await expect(page.getByTestId("task-row")).toHaveCount(11);
  await expect(page.getByTestId("rest-row")).toHaveCount(9);
  await expect(page.getByTestId("long-rest")).toHaveCount(1);
  await expect(page.getByText("10 min rest").first()).toBeVisible();
  await expect(page.getByTestId("timeline")).toContainText("A13 · shift, lag and diff (part 1/2)");
  await expect(page.getByTestId("timeline")).toContainText("A13 · shift, lag and diff (part 2/2)");
});

test("density: at least 9 task rows fully visible at 1440×900", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  const visible = await page.getByTestId("task-row").evaluateAll((els) =>
    els.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    }).length,
  );
  console.log(`[density] ${visible} task rows fully visible at 1440x900`);
  expect(visible).toBeGreaterThanOrEqual(9);
});

test("link chip is one click and opens a new tab", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  const chip = page.getByTestId("link-chip").first();
  await expect(chip).toHaveAttribute("target", "_blank");
  await expect(chip).toHaveAttribute("href", "https://leetcode.com/problems/not-boring-movies/");
  await expect(chip).toHaveAttribute("rel", /noopener/);
});

test("during the long rest: band highlighted, back-to-work boundary", async ({ page, request }) => {
  await resetMock(request, { now: T("13:25") });
  await openToday(page);
  await expect(page.getByTestId("long-rest")).toHaveAttribute("data-current", "true");
  await expect(page.getByTestId("boundary")).toHaveText(/^Back to work in 3[45] min$/);
  await expect(page.getByTestId("now-title")).toHaveText("Next: A13 · shift, lag and diff (part 2/2)");
});

test("before 08:00 names what the day starts with", async ({ page, request }) => {
  await resetMock(request, { now: T("07:30"), scenario: "fresh" });
  await openToday(page);
  const s = page.getByTestId("state-before");
  await expect(s).toContainText("Day starts at 08:00 with A7 · Sorting (part 2/2)");
  await expect(s.getByTestId("boundary")).toHaveText(/^Starts in (30|29) min · /);
});

test("all done names what tomorrow starts with", async ({ page, request }) => {
  await resetMock(request, { now: T("18:40"), scenario: "alldone" });
  await openToday(page);
  const s = page.getByTestId("state-done");
  await expect(s).toContainText("Done for today");
  await expect(s).toContainText("Tomorrow starts with A15 · Join types at 08:00.");
});

test("API down: clear message, the start command, auto-retry, recovery", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  let down = true;
  await page.route("http://127.0.0.1:4318/**", (r) => (down ? r.abort("connectionrefused") : r.continue()));
  await page.goto("/");
  const s = page.getByTestId("state-down");
  await expect(s).toBeVisible();
  await expect(s).toContainText("The planner API isn't running");
  await expect(s.getByTestId("start-command")).toHaveText("PLANNER_API_PORT=4318 npm start");
  await expect(s).toContainText(/Retrying automatically in \d s/);
  down = false;
  await s.getByRole("button", { name: "Retry now" }).click();
  await expect(page.getByTestId("timeline")).toBeVisible();
  await expect(page.getByTestId("state-down")).toHaveCount(0);
});

test("loading skeleton while /today is in flight, then no layout shift (CLS < 0.02)", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await page.addInitScript(() => {
    (window as any).__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) if (!e.hadRecentInput) (window as any).__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.route("http://127.0.0.1:4318/today*", async (r) => {
    await new Promise((res) => setTimeout(res, 800));
    await r.continue();
  });
  await page.goto("/");
  await expect(page.getByTestId("skeleton")).toBeVisible();
  await expect(page.getByTestId("timeline")).toBeVisible();
  await page.getByTestId("task-row").nth(4).getByTestId("check").click();
  await page.waitForTimeout(600);
  const cls = await page.evaluate(() => (window as any).__cls as number);
  console.log(`[cls] ${cls.toFixed(4)}`);
  expect(cls).toBeLessThan(0.02);
});
