import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { openToday, pauseMock, resetMock, T } from "./helpers";

const OUT = fileURLToPath(new URL("../screenshots/", import.meta.url));
const SIZES = [
  { name: "1440x900", viewport: { width: 1440, height: 900 } },
  { name: "390x844", viewport: { width: 390, height: 844 } },
] as const;

const STATES = [
  { name: "mid-day", now: "10:20", scenario: "auto", ready: "state-now" },
  { name: "long-rest", now: "13:25", scenario: "auto", ready: "state-now" },
  { name: "all-done", now: "18:40", scenario: "alldone", ready: "state-done" },
  { name: "before-0800", now: "07:30", scenario: "fresh", ready: "state-before" },
  { name: "api-down", now: "10:20", scenario: "auto", ready: "state-down" },
  { name: "missed", now: "10:20", scenario: "missed", ready: "missed-banner" },
  { name: "late-1600", now: "16:00", scenario: "missed", ready: "missed-banner" },
  { name: "long-rest-1310", now: "13:10", scenario: "auto", ready: "state-now" },
] as const;

for (const scheme of ["light", "dark"] as const) {
  for (const size of SIZES) {
    test.describe(`${scheme} ${size.name}`, () => {
      test.use({ viewport: size.viewport, colorScheme: scheme });
      for (const s of STATES) {
        if (scheme === "dark" && !["mid-day", "long-rest", "api-down", "missed", "late-1600"].includes(s.name)) continue;
        test(s.name, async ({ page, request }) => {
          await resetMock(request, { now: T(s.now), scenario: s.scenario });
          if (s.name === "api-down") {
            await page.route("http://127.0.0.1:4318/**", (r) => r.abort("connectionrefused"));
            await page.goto("/");
          } else {
            await openToday(page);
          }
          await expect(page.getByTestId(s.ready)).toBeVisible();
          await page.waitForTimeout(400);
          const suffix = scheme === "dark" ? "-dark" : "";
          await page.screenshot({ path: path.join(OUT, `${s.name}${suffix}-${size.name}.png`) });
        });
      }
      // P8: the paused state, in both schemes and both sizes.
      test("paused", async ({ page, request }) => {
        await resetMock(request, { now: T("10:20") });
        await pauseMock(request, 72_000); // "Resume 1:12"
        await openToday(page);
        await expect(page.getByTestId("paused-notice")).toBeVisible();
        await page.waitForTimeout(500);
        const suffix = scheme === "dark" ? "-dark" : "";
        await page.screenshot({ path: path.join(OUT, `paused${suffix}-${size.name}.png`) });
      });
      if (scheme === "light") {
        test("shift-open", async ({ page, request }) => {
          await resetMock(request, { now: T("10:20") });
          await openToday(page);
          await page.keyboard.press("s");
          await expect(page.getByTestId("preview-1d")).toHaveText(/move/);
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(OUT, `shift-open-${size.name}.png`) });
        });
        test("after-day-shift", async ({ page, request }) => {
          await resetMock(request, { now: T("10:20") });
          await openToday(page);
          await page.keyboard.press("j");
          await page.keyboard.press("j");
          await page.keyboard.press("x"); // A11 done ahead of its slot
          await page.waitForTimeout(300);
          await page.keyboard.press("s");
          await expect(page.getByTestId("preview-1d")).toHaveText(/move/);
          await page.keyboard.press("4");
          await expect(page.getByTestId("done-earlier")).toBeVisible();
          await page.waitForTimeout(600);
          await page.screenshot({ path: path.join(OUT, `after-day-shift-${size.name}.png`) });
        });
        test("checked-with-undo-toast", async ({ page, request }) => {
          await resetMock(request, { now: T("10:20") });
          await openToday(page);
          await page.keyboard.press("j");
          await page.keyboard.press("x");
          await page.waitForTimeout(400);
          await page.screenshot({ path: path.join(OUT, `checked-undo-${size.name}.png`) });
        });
      }
    });
  }
}
