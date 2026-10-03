/**
 * The notifier daemon: a tick loop over an injectable clock.
 *
 * Every tick: midnight rollover check (PlanService.ensureCurrent, task files re-read first), boundary
 * scan (fires notifications), plan revision check (logging only; items are re-read every scan),
 * calendar sync retry. Ticks are ~1 s of simulated time; the real sleep is that divided by the clock
 * speed, clamped to [minSleepMs, maxSleepMs] (never a busy loop, and ≤ 1 s real so plan changes are
 * picked up within 2 s).
 */
import { join } from "node:path";
import {
  PlanService,
  PlannerStore,
  clockFromEnv,
  calendarIdFromEnv,
  dataDir as defaultDataDir,
  loadResources,
  resourcesDir as defaultResourcesDir,
  timeZoneFromEnv,
  type Clock,
} from "@planner/store";
import { BoundaryScanner, DEFAULT_GRACE_MS } from "./scanner.ts";
import { openUrl, webUrl } from "./toastSetup.ts";
import { errMsg, sinksFromEnv, type FiredNotification, type NotificationSink } from "./sinks.ts";
import { SyncRetrier, defaultClientFactory, type ClientFactory } from "./sync.ts";

export interface DaemonOptions {
  env?: Record<string, string | undefined>;
  clock?: Clock;
  timeZone?: string;
  dataDir?: string;
  /** The calendar to sync into. Default: CALENDAR_ID / PLANNER_CALENDAR_ID (same as the API). */
  calendarId?: string;
  resourcesDir?: string;
  horizon?: number;
  /** Default: from PLANNER_NOTIFY. */
  sinks?: NotificationSink[];
  graceMs?: number;
  /** Calendar client factory. Default: loadClient() with <dataDir>/google-token.json. */
  calendarClient?: ClientFactory;
  syncIntervalMs?: number;
  /** Simulated ms per tick (default 1000). */
  tickSimMs?: number;
  minSleepMs?: number;
  maxSleepMs?: number;
  log?: (msg: string) => void;
  /** Called after each tick that delivered notifications (tests). */
  onFired?: (n: FiredNotification[]) => void;
}

export class Daemon {
  readonly store: PlannerStore;
  readonly service: PlanService;
  readonly scanner: BoundaryScanner;
  readonly sync: SyncRetrier;
  readonly clock: Clock;
  private envClock: Clock | undefined;
  private restartClock: () => void = () => {};
  private clockRestarted = false;

  /** Restart a PLANNER_CLOCK compressed clock at its `start` (once; start() calls it too). */
  resetClock(): void {
    if (this.clockRestarted) return;
    this.clockRestarted = true;
    this.restartClock();
  }
  readonly sinks: NotificationSink[];
  readonly resourcesDir: string;
  private readonly log: (msg: string) => void;
  private day: string;
  private rev: number;
  private paused: boolean;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly o: DaemonOptions = {}) {
    const env = o.env ?? process.env;
    const timeZone = o.timeZone ?? timeZoneFromEnv(env);
    if (o.clock) this.clock = o.clock;
    else {
      // A compressed clock from PLANNER_CLOCK restarts at `start` when the loop starts (start()), so
      // the time spent building the plan does not eat into the first minutes of the day.
      this.envClock = clockFromEnv(env, timeZone);
      const self = this;
      this.clock = {
        get kind() {
          return self.envClock!.kind;
        },
        get speed() {
          return self.envClock!.speed;
        },
        now: () => this.envClock!.now(),
      };
      this.restartClock = () => {
        if (this.envClock!.kind === "compressed") this.envClock = clockFromEnv(env, timeZone);
      };
    }
    const dir = o.dataDir ?? defaultDataDir(env);
    const calendarId = o.calendarId ?? calendarIdFromEnv(env);
    this.resourcesDir = o.resourcesDir ?? defaultResourcesDir(env);
    const horizon = o.horizon ?? (env.PLANNER_HORIZON_DAYS ? Number(env.PLANNER_HORIZON_DAYS) : 7);
    this.log = o.log ?? (() => {});
    this.store = new PlannerStore({ dir });
    const loaded = loadResources(this.resourcesDir);
    if (loaded.errors.length) this.log(`${loaded.errors.length} task file error(s); the API reports them (npm run tasks:check)`);
    this.service = new PlanService({ store: this.store, clock: this.clock, timeZone, horizon, files: loaded.files });
    this.sinks = o.sinks ?? sinksFromEnv(env, dir, this.log, () => openUrl(webUrl(dir, env)));
    // Grace: 2 min simulated, and at least 2 s of real time on a compressed clock (GC pauses, disk).
    const graceMs = o.graceMs ?? Math.max(DEFAULT_GRACE_MS, 2000 * (this.clock.speed || 0));
    this.scanner = new BoundaryScanner({ store: this.store, clock: this.clock, timeZone, sinks: this.sinks, graceMs, log: this.log });
    this.sync = new SyncRetrier({
      store: this.store,
      service: this.service,
      factory: o.calendarClient ?? defaultClientFactory(dir),
      ...(calendarId ? { calendarId } : {}),
      intervalMs: o.syncIntervalMs,
      log: this.log,
    });
    const regenerated = this.service.ensureCurrent();
    if (regenerated) this.log(`plan materialized: ${regenerated[0]} .. ${regenerated.at(-1)}`);
    this.day = this.service.today();
    this.rev = this.store.planRev();
    this.paused = this.store.freshPausedSince(this.clock.now()) !== undefined;
  }

  /** Normal real ms between ticks: ~1 s simulated, clamped to [minSleepMs, maxSleepMs]. */
  tickMs(): number {
    const hi = this.o.maxSleepMs ?? 1000;
    const speed = this.clock.speed;
    if (!(speed > 0)) return hi;
    return Math.min(hi, Math.max(this.o.minSleepMs ?? 20, (this.o.tickSimMs ?? 1000) / speed));
  }

  /**
   * Real ms to sleep before the next tick: ~1 s of simulated time clamped to [minSleepMs, maxSleepMs],
   * but never past the next boundary in the store (so a fast compressed clock still fires on time).
   */
  sleepMs(): number {
    const normal = this.tickMs();
    const speed = this.clock.speed;
    if (!(speed > 0)) return normal;
    try {
      // Paused: the boundaries ahead will not fire, so there is nothing to wake up early for (P8).
      if (this.store.freshPausedSince(this.clock.now()) !== undefined) return normal;
      const now = this.clock.now();
      const next = this.scanner.nextBoundaryAfter(now, normal * speed);
      if (next !== undefined) return Math.max(1, Math.min(normal, Math.ceil((next - now) / speed) + 1));
    } catch {
      /* store busy: use the normal tick */
    }
    return normal;
  }

  /** One iteration. Never throws. */
  tick(): FiredNotification[] {
    try {
      this.rollover();
      const fired = this.scanner.scan();
      // Pause and resume bump `planRev` like any other write, so this is noticed within one tick; the
      // scanner reads the pause itself, and a resume stays quiet (no toast of its own).
      const paused = this.store.freshPausedSince(this.clock.now()) !== undefined;
      if (paused !== this.paused) {
        this.paused = paused;
        this.log(paused ? "plan paused: no boundary fires until it is resumed" : "plan resumed: boundaries follow the new times");
      }
      const rev = this.store.planRev();
      if (rev !== this.rev) {
        this.rev = rev;
        this.log(`plan changed (rev ${rev})`);
      }
      void this.sync.maybeRetry();
      if (fired.length) this.o.onFired?.(fired);
      return fired;
    } catch (e) {
      this.log(`tick failed: ${errMsg(e)}`);
      return [];
    }
  }

  /** Local midnight: re-read task files, regenerate from the new day, sync right away. */
  private rollover(): void {
    const today = this.service.today();
    if (today === this.day) return;
    const prev = this.day;
    this.day = today;
    const loaded = loadResources(this.resourcesDir);
    if (!loaded.errors.length) this.service.setFiles(loaded.files);
    const dates = this.service.ensureCurrent();
    this.log(`rollover ${prev} -> ${today}: ${dates ? `regenerated ${dates[0]} .. ${dates.at(-1)}` : "already done by the API"}`);
    this.store.updateSyncState({ pending: true });
    void this.sync.runNow();
  }

  start(): void {
    if (this.running) return;
    this.resetClock();
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        this.tick();
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          this.timer = setTimeout(resolve, this.sleepMs());
        });
      }
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    await this.loop;
    await this.sync.idle().catch(() => {});
    this.store.close();
  }
}
