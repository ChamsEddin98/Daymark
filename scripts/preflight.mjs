// Preflight for `npm start` / `npm run dev`: checks Node, creates the data dir, reports Google auth,
// builds the web UI when its production build is missing or stale, and prints the URLs.
// It never fails because Google is not authorised: calendar sync is optional.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WEB_DIR = join(ROOT, "apps", "web");
const MIN_NODE = [22, 13];

export function ports(env = process.env) {
  const api = Number(env.PLANNER_API_PORT || 4317);
  const web = Number(env.PLANNER_WEB_PORT || 3417);
  for (const [name, p] of [["PLANNER_API_PORT", api], ["PLANNER_WEB_PORT", web]])
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`${name} must be a port number, got ${JSON.stringify(env[name])}`);
  return { api, web };
}

/** Absolute path of the `next` CLI, resolved from the web workspace (works whether hoisted or not). */
export function nextBin() {
  const req = createRequire(join(WEB_DIR, "package.json"));
  return join(dirname(req.resolve("next/package.json")), "dist", "bin", "next");
}

function newestMtime(p) {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const e of readdirSync(p)) max = Math.max(max, newestMtime(join(p, e)));
  return max;
}

/** The build is stale when any web source is newer than .next/BUILD_ID. */
function webBuildState() {
  const id = join(WEB_DIR, ".next", "BUILD_ID");
  if (!existsSync(id)) return "missing";
  const built = statSync(id).mtimeMs;
  const sources = ["app", "components", "hooks", "lib", "public", "next.config.ts", "package.json", "postcss.config.mjs", "tsconfig.json", "components.json"];
  const newest = Math.max(...sources.map((s) => newestMtime(join(WEB_DIR, s))));
  return newest > built ? "stale" : "fresh";
}

function envHas(key) {
  if (process.env[key]) return true;
  const f = join(ROOT, ".env");
  if (!existsSync(f)) return false;
  return new RegExp(`^\\s*${key}\\s*=\\s*\\S`, "m").test(readFileSync(f, "utf8"));
}

/** Loads <repo>/.env into `env` without overriding what is already set, so PLANNER_API_PORT and
 *  PLANNER_WEB_PORT in .env are honoured by npm start (the API and daemon load .env the same way). */
export function loadDotEnv(env = process.env) {
  const f = join(ROOT, ".env");
  if (!existsSync(f)) return;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(f, "utf8")))) if (env[k] === undefined) env[k] = v;
}

export function preflight({ mode = "start", env = process.env } = {}) {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1])) {
    console.error(`[preflight] Node ${process.versions.node} is too old. The planner needs Node >= ${MIN_NODE.join(".")} (node:sqlite).`);
    process.exit(1);
  }
  if (!existsSync(join(ROOT, "node_modules"))) {
    console.error("[preflight] Dependencies are missing. Run `npm install` at the repo root first.");
    process.exit(1);
  }
  loadDotEnv(env);
  const p = ports(env);

  const dataDir = env.PLANNER_DATA_DIR ? resolve(env.PLANNER_DATA_DIR) : join(ROOT, ".data");
  mkdirSync(dataDir, { recursive: true });

  // Create and migrate the SQLite store once, before the API and the daemon open it together.
  const init = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "init-store.ts")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...env, PLANNER_DATA_DIR: dataDir },
  });
  if (init.status !== 0) {
    console.error(`[preflight] Could not open the store in ${dataDir} (see above).`);
    process.exit(init.status ?? 1);
  }

  const token = join(dataDir, "google-token.json");
  if (existsSync(token)) console.log(`[preflight] Google Calendar: authorised (${token})`);
  else {
    const creds = envHas("GOOGLE_CLIENT_ID") && envHas("GOOGLE_CLIENT_SECRET");
    console.log("[preflight] Google Calendar: not authorised. The planner runs fine without it (no calendar sync).");
    console.log(
      creds
        ? "[preflight]   To enable sync, run once: npm run auth"
        : "[preflight]   To enable sync: copy .env.example to .env, fill GOOGLE_CLIENT_ID/SECRET (docs/GOOGLE_SETUP.md), then run: npm run auth",
    );
  }

  if (mode === "start") {
    const state = webBuildState();
    if (state !== "fresh") {
      console.log(`[preflight] Web UI production build is ${state}; running \`next build\` (first run takes about a minute)...`);
      const r = spawnSync(process.execPath, [nextBin(), "build"], { cwd: WEB_DIR, stdio: "inherit", env: { ...env, NEXT_TELEMETRY_DISABLED: "1" } });
      if (r.status !== 0) {
        console.error("[preflight] `next build` failed (see above). Fix it, or run `npm run dev` to use the dev server instead.");
        process.exit(r.status ?? 1);
      }
    } else console.log("[preflight] Web UI production build is up to date.");
  }

  // Where the last `npm start` put things, for clients (the Claude Code skill) that need the port.
  const runtime = {
    apiUrl: `http://127.0.0.1:${p.api}`,
    webUrl: `http://127.0.0.1:${p.web}`,
    apiPort: p.api,
    webPort: p.web,
    mode,
    startedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(join(dataDir, "runtime.json"), `${JSON.stringify(runtime, null, 2)}\n`);
  } catch (e) {
    console.warn(`[preflight] could not write runtime.json: ${e.message}`);
  }

  console.log(`[preflight] Data dir: ${dataDir}`);
  console.log(`[preflight] Web UI:   http://127.0.0.1:${p.web}`);
  console.log(`[preflight] API:      http://127.0.0.1:${p.api}  (try http://127.0.0.1:${p.api}/today)`);
  return { ports: p, dataDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  preflight({ mode: process.argv.includes("--dev") ? "dev" : "start" });
}
