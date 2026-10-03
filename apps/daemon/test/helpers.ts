import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NotAuthorizedError } from "@planner/calendar";
import { fixedClock, type ManualClock } from "@planner/store";
import { Daemon, type DaemonOptions } from "../src/daemon.ts";
import type { FiredNotification, NotificationSink } from "../src/sinks.ts";

export const TZ = "Africa/Tunis"; // UTC+01:00, no DST
export const DAY = "2026-09-28";
/** Small fixed task files (independent of the live resources/): see test/fixtures/resources. */
export const RESOURCES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/resources");
export const MIN = 60_000;

export const tempDir = () => mkdtempSync(join(tmpdir(), "planner-daemon-"));
export function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold WAL files briefly */
  }
}

export class MemorySink implements NotificationSink {
  readonly name = "memory";
  readonly calls: FiredNotification[] = [];
  notify(n: FiredNotification) {
    this.calls.push(n);
  }
  get records() {
    return this.calls.flatMap((c) => c.records);
  }
}

export const notAuthorized = () => {
  throw new NotAuthorizedError("No Google token (test)");
};

export interface TestDaemon {
  daemon: Daemon;
  clock: ManualClock;
  sink: MemorySink;
  logs: string[];
}

export function makeDaemon(dir: string, at: string, o: Partial<DaemonOptions> = {}): TestDaemon {
  const clock = fixedClock(at, TZ);
  const sink = new MemorySink();
  const logs: string[] = [];
  const daemon = new Daemon({
    clock,
    timeZone: TZ,
    dataDir: dir,
    horizon: 7,
    sinks: [sink],
    calendarClient: notAuthorized,
    log: (m) => logs.push(m),
    ...o,
    env: { PLANNER_RESOURCES_DIR: RESOURCES, ...o.env },
  });
  return { daemon, clock, sink, logs };
}

/** Advance the manual clock in `stepMs` steps up to `until`, ticking each time. */
export function runUntil(t: TestDaemon, until: string | number, stepMs = 30_000) {
  const end = typeof until === "number" ? until : Date.parse(until);
  while (t.clock.now() < end) {
    t.clock.advance(Math.min(stepMs, end - t.clock.now()));
    t.daemon.tick();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeoutMs: number, stepMs = 25): Promise<number> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`condition not met within ${timeoutMs} ms`);
    await sleep(stepMs);
  }
  return Date.now() - t0;
}
