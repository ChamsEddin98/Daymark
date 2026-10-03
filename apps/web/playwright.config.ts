import { defineConfig, devices } from "@playwright/test";

/**
 * Tests run against a production build of the app (port 3418) pointed at the fixture API
 * (port 4318), so they never collide with `npm run dev` (3417) or the real API (4317).
 * Set PW_REUSE=1 to reuse servers that are already running on those ports.
 */
const MOCK_PORT = 4318;
const WEB_PORT = 3418;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    timezoneId: "Africa/Tunis",
    locale: "en-GB",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: "npx tsx fixtures/mock-api.ts",
      env: { MOCK_PORT: String(MOCK_PORT), MOCK_NOW: "2026-09-28T10:20:00+01:00" },
      url: `${MOCK}/health`,
      reuseExistingServer: !!process.env.PW_REUSE,
      stdout: "ignore",
    },
    {
      command: `npx next build && npx next start -p ${WEB_PORT} -H 127.0.0.1`,
      env: { PLANNER_API: MOCK },
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !!process.env.PW_REUSE,
      timeout: 300_000,
      stdout: "ignore",
    },
  ],
});
