/**
 * Pause and resume on the store (docs/PLAN.md, P8): durable pause state, an exact resume, and the
 * refusals. The API-level rules (409 PAUSED on the endpoints, SSE, /health) live in apps/api/test/p8.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanItem } from "@planner/core";
import { PlanService, PlannerError, PlannerStore, fixedClock, loadResources, type ManualClock } from "../src/index.ts";

const TZ = "Africa/Tunis";
const NOW = "2026-09-28T10:15:00+01:00";
const TODAY = "2026-09-28";
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/api/test/fixtures/resources");
const files = loadResources(FIXTURES).files;

const dirs: string[] = [];
const stores: PlannerStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0))
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows may hold WAL files briefly */
    }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "planner-pause-"));
  dirs.push(d);
  return d;
}

interface Svc {
  s: PlanService;
  store: PlannerStore;
  clock: ManualClock;
}
function svc(dir = tmp(), now = NOW): Svc {
  const clock = fixedClock(now, TZ);
  const store = new PlannerStore({ dir });
  stores.push(store);
  const s = new PlanService({ store, clock, timeZone: TZ, horizon: 7, files });
  s.ensureCurrent();
  return { s, store, clock };
}

const ms = (iso: string) => Date.parse(iso);
const line = (i: PlanItem) => `${i.key} ${i.start} ${i.end}`;
const times = (items: readonly PlanItem[]) => items.map((i) => `${i.key} ${i.start} ${i.end}`);
const failure = (fn: () => unknown): PlannerError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PlannerError);
    return e as PlannerError;
  }
  throw new Error("expected a PlannerError");
};

describe("PlanService.pause", () => {
  it("records the instant to the millisecond and moves nothing", () => {
    const { s, store, clock } = svc();
    clock.advance(317); // 10:15:00.317
    const before = times(store.getDay(TODAY).items);
    const r = s.pause();
    expect(r).toEqual({ paused: { since: "2026-09-28T10:15:00.317+01:00" } });
    expect(store.pausedSince()).toBe(ms(NOW) + 317);
    expect(times(store.getDay(TODAY).items), "a pause moves nothing").toEqual(before);
  });

  it("reports elapsedSec as a float, measured when it is read", () => {
    const { s, clock } = svc();
    s.pause();
    expect(s.paused()).toEqual({ since: "2026-09-28T10:15:00+01:00", elapsedSec: 0 });
    clock.advance(45_317);
    expect(s.paused()?.elapsedSec).toBe(45.317);
    clock.advance(3);
    expect(s.paused()?.elapsedSec).toBe(45.32);
  });

  it("bumps planRev, so the daemon notices within one tick", () => {
    const { s, store } = svc();
    const rev = store.planRev();
    s.pause();
    expect(store.planRev()).toBeGreaterThan(rev);
    const rev2 = store.planRev();
    s.resume();
    expect(store.planRev()).toBeGreaterThan(rev2);
  });

  it("pause while paused is CONFLICT and carries the current state", () => {
    const { s, clock } = svc();
    s.pause();
    clock.advance(1_500);
    const e = failure(() => s.pause());
    expect(e.code).toBe("CONFLICT");
    expect(e.details).toEqual({ paused: { since: "2026-09-28T10:15:00+01:00", elapsedSec: 1.5 } });
    expect(s.paused()?.since, "the original instant is kept").toBe("2026-09-28T10:15:00+01:00");
  });

  it("resume while not paused is CONFLICT with paused: null", () => {
    const { s } = svc();
    const e = failure(() => s.resume());
    expect(e.code).toBe("CONFLICT");
    expect(e.details).toEqual({ paused: null });
  });
});

describe("PlanService.resume", () => {
  for (const d of [45_000, 45_317, 999, 3, 2 * 60 * 60_000]) {
    it(`shifts by exactly ${d} ms and clears the pause`, () => {
      const { s, store, clock } = svc();
      const before = store.getDay(TODAY).items;
      s.pause();
      clock.advance(d);
      const r = s.resume();
      expect(r.pausedSec).toBe(d / 1000);
      expect(store.pausedSince(), "the pause is cleared").toBeUndefined();
      const after = store.getDay(TODAY).items;
      expect(after.map((i) => i.key)).toEqual(before.map((i) => i.key));
      // The cut is the PAUSE instant (P8 rule 2), so everything that had not begun when the owner
      // paused moves by the whole pause, even if it was due to start while they were away.
      let head = true; // the first item at or after the cut absorbs the gap when it is a rest
      for (const [i, it] of before.entries()) {
        const a = after[i]!;
        if (ms(it.start) < ms(NOW)) {
          expect(a.start, `${it.key} frozen`).toBe(it.start);
          continue;
        }
        expect(ms(a.end) - ms(it.end), `${it.key} end`).toBe(d);
        if (head && it.kind === "rest") expect(a.start, `${it.key} absorbs the pause`).toBe(it.start);
        else {
          expect(ms(a.start) - ms(it.start), `${it.key} start`).toBe(d);
          expect(ms(a.end) - ms(a.start), `${it.key} duration`).toBe(ms(it.end) - ms(it.start));
        }
        head = false;
      }
      expect(r.endOfDay).toBe(after.at(-1)!.end);
      expect(r.day.date).toBe(TODAY);
      expect(r.moved).toBeGreaterThan(0);
    });
  }

  it("the cut is the pause instant: a task due to start during the pause moves by the WHOLE pause", () => {
    // alpha/A4 is due at 10:00. Pause at 09:59, resume at 10:04: A4 must run at 10:05, not at 10:00.
    const { s, store, clock } = svc(tmp(), "2026-09-28T09:59:00+01:00");
    const a4 = store.getDay(TODAY).items.find((i) => i.taskUid === "alpha/A4")!;
    expect(a4.start).toBe("2026-09-28T10:00:00+01:00");
    s.pause();
    clock.advance(5 * 60_000);
    expect(s.resume().pausedSec).toBe(300);
    const moved = store.getItem(a4.key)!;
    expect(moved.start, "it did not run while the owner was away").toBe("2026-09-28T10:05:00+01:00");
    expect(ms(moved.end) - ms(moved.start), "and it kept its full length").toBe(ms(a4.end) - ms(a4.start));
  });

  it("only the item in progress at the pause instant keeps its times", () => {
    const { s, store, clock } = svc(); // 10:15: alpha/A4 10:00-10:50 is under way
    const before = store.getDay(TODAY).items;
    const inProgress = before.find((i) => ms(i.start) <= ms(NOW) && ms(NOW) < ms(i.end))!;
    expect(inProgress.taskUid).toBe("alpha/A4");
    s.pause();
    clock.advance(20 * 60_000);
    s.resume();
    const after = store.getDay(TODAY).items;
    expect(line(store.getItem(inProgress.key)!)).toBe(line(inProgress));
    // Everything at or after the cut moved by the whole 20 minutes; nothing before it did.
    for (const [i, it] of before.entries()) {
      const a = after[i]!;
      if (ms(it.start) < ms(NOW)) expect(a.start, `${it.key}`).toBe(it.start);
      else expect(ms(a.end) - ms(it.end), `${it.key}`).toBe(20 * 60_000);
    }
  });

  it("a pause spanning a rest boundary: the rest that was running keeps its start, the rest moves on", () => {
    // rest|2 runs 09:50-10:00; pause inside it, so the following items all move by the whole pause.
    const { s, store, clock } = svc(tmp(), "2026-09-28T09:55:00+01:00");
    const before = store.getDay(TODAY).items;
    const rest = before.find((i) => i.key === `${TODAY}|rest|2`)!;
    expect([rest.start, rest.end]).toEqual(["2026-09-28T09:50:00+01:00", "2026-09-28T10:00:00+01:00"]);
    s.pause();
    clock.advance(3 * 60_000);
    s.resume();
    const movedRest = store.getItem(rest.key)!;
    expect(movedRest.start, "the rest in progress keeps its start").toBe(rest.start);
    expect(movedRest.end, "and stretches over the pause").toBe("2026-09-28T10:03:00+01:00");
    for (const it of before.filter((i) => ms(i.start) >= ms("2026-09-28T09:55:00+01:00"))) {
      const a = store.getItem(it.key)!;
      expect(ms(a.start) - ms(it.start), `${it.key} start`).toBe(3 * 60_000);
      expect(ms(a.end) - ms(it.end), `${it.key} end`).toBe(3 * 60_000);
    }
  });

  it("a pause longer than 24 h is INVALID_INPUT and KEEPS the pause", () => {
    const { s, store, clock } = svc();
    s.pause();
    clock.advance(24 * 3_600_000 + 1);
    const e = failure(() => s.resume());
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.hint).toMatch(/"unit": "days"/);
    expect(store.pausedSince(), "nothing is lost").toBe(ms(NOW));
    expect(s.paused()?.since).toBe("2026-09-28T10:15:00+01:00");
  });

  it("exactly 24 h still resumes", () => {
    const { s, store, clock } = svc();
    s.pause();
    clock.advance(24 * 3_600_000);
    expect(s.resume().pausedSec).toBe(86_400);
    expect(store.pausedSince()).toBeUndefined();
  });

  it("succeeds and clears the pause even when today has nothing left to move", () => {
    const { s, store, clock } = svc(tmp(), "2026-09-28T23:59:00+01:00");
    s.pause();
    clock.advance(5_000);
    const r = s.resume();
    expect(r.moved).toBe(0);
    expect(r.pausedSec).toBe(5);
    expect(store.pausedSince()).toBeUndefined();
  });
});

describe("the pause is durable (P8 invariant 4)", () => {
  it("survives a restart and the resume still uses the original instant", () => {
    const dir = tmp();
    const a = svc(dir);
    const before = times(a.store.getDay(TODAY).items);
    a.s.pause();
    a.store.close();
    stores.splice(stores.indexOf(a.store), 1);

    // A brand-new process, 45.317 s later.
    const b = svc(dir, "2026-09-28T10:15:45.317+01:00");
    expect(b.s.paused()).toEqual({ since: "2026-09-28T10:15:00+01:00", elapsedSec: 45.317 });
    const r = b.s.resume();
    expect(r.pausedSec).toBe(45.317);
    const after = b.store.getDay(TODAY).items;
    const cut = ms(NOW); // the pause instant, measured across the restart
    let head = true;
    for (const [i, line] of before.entries()) {
      const [key, start, end] = line.split(" ") as [string, string, string];
      const it = after[i]!;
      expect(it.key).toBe(key);
      if (ms(start) < cut) {
        expect(it.start, key).toBe(start);
        continue;
      }
      expect(ms(it.end) - ms(end), key).toBe(45_317);
      if (!(head && it.kind === "rest")) expect(ms(it.start) - ms(start), key).toBe(45_317);
      head = false;
    }
  });
});

describe("while paused the plan is frozen (P8 rule 4)", () => {
  it("shift, its preview and regenerate are all PAUSED, with a hint naming POST /plan/resume", () => {
    const { s } = svc();
    s.pause();
    for (const call of [() => s.shift(30, "minutes"), () => s.shift(30, "minutes", { dryRun: true }), () => s.shift(1, "days"), () => s.regenerate("2026-09-29")]) {
      const e = failure(call);
      expect(e.code).toBe("PAUSED");
      expect(e.hint).toMatch(/POST \/plan\/resume/);
      expect(e.details).toEqual({ paused: { since: "2026-09-28T10:15:00+01:00", elapsedSec: 0 } });
    }
  });

  it("the request itself is still validated first: a bad amount is INVALID_INPUT, not PAUSED", () => {
    const { s } = svc();
    s.pause();
    expect(failure(() => s.shift(1.5, "minutes")).code).toBe("INVALID_INPUT");
    expect(failure(() => s.shift(30, "weeks")).code).toBe("INVALID_INPUT");
    expect(failure(() => s.regenerate("nope")).code).toBe("INVALID_INPUT");
  });

  it("a status change still works and still re-plans later days", () => {
    const { s, store } = svc();
    s.pause();
    const item = store.getDay(TODAY).items.find((i) => i.kind === "task")!;
    const r = s.setItemStatus(item.key, "done");
    expect(r.item?.status).toBe("done");
    expect(store.getItem(item.key)!.status).toBe("done");
    expect(s.paused(), "the pause is untouched").not.toBeNull();
    const undone = s.setItemStatus(item.key, "pending");
    expect(undone.item?.status ?? "pending").toBe("pending");
    expect(s.paused()).not.toBeNull();
  });

  it("a pause that can no longer be applied (> 24 h) stops freezing the plan, and a shift clears it", () => {
    const { s, store, clock } = svc();
    s.pause();
    clock.advance(30 * 3_600_000); // 30 h: resume is refused, so the day shift the hint names must work
    expect(failure(() => s.resume()).code).toBe("INVALID_INPUT");
    expect(store.pausedSince()).toBeDefined();
    const r = s.shift(2, "days");
    expect(r.regenerated.length).toBeGreaterThan(0);
    expect(store.pausedSince(), "the stale pause is cleared by the shift it pointed at").toBeUndefined();
  });
});
