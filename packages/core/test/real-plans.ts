/**
 * The owner's own plan files under `resources/`.
 *
 * They are personal documents - what someone is studying and which companies they are preparing
 * for - so they are gitignored: present on the machine that runs the planner, absent in a fresh
 * clone. `docs/example-task-file.md` carries the structure in the repo instead.
 *
 * Tests that read them are proving something that only real documents can prove - that the surgical
 * editor and the HTML conversion do not mangle hand-written prose - so they run where those
 * documents exist and skip, visibly, where they do not. They are not fixture-backed on purpose: a
 * fixture would be written to suit the editor, which is the opposite of the point.
 *
 * Shared by `packages/core` and `apps/api` so the path and the reason live in one place.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const REAL_PLANS_DIR = resolve(import.meta.dirname, "../../../resources");

/** The `.md` task files actually on disk, newest-sorted for stable test output. */
export function realPlanFiles(): string[] {
  try {
    if (!existsSync(REAL_PLANS_DIR) || !statSync(REAL_PLANS_DIR).isDirectory()) return [];
    return readdirSync(REAL_PLANS_DIR)
      .filter((n) => n.toLowerCase().endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/** True when the owner's plans are present, so the tests that need them can run. */
export const hasRealPlans: boolean = realPlanFiles().length > 0;

/** Read one of them. Only valid when `hasRealPlans`; guard the suite with `skipIf(!hasRealPlans)`. */
export const readRealPlan = (name: string): string => readFileSync(resolve(REAL_PLANS_DIR, name), "utf8");

/** Read one when present, else "" - for a top-level const in a suite that is skipped anyway. */
export const readRealPlanIfAny = (name: string): string => {
  try {
    return readRealPlan(name);
  } catch {
    return "";
  }
};
