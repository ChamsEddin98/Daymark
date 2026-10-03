// `npm run auth` — connects Google Calendar via the OAuth loopback flow.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CALENDAR_SCOPE, DEFAULT_TOKEN_PATH, REPO_ROOT, authorize } from "../auth.ts";

const envPath = resolve(REPO_ROOT, ".env");
if (existsSync(envPath) && typeof process.loadEnvFile === "function") process.loadEnvFile(envPath);

const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error(
    `GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in ${envPath}.\n` +
      "Copy .env.example to .env and follow docs/GOOGLE_SETUP.md.",
  );
  process.exit(1);
}

const noBrowser = process.argv.includes("--no-browser");
try {
  const token = await authorize({
    clientId,
    clientSecret,
    tokenPath: DEFAULT_TOKEN_PATH,
    openBrowser: !noBrowser,
    onUrl: (url) => {
      console.log(`Requesting scope: ${CALENDAR_SCOPE}`);
      console.log(`${noBrowser ? "Open" : "Opening your browser. If it does not open, visit"} this URL:\n\n${url}\n`);
      console.log("Waiting for Google to redirect back to this machine...");
    },
  });
  console.log(`Authorized. Token saved to ${DEFAULT_TOKEN_PATH} (scope: ${token.scope ?? CALENDAR_SCOPE}).`);
  process.exit(0);
} catch (err) {
  console.error(`Authorization failed: ${(err as Error).message}`);
  process.exit(1);
}
