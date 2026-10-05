/**
 * Calendar sync retries from the daemon.
 *
 * The API syncs after each of its own writes (debounced) and records the outcome in the store's
 * sync state. When that state says `pending` or carries `lastError`, the daemon retries with a
 * fixed real-time backoff (default 5 min), and immediately after a midnight rollover.
 *
 * The outcome is recorded exactly like apps/api/src/sync.ts `SyncManager.doRun` does (same fields,
 * same error codes). That class needs the API's SSE bus and lives in another app, so its ~30 lines
 * of recording logic are duplicated here on purpose; keep the two in step.
 */
import { NotAuthorizedError, loadClient, syncPlan, type ReconcileOptions, type RequestClient } from "@planner/calendar";
import { calendarIdFromEnv } from "@planner/store";
import { join } from "node:path";
import { addDays, toIso, zonedMs } from "@planner/core";
import type { PlanService, PlannerStore } from "@planner/store";
import { errMsg } from "./sinks.ts";

export type ClientFactory = () => RequestClient;

export interface SyncRetrierOptions {
  store: PlannerStore;
  service: PlanService;
  /** Default: a service-account key or the OAuth token in <dataDir>. */
  factory: ClientFactory;
  /**
   * The calendar to sync into. Default: CALENDAR_ID / PLANNER_CALENDAR_ID. It has to be the same
   * answer the API gets, which is why both read `calendarIdFromEnv` rather than each deciding.
   */
  calendarId?: string;
  /** Real ms between retries. Default 5 min. */
  intervalMs?: number;
  /**
   * Leave a sync alone while the API may still be running it: skip when its lastAttemptAt is
   * less than this many real ms ago (converted with the clock speed). Default 30 s.
   */
  apiQuietMs?: number;
  realNow?: () => number;
  log?: (msg: string) => void;
  calendarOptions?: ReconcileOptions;
}

export type SyncAttempt = "ok" | "failed" | "not_authorized";

export class SyncRetrier {
  private lastTry = -Infinity;
  private running: Promise<SyncAttempt> | undefined;
  private client: RequestClient | undefined;
  private authLogged = false;
  private readonly realNow: () => number;
  private readonly log: (msg: string) => void;
  readonly intervalMs: number;

  constructor(private readonly o: SyncRetrierOptions) {
    this.realNow = o.realNow ?? Date.now;
    this.log = o.log ?? (() => {});
    this.intervalMs = o.intervalMs ?? 5 * 60_000;
  }

  /** True when the store says the calendar is behind. */
  needed(): boolean {
    const s = this.o.store.getSyncState();
    return s.pending || !!s.lastError;
  }

  /** Called every tick: retries if needed and the backoff has elapsed. */
  maybeRetry(): Promise<SyncAttempt> | undefined {
    if (this.running || !this.needed()) return undefined;
    if (this.realNow() - this.lastTry < this.intervalMs) return undefined;
    const s = this.o.store.getSyncState();
    if (s.lastAttemptAt && !s.lastError) {
      // pending with no error: the API has probably queued/started its own sync; give it time.
      const speed = this.o.service.clock.speed || 1;
      const agoReal = (this.o.service.nowMs() - Date.parse(s.lastAttemptAt)) / speed;
      if (agoReal >= 0 && agoReal < (this.o.apiQuietMs ?? 30_000)) return undefined;
    }
    return this.runNow();
  }

  /** Sync now (after a rollover). Never throws; the outcome is in the store's sync state. */
  runNow(): Promise<SyncAttempt> {
    if (this.running) return this.running;
    this.lastTry = this.realNow();
    const p = this.attempt().finally(() => {
      this.running = undefined;
    });
    this.running = p;
    return p;
  }

  /** Waits for a running attempt (shutdown, tests). */
  async idle(): Promise<void> {
    await this.running;
  }

  private async attempt(): Promise<SyncAttempt> {
    const { store, service } = this.o;
    const at = service.nowIso();
    store.updateSyncState({ lastAttemptAt: at });
    try {
      if (!this.client) this.client = this.o.factory();
      const fromDate = service.today();
      const toDate = service.horizonEnd();
      const tz = service.timeZone;
      const window = { from: toIso(zonedMs(fromDate, 0, tz), tz), to: toIso(zonedMs(addDays(toDate, 1), 0, tz), tz) };
      const r = await syncPlan(
        this.client,
        {
          items: store.getItemsBetween(fromDate, toDate),
          window,
          timeZone: tz,
          ...(this.o.calendarId ? { calendarId: this.o.calendarId } : {}),
          stateGet: () => store.getCalendarId(),
          stateSet: (id) => store.setCalendarId(id),
          // Only reaches Google for a calendar the planner owns; ignored when calendarId is set.
          summary: service.calendarName(),
        },
        { ...(this.o.calendarOptions ?? {}), reminders: service.calendarReminders() },
      );
      const failed = r.errors.length > 0;
      store.updateSyncState({
        lastSyncAt: at,
        lastResult: { inserted: r.inserted, patched: r.patched, deleted: r.deleted, unchanged: r.unchanged },
        pending: failed,
        lastError: failed ? { code: "CALENDAR_ERROR", message: `${r.errors.length} event write(s) failed: ${r.errors[0]!.message}`, at } : null,
      });
      this.authLogged = false;
      this.log(
        failed
          ? `calendar sync: ${r.errors.length} event errors`
          : `calendar sync ok (+${r.inserted} ~${r.patched} -${r.deleted} =${r.unchanged})`,
      );
      return failed ? "failed" : "ok";
    } catch (e) {
      const notAuth = e instanceof NotAuthorizedError;
      const code = notAuth ? "CALENDAR_NOT_AUTHORIZED" : "CALENDAR_ERROR";
      if (!notAuth) this.client = undefined; // rebuild on next attempt
      store.updateSyncState({ pending: true, lastError: { code, message: errMsg(e), at } });
      if (!notAuth) this.log(`calendar sync failed: ${code}: ${errMsg(e)} (retry in ${Math.round(this.intervalMs / 60_000)} min)`);
      else if (!this.authLogged) {
        this.authLogged = true;
        this.log(`calendar not authorized (${errMsg(e)}); run \`npm run auth\`. Retrying quietly every ${Math.round(this.intervalMs / 60_000)} min.`);
      }
      return notAuth ? "not_authorized" : "failed";
    }
  }
}

/** A client from whatever credential `<dataDir>` holds: a service-account key wins over the token. */
export function defaultClientFactory(dataDir: string): ClientFactory {
  return () => loadClient({ tokenPath: join(dataDir, "google-token.json"), serviceAccountPath: join(dataDir, "google-service-account.json") });
}
