import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { clockSec, DAY, key, MOCK, openToday, pauseMock, resetMock, row, T } from "./helpers";

/** P8 · Pause and Resume. The plan freezes while paused; resuming moves everything by the pause. */

const A10 = key("bcg/A10"); // 10:10–10:50, so it is the current item at 10:20

const pauseBtn = (page: Page) => page.getByTestId("pause-toggle");
const elapsed = (page: Page) => page.getByTestId("pause-elapsed");

async function transforms(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-testid=now-progress], [data-testid=row-progress]")).map(
      (el) => getComputedStyle(el).transform,
    ),
  );
}

test("pause: the button becomes Resume and a live counter runs", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);

  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Pause");
  await expect(pauseBtn(page)).toHaveAccessibleName("Pause the schedule");
  await expect(elapsed(page)).toHaveCount(1); // present but hidden, so the box is already sized

  await pauseBtn(page).click();
  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Resume");
  await expect(pauseBtn(page)).toHaveAccessibleName("Resume the schedule");
  await expect(pauseBtn(page)).toHaveAttribute("data-paused", "true");

  const first = clockSec((await elapsed(page).textContent())!);
  expect(first).toBeLessThan(3);
  await expect
    .poll(async () => clockSec((await elapsed(page).textContent())!), { timeout: 8000 })
    .toBeGreaterThanOrEqual(first + 2);
  // and the counter uses the same tabular numerals as the rest of the UI
  expect(await elapsed(page).evaluate((el) => getComputedStyle(el).fontVariantNumeric)).toContain("tabular-nums");
});

test("the timeline reads as frozen, says why, and the current progress bar stops", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);

  // Sanity: unpaused, the progress bars do advance.
  const running0 = await transforms(page);
  expect(running0.length).toBeGreaterThanOrEqual(2); // the now panel's bar and the current row's
  await page.waitForTimeout(2600);
  expect(await transforms(page)).not.toEqual(running0);

  await pauseBtn(page).click();
  await expect(page.getByTestId("paused-notice")).toBeVisible();
  await expect(page.getByTestId("timeline")).toHaveAttribute("data-paused", "true");
  await expect(page.getByTestId("state-now")).toHaveAttribute("data-paused", "true");

  // it says since when, with the pause instant's wall clock
  const notice = page.getByTestId("paused-notice");
  await expect(notice).toContainText("Schedule paused");
  await expect(notice).toContainText(/since 10:2\d/);
  await expect(page.getByTestId("paused-for")).toHaveText(/^\d+:\d\d$/);

  // the current row says it too, and its live progress line is marked frozen
  await expect(row(page, A10).getByTestId("paused-tag")).toBeVisible();
  await expect(row(page, A10).getByTestId("row-progress")).toHaveAttribute("data-frozen", "true");
  await expect(page.getByTestId("now-progress")).toHaveAttribute("data-frozen", "true");

  // and it stops advancing
  await page.waitForTimeout(1200); // let the 1 s transition land on the frozen value
  const frozen = await transforms(page);
  const leftText = await page.getByTestId("now-left").textContent();
  await page.waitForTimeout(3200);
  expect(await transforms(page)).toEqual(frozen);
  expect(await page.getByTestId("now-left").textContent()).toBe(leftText);
});

test("shift is disabled — not hidden — while paused, and says to resume first", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  const shift = page.getByTestId("shift-trigger");
  await expect(shift).toBeEnabled();

  await pauseBtn(page).click();
  await expect(pauseBtn(page)).toHaveAttribute("data-paused", "true");
  await expect(shift).toBeVisible();
  await expect(shift).toBeDisabled();

  // the reason is available to assistive tech and as a hover tooltip
  const describedBy = await shift.getAttribute("aria-describedby");
  expect(describedBy).toBe("shift-disabled-why");
  await expect(page.getByTestId("shift-disabled-why")).toContainText(/resume/i);
  const title = await shift.evaluate((el) => el.closest("span")?.getAttribute("title") ?? "");
  expect(title).toMatch(/Resume/);

  // the keyboard route is closed too, with an explanation instead of a silent no-op
  await page.keyboard.press("s");
  await expect(page.getByTestId("shift-popover")).toHaveCount(0);
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Paused — resume first" })).toBeVisible();
});

test("a 409 PAUSED from the API shows a clear toast, not a raw error", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  // The button is disabled while paused, so the only way a 409 PAUSED reaches the UI is a race with
  // another client. Simulate exactly that answer on the commit call.
  await page.route("**/plan/shift", (r) =>
    r.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "PAUSED", message: "The plan is paused, so it cannot be moved", hint: "POST /plan/resume first." },
      }),
    }),
  );
  await page.keyboard.press("s");
  await expect(page.getByTestId("preview-1h")).toHaveText(/Ends/);
  await page.getByTestId("shift-1h").click();
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Shift failed" });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("The schedule is paused. Resume it first");
  expect(await toast.textContent()).not.toMatch(/409|HTTP_/);
});

test("resume: the toast reports the duration and the button returns to Pause", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await pauseMock(request, 45_000); // as if the pause had been running for 45 s
  await openToday(page);
  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Resume");
  await expect(elapsed(page)).toHaveText(/^0:4[5-9]$/);

  const endBefore = (await (await request.get(`${MOCK}/today`)).json()).day.items.at(-1).end;
  await pauseBtn(page).click();

  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Resumed" });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/everything moved 4[5-9] s later/);
  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Pause");
  await expect(page.getByTestId("paused-notice")).toHaveCount(0);
  await expect(page.getByTestId("shift-trigger")).toBeEnabled();

  // the plan really moved, by about the pause and not by a rounded minute
  const endAfter = (await (await request.get(`${MOCK}/today`)).json()).day.items.at(-1).end;
  const moved = (Date.parse(endAfter) - Date.parse(endBefore)) / 1000;
  expect(moved).toBeGreaterThan(44);
  expect(moved).toBeLessThan(75);
  expect(moved % 60).not.toBe(0);
});

test("a pause under 10 s is reported with at most one decimal", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  await pauseBtn(page).click();
  await expect(pauseBtn(page)).toHaveAttribute("data-paused", "true");
  await pauseBtn(page).click();
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Resumed" });
  await expect(toast).toContainText(/everything moved \d(\.\d)? s later/);
});

test("the p key pauses and resumes, and the help dialog lists it", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);

  await page.keyboard.press("p");
  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Resume");
  await expect(page.getByTestId("paused-notice")).toBeVisible();

  await page.keyboard.press("p");
  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Pause");
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Resumed" })).toBeVisible();

  await page.keyboard.press("?");
  const help = page.getByTestId("help-dialog");
  await expect(help).toBeVisible();
  await expect(help).toContainText("Pause / resume the schedule");
  await expect(help.locator("kbd", { hasText: /^p$/ })).toHaveCount(1);
});

test("the Pause button keeps a visible focus ring", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  await pauseBtn(page).focus();
  const style = await pauseBtn(page).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { outlineStyle: cs.outlineStyle, outlineWidth: parseFloat(cs.outlineWidth), boxShadow: cs.boxShadow };
  });
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBeGreaterThanOrEqual(2);

  // and it stays focused and visibly ringed after the label flips
  await page.keyboard.press("Enter");
  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Resume");
  await expect(pauseBtn(page)).toBeFocused();
  const after = await pauseBtn(page).evaluate((el) => parseFloat(getComputedStyle(el).outlineWidth));
  expect(after).toBeGreaterThanOrEqual(2);
});

test("the label change causes no layout shift", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  await page.evaluate(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
        if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
      }
    }).observe({ type: "layout-shift", buffered: false });
  });
  const before = { pause: await pauseBtn(page).boundingBox(), shift: await page.getByTestId("shift-trigger").boundingBox() };

  await pauseBtn(page).click();
  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Resume");
  await page.waitForTimeout(500);
  const after = { pause: await pauseBtn(page).boundingBox(), shift: await page.getByTestId("shift-trigger").boundingBox() };
  expect(after.pause).toEqual(before.pause);
  expect(after.shift).toEqual(before.shift);

  await pauseBtn(page).click();
  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Pause");
  await page.waitForTimeout(500);
  expect(await pauseBtn(page).boundingBox()).toEqual(before.pause);
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  expect(cls, `CLS ${cls}`).toBeLessThan(0.02);
});

test("the paused state arrives over SSE when another client pauses", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Pause");

  // another client (Claude Code, a script, the daemon) pauses through the API
  const r = await request.post(`${MOCK}/plan/pause`);
  expect(r.ok()).toBeTruthy();
  await expect(page.getByTestId("paused-notice")).toBeVisible({ timeout: 8000 });
  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Resume");
  await expect(page.getByTestId("shift-trigger")).toBeDisabled();

  // …and the same for a resume made elsewhere
  const r2 = await request.post(`${MOCK}/plan/resume`);
  expect(r2.ok()).toBeTruthy();
  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Pause", { timeout: 8000 });
  await expect(page.getByTestId("paused-notice")).toHaveCount(0);
});

test("a pause past 24 h stops freezing the plan and points at the way out", async ({ page, request }) => {
  // The API keeps reporting such a pause but stops enforcing it: resume is 400 and shift is allowed
  // again, so the owner is never stuck. The UI has to follow, or it locks the only way out.
  await resetMock(request, { now: T("10:20") });
  await pauseMock(request, 25 * 3_600_000);
  await openToday(page);

  const notice = page.getByTestId("paused-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-stale", "true");
  await expect(page.getByTestId("paused-explainer")).toContainText("shift whole days instead");

  // still paused as far as the button is concerned…
  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Resume");
  // …but the plan is no longer frozen, and Shift is the documented escape
  await expect(page.getByTestId("shift-trigger")).toBeEnabled();
  await expect(page.getByTestId("timeline")).not.toHaveAttribute("data-paused", "true");
  await expect(page.getByTestId("state-now")).not.toHaveAttribute("data-paused", "true");

  // and resuming says why it cannot, with the hint, instead of failing silently
  await pauseBtn(page).click();
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Couldn't resume" });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText(/24 h/);
  await expect(toast).toContainText(/shift whole days/i);
});

test("no toast ever shows a raw API hint with a JSON body in it", async ({ page, request }) => {
  await resetMock(request, { now: T("10:20") });
  await pauseMock(request, 25 * 3_600_000);
  await openToday(page);
  await pauseBtn(page).click();

  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Couldn't resume" });
  await expect(toast).toBeVisible();
  const text = (await toast.textContent())!;
  // the API's own hint carries a request body; the toast must not
  const apiHint = (await (await request.post(`${MOCK}/plan/resume`)).json()).error.hint as string;
  expect(apiHint).toMatch(/[{}"]/); // the fixture really does send one, so this is a live check
  expect(text, text).not.toMatch(/[{}]/);
  expect(text, text).not.toMatch(/"(amount|unit)"/);
  expect(text, text).not.toMatch(/\bunit\b|\bamount\b/);
  // …and it still says the same thing in English
  await expect(toast).toContainText("Shift whole days instead — that clears the pause");
  await expect(toast).toContainText(/24 h/);
});

test("no toast names an HTTP endpoint either", async ({ page, request }) => {
  // The 409 hints are written for an API caller ("POST /plan/pause freezes the plan; GET /health
  // and GET /today report the pause."). On this page those are buttons, not endpoints.
  await resetMock(request, { now: T("10:20") });
  await openToday(page);
  // resume while the plan is running: another client got there first
  await page.route("**/plan/resume", (r) =>
    r.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "CONFLICT",
          message: "the plan is not paused, so there is nothing to resume",
          hint: "POST /plan/pause freezes the plan; GET /health and GET /today report the pause.",
        },
      }),
    }),
  );
  await pauseBtn(page).click(); // pauses
  await expect(pauseBtn(page)).toHaveAttribute("data-label", "Resume");
  await pauseBtn(page).click(); // resume -> the stubbed 409

  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Couldn't resume" });
  await expect(toast).toBeVisible();
  const text = (await toast.textContent())!;
  expect(text, text).not.toMatch(/\b(GET|POST|PUT|PATCH|DELETE)\s+\//);
  expect(text, text).not.toMatch(/\/plan\/|\/health|\/today/);
  // the endpoint became the control's name, and the sentence still stands
  await expect(toast).toContainText("Pause freezes the plan.");
  await expect(toast).toContainText("The plan is not paused");
});

test("the paused banner names the day when the pause did not start today", async ({ page, request }) => {
  // same day: the wall clock alone
  await resetMock(request, { now: T("10:20") });
  await pauseMock(request, 60_000);
  await openToday(page);
  await expect(page.getByTestId("paused-since")).toHaveText(/^10:1\d$/);

  // started yesterday: "since yesterday 23:40" — "since 23:40" alone would be ambiguous
  await resetMock(request, { now: `${DAY}T00:30:00+01:00` });
  await pauseMock(request, 50 * 60_000); // 23:40 the previous day
  await page.goto("/");
  await expect(page.getByTestId("paused-notice")).toBeVisible();
  await expect(page.getByTestId("paused-since")).toHaveText(/^yesterday 23:[34]\d$/);
});

test("while paused, what the UI calls 'now' is what the API calls 'now'", async ({ page, request }) => {
  // The UI freezes locally from `paused.since` and the API freezes server-side. They must agree, or
  // the now panel and the timeline drift apart from /today.
  await resetMock(request, { now: T("10:20") });
  await pauseMock(request, 120_000);
  await openToday(page);
  await expect(page.getByTestId("paused-notice")).toBeVisible();
  await page.waitForTimeout(2500); // let real time move well past the pause instant

  const t = await (await request.get(`${MOCK}/today`)).json();
  expect(t.paused).not.toBeNull();
  // the API froze these at the pause instant, not at wall-clock now
  expect(t.current.key).toBe(A10);
  expect(t.currentTask.key).toBe(A10);
  // and the UI is showing exactly that item as the current one
  await expect(page.getByTestId("now-title")).toHaveText(t.currentTask.title);
  await expect(row(page, t.current.key)).toHaveAttribute("data-current", "true");
  await expect(page.locator("[data-testid=task-row][data-current=true]")).toHaveCount(1);
});

// ---------------------------------------------------------------- a11y in the paused state
async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(" | ")}`);
  expect(summary, summary.join("\n")).toEqual([]);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`paused, axe (${scheme}) desktop`, () => {
    test.use({ colorScheme: scheme });
    test("no violations", async ({ page, request }) => {
      await resetMock(request, { now: T("10:20") });
      await pauseMock(request, 72_000);
      await openToday(page);
      await expect(page.getByTestId("paused-notice")).toBeVisible();
      await page.waitForTimeout(400);
      await axe(page);
    });
  });

  test.describe(`paused, axe (${scheme}) 390 px`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    test("no violations, no horizontal scroll, tap targets ≥ 40 px", async ({ page, request }) => {
      await resetMock(request, { now: T("10:20") });
      await pauseMock(request, 72_000);
      await openToday(page);
      await expect(page.getByTestId("paused-notice")).toBeVisible();
      await page.waitForTimeout(400);
      await axe(page);

      const { scrollW, clientW } = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(scrollW, `scrollWidth ${scrollW} vs ${clientW}`).toBeLessThanOrEqual(clientW);

      const box = (await pauseBtn(page).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(40);
      expect(box.width).toBeGreaterThanOrEqual(40);
      // reachable: inside the viewport, and it scrolls into view without a horizontal move
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);

      const small = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("button, a[href], [role=checkbox], input, select"))
          .filter((el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled)
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && (r.width < 40 || r.height < 40))
          .map(({ el, r }) => `${el.tagName}.${el.getAttribute("data-testid") ?? el.textContent?.slice(0, 20)} ${r.width}x${r.height}`),
      );
      expect(small, small.join("\n")).toEqual([]);
    });
  });
}

test.describe("390 px: the now panel stays in view while paused", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("after the initial scroll and after scrolling the timeline", async ({ page, request }) => {
    await resetMock(request, { now: T("13:10") });
    await pauseMock(request, 72_000);
    await openToday(page);
    await page.waitForTimeout(600);
    for (const step of [0, 4000]) {
      if (step) await page.mouse.wheel(0, step);
      await page.waitForTimeout(400);
      const b = (await page.getByTestId("state-now").boundingBox())!;
      expect(b.y, `panel top ${b.y} after ${step}`).toBeGreaterThanOrEqual(0);
      expect(b.y + b.height).toBeLessThanOrEqual(844);
      await expect(page.getByTestId("paused-notice")).toBeVisible();
    }
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("the label swap animates nothing", async ({ page, request }) => {
    await resetMock(request, { now: T("10:20") });
    await openToday(page);
    const durations = await pauseBtn(page).evaluate((el) =>
      Array.from(el.querySelectorAll("span")).map((s) => getComputedStyle(s).transitionDuration),
    );
    expect(durations.every((d) => parseFloat(d) < 0.05), durations.join(",")).toBe(true);
    await pauseBtn(page).click();
    await expect(pauseBtn(page)).toHaveAttribute("data-label", "Resume");
  });
});
