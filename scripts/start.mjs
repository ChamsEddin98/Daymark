// `npm start` (production web build) and `npm run dev` (watch mode): runs the preflight, then the
// API, the daemon and the web UI together with named, coloured prefixes. If any of them exits with
// an error, the others are stopped (--kill-others-on-fail). Ctrl+C stops all three.
//
// Env: PLANNER_API_PORT (default 4317), PLANNER_WEB_PORT (default 3417), plus everything the API and
// daemon read (PLANNER_DATA_DIR, PLANNER_TZ, PLANNER_NOW, ...). PLANNER_API and PLANNER_WEB_ORIGINS
// are derived from the ports so the web UI and the API's CORS/origin guard always agree.
import concurrently from "concurrently";
import { ROOT, WEB_DIR, nextBin, preflight } from "./preflight.mjs";

const dev = process.argv.includes("--dev");
const { ports } = preflight({ mode: dev ? "dev" : "start" });

const webOrigins = [`http://127.0.0.1:${ports.web}`, `http://localhost:${ports.web}`];
const extra = (process.env.PLANNER_WEB_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const env = {
  PLANNER_API_PORT: String(ports.api),
  PLANNER_WEB_PORT: String(ports.web),
  PLANNER_WEB_ORIGINS: [...new Set([...extra, ...webOrigins])].join(","),
  PLANNER_API: process.env.PLANNER_API ?? `http://127.0.0.1:${ports.api}`,
  NEXT_TELEMETRY_DISABLED: "1",
};

const q = (s) => JSON.stringify(s); // paths may contain spaces
const next = `${q(process.execPath)} ${q(nextBin())} ${dev ? "dev" : "start"} -p ${ports.web} -H 127.0.0.1`;

const { result } = concurrently(
  [
    { name: "api", command: dev ? "npm run dev -w @planner/api" : "npm start -w @planner/api", prefixColor: "cyan", env, cwd: ROOT },
    { name: "daemon", command: "npm start -w @planner/daemon", prefixColor: "magenta", env, cwd: ROOT },
    { name: "web", command: next, prefixColor: "green", env, cwd: WEB_DIR },
  ],
  { prefix: "name", killOthersOn: ["failure"], restartTries: 0 },
);

result.then(
  () => process.exit(0),
  (events) => {
    const failed = events.filter((e) => e.exitCode !== 0 && e.exitCode !== "SIGINT" && e.exitCode !== "SIGTERM");
    if (failed.length) console.error(`[start] stopped: ${failed.map((e) => `${e.command.name} exited ${e.exitCode}`).join(", ")}`);
    process.exit(failed.length ? 1 : 0);
  },
);
