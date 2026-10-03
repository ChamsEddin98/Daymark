import { expect, test } from "@playwright/test";
import { key, mockState, openToday, resetMock, row, T } from "./helpers";

const A11 = key("bcg/A11");
const A12 = key("bcg/A12");

test.describe("round checkbox", () => {
  test.beforeEach(async ({ request }) => {
    // 400 ms of server latency: anything visible before that is the optimistic update.
    await resetMock(request, { now: T("10:20"), latencyMs: 400 });
  });

  test("hover previews the check; click fills < 100 ms, animates 150–300 ms, persists across reload", async ({
    page,
    request,
  }) => {
    await openToday(page);
    const check = row(page, A11).getByTestId("check");
    const path = check.locator("path");

    // hover preview: the check path becomes visible inside the empty circle
    expect(Number(await path.evaluate((el) => getComputedStyle(el).opacity))).toBe(0);
    await check.hover();
    await expect.poll(() => path.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.5);

    // instrument: time from pointerdown to aria-checked + filled background, and how long the pop runs
    await check.evaluate((btn) => {
      const w = window as unknown as { __m: Record<string, number> };
      w.__m = {};
      const fill = btn.querySelector("[data-fill]") as HTMLElement;
      btn.addEventListener("pointerdown", () => (w.__m.down = performance.now()), { capture: true, once: true });
      new MutationObserver(() => {
        if (btn.getAttribute("aria-checked") === "true" && !w.__m.checked) {
          w.__m.checked = performance.now();
          w.__m.bg = getComputedStyle(fill).backgroundColor === "rgba(0, 0, 0, 0)" ? 0 : 1;
          // sample the transform until it settles back to identity
          let lastChange = performance.now();
          let prev = "";
          const loop = () => {
            const tf = getComputedStyle(fill).transform;
            if (tf !== prev) {
              prev = tf;
              lastChange = performance.now();
            }
            if (performance.now() - lastChange > 120) w.__m.settled = lastChange;
            else requestAnimationFrame(loop);
          };
          requestAnimationFrame(loop);
        }
      }).observe(btn, { attributes: true, subtree: true });
    });
    await check.click();
    await expect(check).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => page.evaluate(() => (window as any).__m.settled ?? 0)).toBeGreaterThan(0);
    const m = await page.evaluate(() => (window as any).__m as Record<string, number>);
    const toChecked = m.checked! - m.down!;
    const anim = m.settled! - m.checked!;
    test.info().annotations.push({ type: "timing", description: `click→filled ${toChecked.toFixed(1)} ms; pop ${anim.toFixed(0)} ms` });
    console.log(`[timing] click→checked+filled ${toChecked.toFixed(1)} ms, micro-animation ${anim.toFixed(0)} ms`);
    expect(m.bg).toBe(1);
    expect(toChecked).toBeLessThan(100);
    expect(anim).toBeGreaterThanOrEqual(150);
    expect(anim).toBeLessThanOrEqual(300);

    // row stays in place, dimmed with strike-through
    await expect(row(page, A11)).toHaveAttribute("data-status", "done");
    const title = row(page, A11).locator("p").first();
    await expect(title).toHaveCSS("text-decoration-line", "line-through");

    // undo toast is up for 5 s
    await expect(page.getByText("Completed", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();

    // persisted through the API
    await expect.poll(async () => (await mockState(request))[A11]).toBe("done");
    await page.reload();
    await expect(row(page, A11).getByTestId("check")).toHaveAttribute("aria-checked", "true");
  });

  test("undo from the toast and from the u key", async ({ page, request }) => {
    await openToday(page);
    const check = row(page, A12).getByTestId("check");

    await check.click();
    await expect(check).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(check).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await mockState(request))[A12]).toBe("pending");

    await check.click();
    await expect(check).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await mockState(request))[A12]).toBe("done");
    await page.keyboard.press("u");
    await expect(check).toHaveAttribute("aria-checked", "false");
    await expect.poll(async () => (await mockState(request))[A12]).toBe("pending");
  });

  test("the undo toast disappears after 5 s", async ({ page }) => {
    await openToday(page);
    await row(page, A12).getByTestId("check").click();
    const undo = page.getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();
    await page.waitForTimeout(4200);
    await expect(undo).toBeVisible();
    await expect(undo).toBeHidden({ timeout: 2500 });
  });

  test("rolls back and explains when the API rejects the change", async ({ page, request }) => {
    await resetMock(request, { now: T("10:20"), latencyMs: 200, failNext: 1 });
    await openToday(page);
    const check = row(page, A11).getByTestId("check");
    await check.click();
    await expect(check).toHaveAttribute("aria-checked", "true");
    await expect(check).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("Couldn't save that change")).toBeVisible();
    expect((await mockState(request))[A11]).toBe("pending");
  });

  test("a change made elsewhere shows up live over SSE", async ({ page, request }) => {
    await resetMock(request, { now: T("10:20") });
    await openToday(page);
    await request.post(`http://127.0.0.1:4318/items/${encodeURIComponent(A12)}/status`, { data: { status: "done" } });
    await expect(row(page, A12).getByTestId("check")).toHaveAttribute("aria-checked", "true", { timeout: 2000 });
  });
});
