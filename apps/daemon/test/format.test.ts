import { describe, expect, it } from "vitest";
import type { PlanItem } from "@planner/core";
import { buildResume, buildToast, fmtDuration, recordTitle, taskLabel } from "../src/format.ts";
import { parseNotifyModes } from "../src/sinks.ts";

const TZ = "Africa/Tunis";
const item = (o: Partial<PlanItem> & Pick<PlanItem, "key" | "start" | "end">): PlanItem => ({ date: "2026-09-28", kind: "task", title: "T", status: "pending", ...o });
const task = (id: string, title: string, s: string, e: string) =>
  item({ key: `2026-09-28|bcg/${id}|1`, taskUid: `bcg/${id}`, title, start: `2026-09-28T${s}:00+01:00`, end: `2026-09-28T${e}:00+01:00` });
const rest = (n: number, s: string, e: string, long = false) =>
  item({ key: `2026-09-28|rest|${n}`, kind: "rest", restKind: long ? "long" : "short", title: long ? "Long rest" : "Rest", start: `2026-09-28T${s}:00+01:00`, end: `2026-09-28T${e}:00+01:00` });

const A1 = task("A1", "A1 · Boolean filtering", "08:50", "09:30");
const R2 = rest(2, "09:30", "09:40");
const A2 = task("A2", "A2 · Window functions", "09:40", "10:20");
const day = [A1, R2, A2];
const after = (ms: number) => day.filter((it) => Date.parse(it.start) >= ms);
const at = (it: PlanItem, edge: "start" | "end") => Date.parse(it[edge]);

describe("toast text", () => {
  it("labels, durations", () => {
    expect(taskLabel(A1)).toBe("A1 · Boolean filtering");
    expect(taskLabel(A2)).toBe("A2 · Window functions");
    // a heading that does not start with the id is used as is (no "SKIP · Skip test …")
    expect(taskLabel(task("SKIP", "Skip test — tick what you own", "08:00", "09:00"))).toBe("Skip test — tick what you own");
    expect(fmtDuration(10)).toBe("10 min");
    expect(fmtDuration(60)).toBe("1 h");
    expect(fmtDuration(90)).toBe("1 h 30 min");
  });

  it("task start: end time and what follows", () => {
    expect(buildToast([{ type: "task_start", item: A1, atMs: at(A1, "start") }], TZ, after)).toEqual({
      title: "Start: A1 · Boolean filtering",
      message: "Until 09:30 · then 10 min rest",
    });
    expect(buildToast([{ type: "task_start", item: A2, atMs: at(A2, "start") }], TZ, after).message).toBe("Until 10:20 · then done for today");
  });

  it("task end + rest start coalesce into the rest toast; rest end + task start into the task toast", () => {
    const t = buildToast(
      [
        { type: "task_end", item: A1, atMs: at(A1, "end") },
        { type: "rest_start", item: R2, atMs: at(R2, "start") },
      ],
      TZ,
      after,
    );
    expect(t).toEqual({ title: "Rest 10 min", message: "Until 09:40 · next: A2 · Window functions" });
    const u = buildToast(
      [
        { type: "rest_end", item: R2, atMs: at(R2, "end") },
        { type: "task_start", item: A2, atMs: at(A2, "start") },
      ],
      TZ,
      after,
    );
    expect(u.title).toBe("Start: A2 · Window functions");
  });

  it("lone ends", () => {
    expect(buildToast([{ type: "task_end", item: A2, atMs: at(A2, "end") }], TZ, after)).toEqual({ title: "Time's up: A2 · Window functions", message: "Done for today" });
    const done = { ...A2, status: "done" as const };
    expect(buildToast([{ type: "rest_end", item: R2, atMs: at(R2, "end") }], TZ, (ms) => after(ms).map((x) => (x.key === A2.key ? done : x)))).toEqual({
      title: "Rest over",
      message: "Nothing left today",
    });
    expect(buildToast([{ type: "rest_start", item: rest(9, "12:00", "13:00", true), atMs: 0 }], TZ, () => []).title).toBe("Long rest 1 h");
  });

  it("free rest (task before it done/skipped) and resume", () => {
    const e = { type: "rest_start" as const, item: R2, atMs: at(R2, "start"), free: { untilMs: at(A2, "start") + 60 * 60_000, next: A2 } };
    expect(buildToast([e], TZ, after)).toEqual({ title: "Free until 10:40", message: "Next: A2 · Window functions" });
    expect(recordTitle(e, TZ)).toBe("Free until 10:40");
    expect(buildToast([{ ...e, free: { untilMs: at(R2, "end") } }], TZ, after)).toEqual({ title: "Free until 09:40", message: "Nothing left today" });
    expect(buildResume(A1, TZ, after)).toEqual({ title: "Now: A1 · Boolean filtering", message: "Until 09:30 · then 10 min rest" });
    expect(buildResume(R2, TZ, after)).toEqual({ title: "Now: Rest 10 min", message: "Until 09:40 · next: A2 · Window functions" });
  });

  it("PLANNER_NOTIFY parsing", () => {
    expect([...parseNotifyModes(undefined)]).toEqual(["toast", "log"]);
    expect([...parseNotifyModes("log")]).toEqual(["log"]);
    expect([...parseNotifyModes("off")]).toEqual([]);
    expect(() => parseNotifyModes("email")).toThrow();
  });
});
