import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { key, openToday, resetMock, row, T } from "./helpers";

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const summary = r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(" | ")}`);
  expect(summary, summary.join("\n")).toEqual([]);
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`axe (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test(`mid-day with done items, current row and toast — no violations`, async ({ page, request }) => {
      await resetMock(request, { now: T("10:20") });
      await openToday(page);
      await row(page, key("bcg/A11")).getByTestId("check").click();
      await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
      await page.waitForTimeout(400); // let transitions settle so colours are final
      await axe(page);
    });

    test(`long rest, shift popover open — no violations`, async ({ page, request }) => {
      await resetMock(request, { now: T("13:25") });
      await openToday(page);
      await page.keyboard.press("s");
      await expect(page.getByTestId("preview-1h")).toHaveText(/Ends/);
      await page.waitForTimeout(300);
      await axe(page);
    });

    test(`before 08:00, all done and API down — no violations`, async ({ page, request }) => {
      await resetMock(request, { now: T("07:30"), scenario: "fresh" });
      await openToday(page);
      await axe(page);
      await resetMock(request, { now: T("18:40"), scenario: "alldone" });
      await openToday(page);
      await expect(page.getByTestId("state-done")).toBeVisible();
      await axe(page);
      await page.route("http://127.0.0.1:4318/**", (r) => r.abort("connectionrefused"));
      await page.goto("/");
      await expect(page.getByTestId("state-down")).toBeVisible();
      await axe(page);
    });

    test(`help overlay — no violations`, async ({ page, request }) => {
      await resetMock(request, { now: T("10:20") });
      await openToday(page);
      await page.keyboard.press("?");
      await expect(page.getByTestId("help-dialog")).toBeVisible();
      await page.waitForTimeout(250);
      await axe(page);
    });
  });
}

test.describe("390 px", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  for (const [name, now, scenario] of [
    ["mid-day", "10:20", "auto"],
    ["long rest", "13:25", "auto"],
    ["all done", "18:40", "alldone"],
  ] as const) {
    test(`${name}: no horizontal scroll, tap targets ≥ 40 px`, async ({ page, request }) => {
      await resetMock(request, { now: T(now), scenario });
      await openToday(page);
      const { scrollW, clientW } = await page.evaluate(() => ({
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
      }));
      expect(scrollW).toBeLessThanOrEqual(clientW);
      const small = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("button, a[href], [role=checkbox], input, select"))
          .filter((el) => el.offsetParent !== null)
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && (r.width < 40 || r.height < 40))
          .map(({ el, r }) => `${el.tagName}.${el.getAttribute("data-testid") ?? el.textContent?.slice(0, 20)} ${r.width}x${r.height}`),
      );
      expect(small, small.join("\n")).toEqual([]);
    });
  }

  test("tap to complete works on touch", async ({ page, request }) => {
    await resetMock(request, { now: T("10:20") });
    await openToday(page);
    await row(page, key("bcg/A11")).getByTestId("check").tap();
    await expect(row(page, key("bcg/A11")).getByTestId("check")).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("checking does not animate transforms", async ({ page, request }) => {
    await resetMock(request, { now: T("10:20") });
    await openToday(page);
    const check = row(page, key("bcg/A11")).getByTestId("check");
    const transforms = await check.evaluate(async (btn) => {
      const fill = btn.querySelector("[data-fill]") as HTMLElement;
      const seen = new Set<string>();
      (btn as HTMLButtonElement).click();
      const t0 = performance.now();
      while (performance.now() - t0 < 300) {
        seen.add(getComputedStyle(fill).transform);
        await new Promise((r) => requestAnimationFrame(r));
      }
      return [...seen];
    });
    expect(transforms.filter((t) => t !== "none" && t !== "matrix(1, 0, 0, 1, 0, 0)")).toEqual([]);
    await expect(check).toHaveAttribute("aria-checked", "true");
  });
});
