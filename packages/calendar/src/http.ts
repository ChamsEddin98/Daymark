import { CalendarApiError, NotAuthorizedError } from "./errors.ts";

export const DEFAULT_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";

/** Minimal shape needed from google-auth-library's OAuth2Client (its `.request()`). */
export interface RequestClient {
  request<T = unknown>(opts: {
    url: string;
    method?: string;
    params?: Record<string, unknown>;
    data?: unknown;
    retry?: boolean;
    paramsSerializer?: (params: Record<string, unknown>) => string;
  }): Promise<{ data: T; status: number }>;
}

export interface RetryOptions {
  /** Total attempts including the first. Default 5. */
  maxTries?: number;
  /** First backoff delay in ms. Default 500. Doubles per retry; jitter picks a value in [d/2, d]. */
  baseDelayMs?: number;
  /** Upper bound for a single delay. Default 32 000 ms. */
  maxDelayMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export interface CalendarOptions {
  /** Calendar REST v3 base URL. Default https://www.googleapis.com/calendar/v3 (tests point this at the fake). */
  baseUrl?: string;
  retry?: RetryOptions;
}

const BASE_URL = Symbol.for("planner.calendar.baseUrl");

/** Attach a Calendar base URL to a client so every call made with it uses that URL. */
export function withBaseUrl<C extends object>(client: C, baseUrl: string): C {
  (client as Record<symbol, unknown>)[BASE_URL] = baseUrl.replace(/\/+$/, "");
  return client;
}

/** Precedence: opts.baseUrl, then withBaseUrl() tag, then PLANNER_GOOGLE_CALENDAR_BASE_URL, then Google. */
export function resolveBaseUrl(client: object, opts?: CalendarOptions): string {
  const tagged = (client as Record<symbol, unknown>)[BASE_URL];
  return (
    opts?.baseUrl ??
    (typeof tagged === "string" ? tagged : undefined) ??
    process.env.PLANNER_GOOGLE_CALENDAR_BASE_URL ??
    DEFAULT_CALENDAR_BASE_URL
  ).replace(/\/+$/, "");
}

/** Serialize params, repeating keys for array values (privateExtendedProperty may repeat). */
export function serializeParams(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) sp.append(k, String(x));
    else sp.append(k, String(v));
  }
  return sp.toString();
}

interface ErrorInfo {
  status?: number;
  reason?: string;
  message: string;
  retryAfterMs?: number;
  oauthError?: string;
}

function headerGet(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const rec = headers as Record<string, string>;
  return rec[name] ?? rec[name.toLowerCase()];
}

function errorInfo(err: unknown): ErrorInfo {
  const e = err as {
    status?: number;
    message?: string;
    response?: { status?: number; data?: unknown; headers?: unknown };
  };
  const status = e.response?.status ?? (typeof e.status === "number" ? e.status : undefined);
  const data = e.response?.data as
    | { error?: { message?: string; errors?: { reason?: string }[] } | string; error_description?: string }
    | undefined;
  let reason: string | undefined;
  let message = e.message ?? String(err);
  let oauthError: string | undefined;
  if (data && typeof data === "object") {
    if (typeof data.error === "string") {
      oauthError = data.error;
      message = `${data.error}${data.error_description ? `: ${data.error_description}` : ""}`;
    } else if (data.error) {
      reason = data.error.errors?.[0]?.reason;
      message = data.error.message ?? message;
    }
  }
  if (!oauthError && /invalid_grant/.test(message)) oauthError = "invalid_grant";
  const ra = headerGet(e.response?.headers, "retry-after");
  let retryAfterMs: number | undefined;
  if (ra) {
    const secs = Number(ra);
    retryAfterMs = Number.isFinite(secs) ? secs * 1000 : Math.max(0, Date.parse(ra) - Date.now());
  }
  return { status, reason, message, retryAfterMs, oauthError };
}

const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"]);

function isRetryable(info: ErrorInfo): boolean {
  if (info.status === undefined) return true; // network-level failure (ECONNRESET, fetch failed, ...)
  if (info.status === 429 || info.status >= 500) return true;
  // Google Calendar also signals rate limits with 403 + reason.
  return info.status === 403 && info.reason !== undefined && RATE_REASONS.has(info.reason);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface CallResult<T> {
  status: number;
  data: T;
}

/**
 * One Calendar API call with retry on 429 / 5xx / rate-limit 403 / network errors
 * (exponential backoff with jitter, honours Retry-After, at most `maxTries` attempts).
 * Statuses listed in `okStatuses` (e.g. 404/410 on delete) are returned instead of thrown.
 */
export async function call<T>(
  client: RequestClient,
  req: { method: string; path: string; params?: Record<string, unknown>; data?: unknown },
  opts?: CalendarOptions & { okStatuses?: number[] },
): Promise<CallResult<T>> {
  const baseUrl = resolveBaseUrl(client, opts);
  const maxTries = opts?.retry?.maxTries ?? 5;
  const baseDelay = opts?.retry?.baseDelayMs ?? 500;
  const maxDelay = opts?.retry?.maxDelayMs ?? 32_000;
  const sleep = opts?.retry?.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await client.request<T>({
        url: baseUrl + req.path,
        method: req.method,
        params: req.params,
        data: req.data,
        retry: false,
        paramsSerializer: serializeParams,
      });
      return { status: res.status, data: res.data };
    } catch (err) {
      if (err instanceof NotAuthorizedError) throw err;
      const info = errorInfo(err);
      if (info.oauthError === "invalid_grant" || info.oauthError === "unauthorized_client") {
        throw new NotAuthorizedError(
          `Google refused the stored refresh token (${info.message}). It was revoked or has expired.`,
          "Run `npm run auth` again. If this recurs every 7 days, switch the OAuth app to 'In production' (docs/GOOGLE_SETUP.md).",
        );
      }
      if (info.status !== undefined && opts?.okStatuses?.includes(info.status)) {
        return { status: info.status, data: undefined as T };
      }
      if (info.status === 401) {
        throw new NotAuthorizedError(`Google Calendar returned 401: ${info.message}`);
      }
      if (attempt < maxTries && isRetryable(info)) {
        const exp = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
        const jittered = exp / 2 + Math.random() * (exp / 2);
        await sleep(Math.min(maxDelay, Math.max(jittered, info.retryAfterMs ?? 0)));
        continue;
      }
      throw new CalendarApiError(
        `${req.method} ${req.path} failed${info.status ? ` (${info.status})` : ""}: ${info.message}`,
        info.status,
        info.reason,
      );
    }
  }
}

/** Encode a calendar or event id for use in a URL path segment. */
export const seg = (s: string) => encodeURIComponent(s);
