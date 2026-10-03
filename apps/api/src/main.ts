/** Entry point: `npm start -w @planner/api` (or `npm run api` at the root). */
import { config } from "dotenv";
import { resolve } from "node:path";
import { REPO_ROOT } from "@planner/store";
import { startApi } from "./app.ts";

config({ path: resolve(REPO_ROOT, ".env"), quiet: true });

const api = await startApi();
const h = api.service;
console.error(
  `[api] listening on ${api.url}  (tz ${h.timeZone}, now ${h.nowIso()}, clock ${h.clock.kind}, ${h.tasks.length} tasks, horizon ${h.horizon} d, db ${api.store.path})`,
);

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.error(`[api] ${signal}: shutting down`);
  await api.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
