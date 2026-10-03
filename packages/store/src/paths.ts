import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** PLANNER_DATA_DIR (tests) else <repo>/.data */
export function dataDir(env: Record<string, string | undefined> = process.env): string {
  return env.PLANNER_DATA_DIR ? resolve(env.PLANNER_DATA_DIR) : resolve(REPO_ROOT, ".data");
}

/** PLANNER_RESOURCES_DIR else <repo>/resources */
export function resourcesDir(env: Record<string, string | undefined> = process.env): string {
  return env.PLANNER_RESOURCES_DIR ? resolve(env.PLANNER_RESOURCES_DIR) : resolve(REPO_ROOT, "resources");
}

/**
 * The calendar to sync into, when the owner supplies one instead of letting the planner create its
 * own: `CALENDAR_ID`, or `PLANNER_CALENDAR_ID` for consistency with the other variables. This is the
 * single definition both the API and the daemon read, so the two processes can never sync into
 * different calendars.
 *
 * Returns undefined when neither is set, which means "create and own one" - the OAuth arrangement.
 */
export function calendarIdFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = (env.PLANNER_CALENDAR_ID ?? env.CALENDAR_ID ?? "").trim();
  return raw || undefined;
}
