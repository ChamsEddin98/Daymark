import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hasRealPlans, readRealPlanIfAny } from "./real-plans.ts";
import { insertTask, renderPlanFile, updateMeta, updateTask } from "../src/index.ts";

/**
 * An ignored field is the worst answer this editor can give. The call succeeds, the diff is empty,
 * and the caller - over HTTP, usually Claude Code - is told the change landed. These tests exist
 * because `updateTask(text, uid, { durationMin: 150 })` used to return ok with the file untouched.
 */
// "" when the owner's plans are absent; the suite below is skipped then, so it is never used.
const BCG = readRealPlanIfAny("bcg.md");

describe.skipIf(!hasRealPlans)("a field we do not have is rejected, never ignored", () => {
  const cases: [string, object][] = [
    ["camelCase of a real field", { durationMin: 150 }],
    ["snake_case of a real field", { duration_min: "2h" }],
    ["a typo", { titl: "x" }],
    ["plausible but wrong", { estimate: "2h" }],
    ["one good field and one bad", { duration: "2h", colour: "red" }],
  ];
  for (const [label, patch] of cases) {
    it(`updateTask: ${label}`, () => {
      const r = updateTask(BCG, "bcg/A1", patch, "bcg.md");
      expect(r.ok, `${label} must not be accepted`).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe("unknown_field");
      expect(r.error.message).toContain(Object.keys(patch).find((k) => k !== "duration")!);
    });
  }

  it("names the field you probably meant", () => {
    const r = updateTask(BCG, "bcg/A1", { durationMin: 150 } as never, "bcg.md");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('did you mean "duration"');
  });

  it("lists the fields that do exist", () => {
    const r = updateTask(BCG, "bcg/A1", { nonsense: 1 } as never, "bcg.md");
    expect(r.ok).toBe(false);
    if (!r.ok) for (const f of ["title", "duration", "type", "links", "body"]) expect(r.error.message).toContain(f);
  });

  it("an empty patch is a mistake, not a no-op", () => {
    const r = updateTask(BCG, "bcg/A1", {}, "bcg.md");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("unknown_field");
      expect(r.error.message).toContain("no fields to change");
    }
  });

  it("a field set to undefined still counts as absent", () => {
    const r = updateTask(BCG, "bcg/A1", { title: undefined }, "bcg.md");
    expect(r.ok, "an all-undefined patch changes nothing and must say so").toBe(false);
  });

  it("insertTask rejects an unknown field", () => {
    const r = insertTask(BCG, { title: "X", duration: "40m", type: "coding", durationMin: 40 } as never, "bcg.md");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("unknown_field");
  });

  it("insertTask accepts a spec with only its required fields", () => {
    const r = insertTask(BCG, { title: "Z9 · A new technique", duration: "40m", type: "coding" }, "bcg.md");
    expect(r.ok, r.ok ? "" : r.error.message).toBe(true);
  });

  it("updateMeta rejects an unknown front-matter key and an empty patch", () => {
    const bad = updateMeta(BCG, { prioritee: 2 }, "bcg.md");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("unknown_field");
    const none = updateMeta(BCG, {}, "bcg.md");
    expect(none.ok).toBe(false);
  });

  it("updateMeta still accepts both spellings of its aliased keys", () => {
    for (const patch of [{ default_duration: "1h" }, { defaultDuration: "1h" }, { startsAfter: "bcg" }])
      expect(updateMeta(BCG, patch, "bcg.md").ok, JSON.stringify(patch)).toBe(true);
  });

  it("renderPlanFile rejects an unknown field", () => {
    const r = renderPlanFile({ track: "x", title: "X", kind: "prep", priority: 1, colour: "red" } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("unknown_field");
  });

  it("a rejected patch leaves the text untouched", () => {
    const r = updateTask(BCG, "bcg/A1", { durationMin: 150 } as never, "bcg.md");
    expect(r.ok).toBe(false);
    // Nothing to assert on `text` because a failure carries none - which is the point: there is no
    // path by which a rejected edit hands a caller a string it might go on to write.
    expect("text" in r).toBe(false);
  });
});
