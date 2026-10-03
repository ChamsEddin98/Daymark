// Run by scripts/preflight.mjs before the API and the daemon start: creates and migrates
// <PLANNER_DATA_DIR or .data>/planner.db once, so the two processes never race to create it.
import { PlannerStore } from "@planner/store";

const store = new PlannerStore();
console.log(`[preflight] Store ready: ${store.path} (schema v${store.schemaVersion})`);
store.close();
