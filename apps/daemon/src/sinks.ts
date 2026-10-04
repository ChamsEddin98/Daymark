/**
 * Notification sinks. A sink gets one call per instant (coalesced toast) with every boundary that
 * fired at it. Sinks must never throw into the scheduler: `deliver()` wraps every call.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import notifier from "node-notifier";
import type { NotificationRecord } from "@planner/store";
import type { ToastContent } from "./format.ts";

export interface FiredNotification {
  toast: ToastContent;
  /** One record per notice (as stored), plus the instant it was due. */
  records: (NotificationRecord & { due: string })[];
  /** Recorded but not shown: only sinks with `acceptsSilent` get it (the log). */
  silent?: boolean;
}

export interface NotificationSink {
  readonly name: string;
  notify(n: FiredNotification): void | Promise<void>;
  /** Receives silent notifications too (default false). */
  readonly acceptsSilent?: boolean;
  /** Extra JSONL entries (skipped boundaries, toast results). */
  note?(entry: Record<string, unknown>): void;
}

/** Calls every sink; errors (sync or async) are logged and swallowed. */
export function deliver(sinks: readonly NotificationSink[], n: FiredNotification, log: (msg: string) => void): void {
  for (const s of sinks) {
    if (n.silent && !s.acceptsSilent) continue;
    try {
      const r = s.notify(n);
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch((e) => log(`${s.name} sink failed: ${errMsg(e)}`));
    } catch (e) {
      log(`${s.name} sink failed: ${errMsg(e)}`);
    }
  }
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * JSONL at <dataDir>/notifications.log:
 * - one line per recorded boundary: { at, due, type, itemKey, title, toast: { title, message }, silent? };
 * - `{ at, skipped, from, to, reason }` for boundaries skipped during downtime / before a first start;
 * - `{ realAt, toastResult: { result, appID, ms }, itemKeys, title }` when a toast finishes (realAt: wall-clock time) (see ToastSink).
 */
export class LogSink implements NotificationSink {
  readonly name = "log";
  readonly acceptsSilent = true;
  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }
  notify(n: FiredNotification): void {
    const lines = n.records
      .map((r) => JSON.stringify({ at: r.at, due: r.due, type: r.type, itemKey: r.itemKey, title: r.title, toast: n.toast, ...(n.silent ? { silent: true } : {}) }))
      .join("\n");
    appendFileSync(this.file, lines + "\n", "utf8");
  }
  note(entry: Record<string, unknown>): void {
    appendFileSync(this.file, JSON.stringify(entry) + "\n", "utf8");
  }
}

/** Minimal surface of node-notifier used here (lets tests inject a failing notifier). */
export interface NotifierLike {
  notify(options: Record<string, unknown>, callback?: (err: Error | null, response: string, metadata?: unknown) => void): unknown;
}

export const DEFAULT_APP_ID = "Study Planner";

/** What happened to a toast, as far as SnoreToast tells. */
export type ToastResult = "shown" | "timeout" | "dismissed" | "activated" | "failed" | "unknown";

/** node-notifier's normalized SnoreToast response -> ToastResult. An empty response is `unknown`. */
export function toastResult(err: Error | null | undefined, response: unknown): ToastResult {
  if (err) return "failed";
  const r = typeof response === "string" ? response.toLowerCase().trim() : "";
  if (!r) return "unknown";
  if (r === "activate" || r === "activated" || r === "click" || r === "clicked") return "activated";
  if (r === "timeout" || r === "timedout") return "timeout";
  if (r === "dismissed") return "dismissed";
  return "shown";
}

export interface ToastOutcome {
  result: ToastResult;
  /** The appID used (undefined: SnoreToast's default). */
  appID: string | undefined;
  ms: number;
  error?: string;
}

export interface ToastSinkOptions {
  appID?: string;
  notifier?: NotifierLike;
  /** Give up waiting for SnoreToast after this long (result `unknown`). Default 60 s. */
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** Called when a toast finishes (the daemon logs it to stdout and the JSONL). */
  onResult?: (n: FiredNotification, outcome: ToastOutcome) => void;
  /** Called when the user clicks the toast (the daemon opens the web UI). */
  onClick?: (n: FiredNotification) => void;
  /** Consecutive definite failures before falling back to SnoreToast's default appID. Default 3. */
  fallbackAfter?: number;
}

/**
 * Native OS toast through node-notifier (SnoreToast on Windows 8+).
 *
 * `appID` is the AppUserModelID Windows shows as the toast's app name. Windows guarantees toasts
 * only for AUMIDs registered by a Start-menu shortcut, so main.ts registers "Study Planner" once
 * with `snoretoast -install` (see toastSetup.ts). Outcomes: activated / timeout / dismissed / shown
 * mean it was on screen; an empty response is `unknown` (SnoreToast reports nothing in some setups
 * even though the toast was shown), NOT a failure; `failed` means node-notifier returned an error.
 * A toast is never re-sent (it may already be on screen). After `fallbackAfter` (3) consecutive
 * failures with the custom appID, later toasts use SnoreToast's default appID.
 */
export class ToastSink implements NotificationSink {
  readonly name = "toast";
  private readonly impl: NotifierLike;
  private appID: string | undefined;
  private failures = 0;
  constructor(private readonly opts: ToastSinkOptions = {}) {
    this.impl = opts.notifier ?? (process.platform === "win32" ? new notifier.WindowsToaster({ withFallback: false }) : notifier);
    this.appID = opts.appID ?? DEFAULT_APP_ID;
  }

  /** The appID in use (undefined: SnoreToast's default, after a fallback). */
  get currentAppID(): string | undefined {
    return this.appID;
  }

  async notify(n: FiredNotification): Promise<void> {
    const appID = this.appID;
    const outcome = await this.show(n, appID);
    try {
      this.opts.onResult?.(n, outcome);
    } catch {
      /* reporting must not fail the sink */
    }
    if (outcome.result === "activated") {
      try {
        this.opts.onClick?.(n);
      } catch {
        /* ignore */
      }
    }
    if (outcome.result === "failed") {
      this.failures++;
      if (appID !== undefined && this.failures >= (this.opts.fallbackAfter ?? 3) && this.appID === appID) {
        (this.opts.log ?? (() => {}))(`${this.failures} toasts in a row failed with appID "${appID}"; using SnoreToast's default appID from now on`);
        this.appID = undefined;
        this.failures = 0;
      }
      throw new Error(`toast failed: ${outcome.error ?? "unknown error"}`);
    }
    this.failures = 0;
  }

  private show(n: FiredNotification, appID: string | undefined): Promise<ToastOutcome> {
    const t0 = Date.now();
    return new Promise<ToastOutcome>((resolve) => {
      let settled = false;
      const done = (result: ToastResult, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ result, appID, ms: Date.now() - t0, ...(error ? { error } : {}) });
      };
      // SnoreToast returns when the toast is dismissed or times out (~5-25 s); never wait forever.
      const timer = setTimeout(() => done("unknown"), this.opts.timeoutMs ?? 60_000);
      timer.unref();
      try {
        const options: Record<string, unknown> = { title: n.toast.title, message: n.toast.message, wait: false, sound: true };
        if (appID) options.appID = appID;
        this.impl.notify(options, (err, response) => done(toastResult(err, response), err ? errMsg(err) : undefined));
      } catch (e) {
        done("failed", errMsg(e));
      }
    });
  }
}

export type NotifyMode = "off" | "log" | "toast";

/** PLANNER_NOTIFY: "off", "log", "toast" or a comma list ("toast,log", the default). */
export function parseNotifyModes(value: string | undefined): Set<NotifyMode> {
  const v = (value ?? "toast,log").trim().toLowerCase();
  const out = new Set<NotifyMode>();
  for (const p of v.split(/[,+\s]+/).filter(Boolean)) {
    if (p === "off" || p === "none") return new Set();
    if (p !== "log" && p !== "toast") throw new Error(`PLANNER_NOTIFY must be off, log, toast or "toast,log"; got "${value}"`);
    out.add(p);
  }
  return out;
}

export function sinksFromEnv(
  env: Record<string, string | undefined>,
  dataDir: string,
  log: (msg: string) => void = () => {},
  onClick?: (n: FiredNotification) => void,
): NotificationSink[] {
  const modes = parseNotifyModes(env.PLANNER_NOTIFY);
  const sinks: NotificationSink[] = [];
  const logSink = modes.has("log") ? new LogSink(join(dataDir, "notifications.log")) : undefined;
  if (modes.has("toast"))
    sinks.push(
      new ToastSink({
        appID: env.PLANNER_TOAST_APPID || DEFAULT_APP_ID,
        log,
        onClick,
        onResult: (n, o) => {
          const keys = n.records.map((r) => r.itemKey);
          log(`toast ${o.result} (appID ${o.appID ?? "SnoreToast default"}, ${o.ms} ms): ${n.toast.title}${o.error ? ` — ${o.error}` : ""}`);
          logSink?.note({ realAt: new Date().toISOString(), toastResult: { result: o.result, appID: o.appID ?? null, ms: o.ms, ...(o.error ? { error: o.error } : {}) }, itemKeys: keys, title: n.toast.title });
        },
      }),
    );
  if (logSink) sinks.push(logSink);
  return sinks;
}
