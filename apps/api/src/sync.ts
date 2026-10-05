/**
 * Calendar sync: a debounced background sync after every mutation (failures are recorded, never
 * thrown at the caller) and an immediate sync for POST /sync (failures are thrown).
 */
import { CalendarApiError, CalendarNotFoundError, NotAuthorizedError, listPlannerEvents, syncPlan, type ReconcileOptions, type ReconcileResult, type RequestClient } from "@planner/calendar";
import { addDays, zonedMs, toIso } from "@planner/core";
import { calendarView, type PlanService, type PlannerStore } from "@planner/store";
import type { EventBus } from "./sse.ts";

export type ClientFactory = () => RequestClient;

export interface SyncOutcome extends ReconcileResult {
  calendarId: string;
  window: { from: string; to: string };
}

export class SyncManager {
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private client: RequestClient | undefined;
  private closed = false;

  constructor(
    private readonly store: PlannerStore,
    private readonly service: PlanService,
    private readonly bus: EventBus,
    private readonly factory: ClientFactory,
    readonly debounceMs = 2000,
    private readonly log: (msg: string) => void = () => {},
    private readonly calendarOptions: ReconcileOptions = {},
    /** A calendar supplied by the owner (CALENDAR_ID); undefined means the planner creates its own. */
    private readonly calendarId: string | undefined = undefined,
  ) {}

  /** A client, or throws NotAuthorizedError. Cached once created. */
  getClient(): RequestClient {
    if (!this.client) this.client = this.factory();
    return this.client;
  }

  authorized(): boolean {
    try {
      this.getClient();
      return true;
    } catch (e) {
      if (e instanceof NotAuthorizedError) return false;
      throw e;
    }
  }

  /** Queue a sync of today..horizon end in `debounceMs` (restarts the timer). */
  queue(): void {
    if (this.closed) return;
    this.store.updateSyncState({ pending: true });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.run().catch(() => {
        /* recorded in sync state */
      });
    }, this.debounceMs);
    this.timer.unref();
  }

  get queued(): boolean {
    return !!this.timer;
  }

  /** Wait for a queued and any running sync (tests, shutdown). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      await this.run().catch(() => {});
    }
    await this.chain.catch(() => {});
  }

  private windowFor(fromDate: string, toDate: string) {
    const tz = this.service.timeZone;
    return { from: toIso(zonedMs(fromDate, 0, tz), tz), to: toIso(zonedMs(addDays(toDate, 1), 0, tz), tz) };
  }

  /** Sync the window now (serialized with other syncs). Records the outcome; rethrows failures. */
  run(fromDate = this.service.today(), toDate = this.service.horizonEnd()): Promise<SyncOutcome> {
    const job = this.chain.then(() => this.doRun(fromDate, toDate));
    this.chain = job.catch(() => {});
    return job;
  }

  private async doRun(fromDate: string, toDate: string): Promise<SyncOutcome> {
    const at = this.service.nowIso();
    this.store.updateSyncState({ lastAttemptAt: at });
    try {
      const client = this.getClient();
      // A displaced checked item keeps its last real slot in Google (never moved to ~06:00, never deleted).
      const window = this.windowFor(fromDate, toDate);
      const items = this.store.getItemsBetween(fromDate, toDate, "timeline");
      // Checked items (off the timeline) are never new placements: only one that already has an event
      // is passed, at its last timeline slot, so its event is neither patched nor deleted.
      const checked = this.store.getItemsBetween(fromDate, toDate, "checked");
      const calendarId = this.store.getCalendarId();
      if (checked.length && calendarId) {
        const existing = await listPlannerEvents(client, calendarId, window, this.calendarOptions).catch((e) => {
          if (e instanceof CalendarNotFoundError) return [];
          throw e;
        });
        const keys = new Set(existing.map((e) => e.plannerKey));
        for (const c of checked) if (keys.has(c.key)) items.push(calendarView(c));
      }
      const r = await syncPlan(client, {
        items,
        window,
        timeZone: this.service.timeZone,
        ...(this.calendarId ? { calendarId: this.calendarId } : {}),
        stateGet: () => this.store.getCalendarId(),
        stateSet: (id) => this.store.setCalendarId(id),
        // Only reaches Google for a calendar the planner owns; ignored when calendarId is set.
        summary: this.service.calendarName(),
      }, { ...this.calendarOptions, reminders: this.service.calendarReminders() });
      const counts = { inserted: r.inserted, patched: r.patched, deleted: r.deleted, unchanged: r.unchanged };
      const failed = r.errors.length > 0;
      const state = this.store.updateSyncState({
        lastSyncAt: at,
        lastResult: counts,
        pending: failed,
        lastError: failed ? { code: "CALENDAR_ERROR", message: `${r.errors.length} event write(s) failed: ${r.errors[0]!.message}`, at } : null,
      });
      this.bus.publish("sync", { ok: !failed, ...state, window });
      if (failed) this.log(`calendar sync: ${r.errors.length} event errors`);
      return { ...r, window };
    } catch (e) {
      const code = e instanceof NotAuthorizedError ? "CALENDAR_NOT_AUTHORIZED" : "CALENDAR_ERROR";
      const message = e instanceof Error ? e.message : String(e);
      if (!(e instanceof NotAuthorizedError)) this.client = undefined; // rebuild on next attempt
      const state = this.store.updateSyncState({ pending: true, lastError: { code, message, at } });
      this.bus.publish("sync", { ok: false, ...state });
      this.log(`calendar sync failed: ${code}: ${message}`);
      throw e;
    }
  }

  async listEvents(fromDate: string, toDate: string) {
    const client = this.getClient();
    const calendarId = this.calendarId ?? this.store.getCalendarId();
    if (!calendarId) return [];
    return listPlannerEvents(client, calendarId, this.windowFor(fromDate, toDate), this.calendarOptions);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export { CalendarApiError, NotAuthorizedError };
