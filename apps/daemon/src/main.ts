/** Entry point: `npm start -w @planner/daemon` (or `npm run daemon` at the root). */
import { config } from "dotenv";
import { resolve } from "node:path";
import { REPO_ROOT } from "@planner/store";
import { Daemon } from "./daemon.ts";
import { DEFAULT_APP_ID } from "./sinks.ts";
import { registerToastApp } from "./toastSetup.ts";

config({ path: resolve(REPO_ROOT, ".env"), quiet: true });

const log = (msg: string) => console.log(`[daemon] ${msg}`);

let daemon: Daemon;
try {
  daemon = new Daemon({ log });
} catch (e) {
  console.error(`[daemon] failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
daemon.resetClock();
const s = daemon.service;
log(
  `started (tz ${s.timeZone}, now ${s.nowIso()}, clock ${daemon.clock.kind}${daemon.clock.speed > 1 ? ` x${daemon.clock.speed}` : ""}, ` +
    `${s.tasks.length} tasks, sinks ${daemon.sinks.map((x) => x.name).join("+") || "none"}, tick ${Math.round(daemon.tickMs())} ms, db ${daemon.store.path})`,
);
daemon.start();
if (daemon.sinks.some((x) => x.name === "toast")) {
  const appID = process.env.PLANNER_TOAST_APPID || DEFAULT_APP_ID;
  void registerToastApp(appID).then((r) => {
    if (r.result === "installed") log(`registered toast app "${appID}" (Start-menu shortcut ${r.detail})`);
    else if (r.result === "failed") log(`could not register toast app "${appID}": ${r.detail} (toasts may not show; see PLANNER_TOAST_APPID)`);
  });
}

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  const st = daemon.scanner.stats;
  log(`${signal}: shutting down (${st.fired} notifications, ${st.toasts} toasts this run)`);
  await daemon.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("uncaughtException", (e) => log(`uncaught: ${e.stack ?? e.message}`));
process.on("unhandledRejection", (e) => log(`unhandled rejection: ${e instanceof Error ? e.message : String(e)}`));
