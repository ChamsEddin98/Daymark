import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodeChallengeMethod, JWT, OAuth2Client, type Credentials } from "google-auth-library";
import { NotAuthorizedError } from "./errors.ts";
import { withBaseUrl } from "./http.ts";

/** Narrowest scope that can create a dedicated calendar and manage events on it only. */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";

/**
 * The scope a service account asks for: events on calendars it can already see, and nothing else.
 *
 * It is deliberately *not* `calendar` or `calendar.app.created`. A service account's reach is bounded
 * by which calendars have been shared with it, not by the scope - so the scope's job here is a
 * different one: `calendar.events` cannot call `calendars.insert`, which makes it **impossible** for
 * the planner to create a calendar the service account owns. That failure mode is the one that
 * matters, because such a calendar is invisible to the owner: the sync would report success for ever
 * while nothing ever appeared in Google Calendar. The scope rules it out by construction.
 */
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Same data dir rule as @planner/store's dataDir(): the API and daemon read <dataDir>/google-token.json.
export const DEFAULT_TOKEN_PATH = resolve(
  process.env.PLANNER_DATA_DIR ? resolve(process.env.PLANNER_DATA_DIR) : resolve(REPO_ROOT, ".data"),
  "google-token.json",
);

/** Same data dir rule again: the API and the daemon look for the key beside the OAuth token. */
export const DEFAULT_SERVICE_ACCOUNT_PATH = resolve(
  process.env.PLANNER_DATA_DIR ? resolve(process.env.PLANNER_DATA_DIR) : resolve(REPO_ROOT, ".data"),
  "google-service-account.json",
);

/** The fields the planner needs from a Google service-account key file. */
export interface ServiceAccountKey {
  type: string;
  project_id?: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface OAuthEndpoints {
  /** Token endpoint. Default https://oauth2.googleapis.com/token */
  oauth2TokenUrl?: string;
  /** Consent page. Default https://accounts.google.com/o/oauth2/v2/auth */
  oauth2AuthBaseUrl?: string;
}

export interface AuthorizeOptions {
  clientId: string;
  clientSecret: string;
  /** Default D:\planner\.data\google-token.json (repo-root .data). */
  tokenPath?: string;
  /**
   * true (default): open the system browser. false: don't. A function: called with the consent URL
   * instead (tests drive the flow this way).
   */
  openBrowser?: boolean | ((url: string) => unknown);
  /** Called with the consent URL as soon as it is known (the CLI prints it). */
  onUrl?: (url: string) => void;
  /** Abort if no redirect arrives in time. Default 5 minutes. */
  timeoutMs?: number;
  endpoints?: OAuthEndpoints;
}

export interface StoredToken extends Credentials {
  scope?: string;
}

function makeClient(clientId: string, clientSecret: string, endpoints?: OAuthEndpoints, redirectUri?: string) {
  return new OAuth2Client({
    clientId,
    clientSecret,
    ...(redirectUri ? { redirectUri } : {}),
    ...(endpoints ? { endpoints: endpoints as never } : {}),
  });
}

/** Atomically writes the token JSON with mode 0600 (best effort on Windows). */
export function writeToken(tokenPath: string, token: StoredToken): void {
  mkdirSync(dirname(tokenPath), { recursive: true });
  const tmp = `${tokenPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
  renameSync(tmp, tokenPath);
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    /* not supported on this platform */
  }
}

export function readToken(tokenPath: string = DEFAULT_TOKEN_PATH): StoredToken | undefined {
  try {
    return JSON.parse(readFileSync(tokenPath, "utf8")) as StoredToken;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new NotAuthorizedError(`Token file ${tokenPath} is unreadable: ${(e as Error).message}`);
  }
}

/**
 * Read and validate a service-account key file. Returns undefined when there is none, so a caller
 * can fall back to OAuth; throws when the file exists but is not a usable key, because silently
 * falling back would leave the owner wondering why their key is ignored.
 */
export function readServiceAccount(path: string = DEFAULT_SERVICE_ACCOUNT_PATH): ServiceAccountKey | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new NotAuthorizedError(`Service-account key ${path} is unreadable: ${(e as Error).message}`, SERVICE_ACCOUNT_HINT);
  }
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(raw) as Partial<ServiceAccountKey>;
  } catch (e) {
    throw new NotAuthorizedError(`Service-account key ${path} is not valid JSON: ${(e as Error).message}`, SERVICE_ACCOUNT_HINT);
  }
  // A downloaded OAuth *client* file is the usual mix-up: same place, same shape, wrong thing.
  if (key.type !== "service_account")
    throw new NotAuthorizedError(
      `${path} is not a service-account key (its "type" is ${JSON.stringify(key.type ?? null)}).`,
      'Download the key from the service account\'s "Keys" tab, not the OAuth client JSON. See docs/GOOGLE_SETUP.md.',
    );
  if (!key.client_email || !key.private_key)
    throw new NotAuthorizedError(`${path} is missing client_email or private_key.`, SERVICE_ACCOUNT_HINT);
  if (!key.private_key.includes("BEGIN PRIVATE KEY"))
    throw new NotAuthorizedError(`${path} has a private_key that is not a PEM block.`, SERVICE_ACCOUNT_HINT);
  return key as ServiceAccountKey;
}

const SERVICE_ACCOUNT_HINT =
  "Create a key on the service account's \"Keys\" tab, save it as .data/google-service-account.json, and share your calendar with its email address. See docs/GOOGLE_SETUP.md.";

export interface ServiceAccountOptions {
  /** Default <dataDir>/google-service-account.json. */
  keyPath?: string;
  /** Calendar REST base URL attached to the client (tests: the fake server). */
  calendarBaseUrl?: string;
}

/**
 * A client authenticated as the service account itself - no consent screen, and no token that
 * expires after seven days. It can reach only the calendars whose sharing settings name its
 * `client_email`, so revoking it is one click in that calendar's settings.
 */
export function loadServiceAccountClient(opts: ServiceAccountOptions = {}): JWT {
  const path = opts.keyPath ?? DEFAULT_SERVICE_ACCOUNT_PATH;
  const key = readServiceAccount(path);
  if (!key) throw new NotAuthorizedError(`No service-account key at ${path}.`, SERVICE_ACCOUNT_HINT);
  const client = new JWT({ email: key.client_email, key: key.private_key, scopes: [CALENDAR_EVENTS_SCOPE] });
  if (opts.calendarBaseUrl) withBaseUrl(client, opts.calendarBaseUrl);
  return client;
}

export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the URL is printed too */
  }
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3rem"><h1>${title}</h1><p>${body}</p></body>`;

/**
 * OAuth installed-app loopback flow with PKCE (S256). Starts a one-shot server on 127.0.0.1
 * (random free port), sends the user to Google's consent page (access_type=offline,
 * prompt=consent, scope calendar.app.created), exchanges the code and writes the token file.
 */
export async function authorize(opts: AuthorizeOptions): Promise<StoredToken> {
  const tokenPath = opts.tokenPath ?? DEFAULT_TOKEN_PATH;
  const state = randomBytes(16).toString("hex");
  const server = createServer();
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = makeClient(opts.clientId, opts.clientSecret, opts.endpoints, redirectUri);

  try {
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const url = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [CALENDAR_SCOPE],
      state,
      code_challenge: codeChallenge!,
      code_challenge_method: CodeChallengeMethod.S256,
      redirect_uri: redirectUri,
    });

    const codePromise = new Promise<string>((res, rej) => {
      const timer = setTimeout(
        () => rej(new Error("Timed out waiting for the Google redirect. Run `npm run auth` again.")),
        opts.timeoutMs ?? 5 * 60_000,
      );
      timer.unref();
      server.on("request", (req, resp) => {
        const u = new URL(req.url ?? "/", redirectUri);
        if (u.pathname !== "/") {
          resp.writeHead(404).end();
          return;
        }
        const error = u.searchParams.get("error");
        const code = u.searchParams.get("code");
        if (u.searchParams.get("state") !== state) {
          resp.writeHead(400, { "content-type": "text/html" }).end(page("Invalid state", "Close this tab and retry."));
          if (error || code) {
            clearTimeout(timer);
            rej(new Error("OAuth state mismatch (possible CSRF). Aborted."));
          }
          return;
        }
        if (error) {
          resp.writeHead(400, { "content-type": "text/html" }).end(page("Authorization failed", error));
          clearTimeout(timer);
          rej(new Error(`Google returned error=${error}`));
          return;
        }
        if (!code) {
          resp.writeHead(400).end();
          return;
        }
        resp
          .writeHead(200, { "content-type": "text/html", connection: "close" })
          .end(page("Daymark connected", "Google Calendar access granted. You can close this tab."));
        clearTimeout(timer);
        res(code);
      });
    });

    codePromise.catch(() => {}); // may settle while the browser step is still running; awaited below
    opts.onUrl?.(url);
    const ob = opts.openBrowser ?? true;
    if (typeof ob === "function") await ob(url);
    else if (ob) openInBrowser(url);

    const code = await codePromise;
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) {
      throw new Error("Google returned no refresh_token. Revoke the app at https://myaccount.google.com/permissions and retry.");
    }
    if (tokens.scope && !tokens.scope.split(" ").includes(CALENDAR_SCOPE)) {
      throw new Error(`The calendar permission was not granted (got scope "${tokens.scope}"). Retry and tick the calendar checkbox.`);
    }
    const stored: StoredToken = { ...tokens };
    writeToken(tokenPath, stored);
    return stored;
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

export interface LoadClientOptions {
  clientId?: string;
  clientSecret?: string;
  tokenPath?: string;
  endpoints?: OAuthEndpoints;
  /** Calendar REST base URL attached to the client (tests: the fake server). */
  calendarBaseUrl?: string;
  /**
   * Default: beside `tokenPath`. Present on disk = used in preference to OAuth.
   *
   * It is derived from `tokenPath` rather than from the data dir again, because "where this caller's
   * credentials live" is one fact. A caller that names a token path has said where its credentials
   * are; reading a key from somewhere else would hand it a credential it never asked for - which is
   * exactly what happened to the OAuth tests the first time this was wired up.
   */
  serviceAccountPath?: string;
  /** false: ignore a service-account key even if one is there (tests, and the OAuth CLI). */
  allowServiceAccount?: boolean;
}

/** The service-account key that goes with a given token path: the same directory, fixed name. */
function serviceAccountPathFor(opts: Pick<LoadClientOptions, "serviceAccountPath" | "tokenPath">): string {
  if (opts.serviceAccountPath) return opts.serviceAccountPath;
  if (opts.tokenPath) return resolve(dirname(opts.tokenPath), "google-service-account.json");
  return DEFAULT_SERVICE_ACCOUNT_PATH;
}

/** Which credential the planner will use, without constructing a client or touching the network. */
export function authMode(opts: Pick<LoadClientOptions, "serviceAccountPath" | "tokenPath" | "allowServiceAccount"> = {}):
  | { mode: "service-account"; clientEmail: string; path: string }
  | { mode: "oauth"; path: string }
  | { mode: "none" } {
  const saPath = serviceAccountPathFor(opts);
  if (opts.allowServiceAccount !== false) {
    const key = readServiceAccount(saPath);
    if (key) return { mode: "service-account", clientEmail: key.client_email, path: saPath };
  }
  const tokenPath = opts.tokenPath ?? DEFAULT_TOKEN_PATH;
  return readToken(tokenPath)?.refresh_token ? { mode: "oauth", path: tokenPath } : { mode: "none" };
}

/**
 * Returns an OAuth2Client authorized from the token file. Access tokens refresh automatically;
 * refreshed tokens are merged into the file. Throws NotAuthorizedError if there is no token
 * (or no refresh token) or no client credentials.
 * clientId/clientSecret default to GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
 */
export function loadClient(opts: LoadClientOptions = {}): OAuth2Client | JWT {
  // A service-account key wins when one is present: it is the credential that does not expire, and
  // someone who has gone to the trouble of installing one did not mean to keep using the OAuth token.
  if (opts.allowServiceAccount !== false) {
    const saPath = serviceAccountPathFor(opts);
    if (readServiceAccount(saPath)) return loadServiceAccountClient({ keyPath: saPath, ...(opts.calendarBaseUrl ? { calendarBaseUrl: opts.calendarBaseUrl } : {}) });
  }
  const tokenPath = opts.tokenPath ?? DEFAULT_TOKEN_PATH;
  const clientId = opts.clientId ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret = opts.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new NotAuthorizedError(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.",
      "Copy .env.example to .env, fill both values (docs/GOOGLE_SETUP.md), then run `npm run auth`.",
    );
  }
  const token = readToken(tokenPath);
  if (!token?.refresh_token) throw new NotAuthorizedError(`No Google token at ${tokenPath}.`);
  const client = makeClient(clientId, clientSecret, opts.endpoints);
  client.setCredentials(token);
  client.on("tokens", (fresh: Credentials) => {
    const current = readToken(tokenPath) ?? token;
    const merged: StoredToken = { ...current, ...fresh };
    if (!fresh.refresh_token) merged.refresh_token = current.refresh_token ?? token.refresh_token;
    try {
      writeToken(tokenPath, merged);
    } catch {
      /* a failed write only costs one extra refresh later */
    }
  });
  if (opts.calendarBaseUrl) withBaseUrl(client, opts.calendarBaseUrl);
  return client;
}
