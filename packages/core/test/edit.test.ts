/**
 * The surgical editor (P9). Every case asserts the two invariants that matter: the result
 * re-parses with zero errors into exactly the intended task (invariant 3), and nothing outside
 * the edited lines moved (invariant 1). `edit-resources.test.ts` repeats both against the real
 * files in `resources/`.
 */
import { describe, expect, it } from "vitest";
import {
  deleteTask,
  detectEol,
  diff,
  findTask,
  insertTask,
  nextTaskId,
  parseTaskFile,
  renderPlanFile,
  renderTaskBlock,
  updateMeta,
  updateTask,
  type EditResult,
} from "../src/index.ts";

const FM = `---
schema: planner/task-file@1
track: demo
title: Demo
kind: lessons
---
`;

const DOC = `${FM}
# Demo

Intro prose.

## Week 1

### Read the paper

\`\`\`task
id: L1
duration: 1h
type: reading
link: "[Paper](https://arxiv.org/abs/1706.03762)"
\`\`\`

Focus on section 3.

#### Notes

Sub-headings stay in the body.

### Build the tokenizer

\`\`\`task
id: L2
duration: 2h30m
type: build
\`\`\`

Write a BPE tokenizer.

## Sources

[Karpathy](https://karpathy.ai)
`;

/** Unwrap a result, failing loudly with the editor's own message. */
function ok(r: EditResult): string {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.text;
}
const err = (r: EditResult) => {
  if (r.ok) throw new Error("expected an error, got a new text");
  return r.error;
};

const lines = (text: string) => text.split("\n");
/** The 1-based line window that changed, comparing lines with their terminators. */
function window(before: string, after: string) {
  const a = before.split(/(?<=\n)/);
  const b = after.split(/(?<=\n)/);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { from: p + 1, toBefore: a.length - s, toAfter: b.length - s };
}
/** Re-parse and demand the parser is happy. */
function reparsed(text: string) {
  const { file, errors } = parseTaskFile(text, "demo.md");
  expect(errors).toEqual([]);
  expect(file).not.toBeNull();
  return file!;
}

describe("renderTaskBlock", () => {
  it("writes the canonical key order and canonical durations", () => {
    expect(renderTaskBlock({ id: "A1", duration: 150, type: "coding", links: ["https://x.test/a"], repeat: "daily", occurrences: 3 }))
      .toBe(['id: A1', 'duration: 2h30m', 'type: coding', 'link: "https://x.test/a"', 'repeat: daily', 'occurrences: 3'].join("\n"));
  });

  it.each([[40, "40m"], [120, "2h"], [150, "2h30m"], [90, "1h30m"], [25, "25m"]])("%d minutes renders as %s", (min, want) =>
    expect(renderTaskBlock({ id: "x", duration: min, type: "drill" })).toContain(`duration: ${want}`));

  it("accepts a duration string and still renders it canonically", () =>
    expect(renderTaskBlock({ id: "x", duration: "1h 30m", type: "drill" })).toContain("duration: 1h30m"));

  it("writes one link inline and several as a YAML list, both of which the parser reads back", () => {
    const one = renderTaskBlock({ id: "x", duration: 40, type: "coding", links: [{ label: "595. Big Countries", url: "https://leetcode.com/problems/big-countries/" }] });
    expect(one).toContain('link: "[595. Big Countries](https://leetcode.com/problems/big-countries/)"');
    const many = renderTaskBlock({ id: "x", duration: 40, type: "coding", links: ["[A](https://a.test/)", "https://b.test/"] });
    expect(lines(many).slice(3)).toEqual(['link:', '  - "[A](https://a.test/)"', '  - "https://b.test/"']);
    // Round-trip through the parser, which is the only reader that counts.
    const f = reparsed(`${FM}\n### T\n\n\`\`\`task\n${many}\n\`\`\`\n`);
    expect(f.tasks[0]!.links).toEqual([
      { label: "A", url: "https://a.test/" },
      { label: "https://b.test/", url: "https://b.test/" },
    ]);
  });

  it("escapes a quote in a link label", () => {
    const b = renderTaskBlock({ id: "x", duration: 40, type: "coding", links: [{ label: 'He said "hi"', url: "https://a.test/" }] });
    const f = reparsed(`${FM}\n### T\n\n\`\`\`task\n${b}\n\`\`\`\n`);
    expect(f.tasks[0]!.links).toEqual([{ label: 'He said "hi"', url: "https://a.test/" }]);
  });
});

describe("detectEol", () => {
  it.each([["a\nb\n", "\n"], ["a\r\nb\r\n", "\r\n"], ["a\r\nb\n", "\r\n"], ["no newline", "\n"]])("%j -> %j", (text, eol) =>
    expect(detectEol(text)).toBe(eol));
});

describe("insertTask", () => {
  it("appends at the end of the file, at the level the file uses for tasks", () => {
    const text = ok(insertTask(DOC, { id: "L3", title: "Read chapter 4", duration: "45m", type: "reading" }, "demo.md"));
    expect(text.endsWith("### Read chapter 4\n\n```task\nid: L3\nduration: 45m\ntype: reading\n```\n")).toBe(true);
    const f = reparsed(text);
    expect(f.tasks.map((t) => t.uid)).toEqual(["demo/L1", "demo/L2", "demo/L3"]);
    expect(f.tasks[2]).toMatchObject({ title: "Read chapter 4", durationMin: 45, type: "reading", section: "Sources", body: "" });
    // The lines before the insertion are untouched.
    expect(window(DOC, text).from).toBeGreaterThan(lines(DOC).length - 3);
  });

  it("places a task behind another one, before that task's next sibling", () => {
    const text = ok(insertTask(DOC, { id: "L1b", title: "Skim the appendix", duration: 20, type: "reading", after: "demo/L1" }, "demo.md"));
    const f = reparsed(text);
    expect(f.tasks.map((t) => t.uid)).toEqual(["demo/L1", "demo/L1b", "demo/L2"]);
    expect(f.tasks[1]).toMatchObject({ section: "Week 1", durationMin: 20 });
    // L1's body, including its #### sub-heading, stayed with L1.
    expect(f.tasks[0]!.body).toContain("#### Notes");
    expect(f.tasks[0]!.body).toBe(reparsed(DOC).tasks[0]!.body);
  });

  it("appends to a named section and uses the level of the tasks already in it", () => {
    const text = ok(insertTask(DOC, { id: "W1", title: "Re-read the intro", duration: 30, type: "reading", section: "Week 1" }, "demo.md"));
    const f = reparsed(text);
    expect(f.tasks.map((t) => t.uid)).toEqual(["demo/L1", "demo/L2", "demo/W1"]);
    expect(f.tasks[2]!.section).toBe("Week 1");
    expect(text).toContain("### Re-read the intro\n");
    expect(text.indexOf("Re-read the intro")).toBeLessThan(text.indexOf("## Sources"));
  });

  it("opens a section that does not exist yet, and says so", () => {
    const r = insertTask(DOC, { id: "W2", title: "Week 2 kickoff", duration: 30, type: "admin", section: "Week 2" }, "demo.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual(['section "Week 2" did not exist and was added at the end of the file']);
    expect(r.text).toContain("## Week 2\n\n### Week 2 kickoff\n");
    expect(reparsed(r.text).tasks[2]!.section).toBe("Week 2");
  });

  it("keeps exactly one blank line on each side of the new section (rule 6)", () => {
    const text = ok(insertTask(DOC, { id: "L3", title: "T", duration: 30, type: "admin", after: "demo/L1" }, "demo.md"));
    expect(text).not.toMatch(/\n\n\n/);
  });

  it("writes the body and keeps a python fence inside it", () => {
    const body = "Notes.\n\n```python\ndf[df.a > 1]\n```\n\n**Transfers to:** everything.";
    const text = ok(insertTask(DOC, { id: "L3", title: "Filtering", duration: 40, type: "coding", body }, "demo.md"));
    const f = reparsed(text);
    expect(f.tasks).toHaveLength(3);
    expect(f.tasks[2]!.body).toBe(body);
  });

  it("generates an unused id when none is given, continuing the file's numbering", () => {
    const r = insertTask(DOC, { title: "Next", duration: 30, type: "admin" }, "demo.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task!.id).toBe("L3");
    expect(r.warnings).toEqual(["id was generated: L3"]);
    expect(nextTaskId(r.text, "demo.md")).toBe("L4");
  });

  it.each([
    [{ id: "L1", title: "T", duration: 30, type: "admin" }, "duplicate", /already exists/],
    [{ id: "L3", title: "T", duration: "40", type: "admin" }, "invalid", /invalid duration/],
    [{ id: "L3", title: "T", duration: 30, type: "studying" }, "invalid", /type must be one of/],
    [{ id: "L3", title: "", duration: 30, type: "admin" }, "invalid", /title is required/],
    [{ id: "L3", title: "T", duration: 30, type: "admin", occurrences: 3 }, "invalid", /occurrences needs repeat/],
    [{ id: "L3", title: "T", duration: 30, type: "admin", links: ["not a link"] }, "invalid", /link must be/],
    [{ id: "L3", title: "T", duration: 30, type: "admin", after: "demo/nope" }, "not_found", /no task "demo\/nope"/],
    [{ id: "bad id", title: "T", duration: 30, type: "admin" }, "invalid", /must match/],
    [{ id: "L3", title: "T", duration: 30, type: "admin", body: "## Oops" }, "invalid", /may not contain a level-2 heading/],
    [{ id: "L3", title: "T", duration: 30, type: "admin", body: "```task\nid: X\n```" }, "invalid", /may not contain a ```task block/],
    [{ id: "L3", title: "T", duration: 30, type: "admin", body: "```python\nx = 1" }, "invalid", /unclosed code fence/],
  ] as const)("rejects %j", (spec, code, message) => {
    const e = err(insertTask(DOC, spec as never, "demo.md"));
    expect(e.code).toBe(code);
    expect(e.message).toMatch(message);
  });

  it("reports the parser's own message for a file that is not a task file", () => {
    const e = err(insertTask("# Just markdown\n", { id: "A", title: "T", duration: 30, type: "admin" }, "x.md"));
    expect(e.code).toBe("unparsable");
    expect(e.message).toMatch(/^x\.md:1: missing YAML front matter/);
  });
});

describe("updateTask", () => {
  it("rewrites only the duration line", () => {
    const text = ok(updateTask(DOC, "demo/L1", { duration: 150 }, "demo.md"));
    const w = window(DOC, text);
    expect([w.from, w.toBefore, w.toAfter]).toEqual([lines(DOC).indexOf("duration: 1h") + 1, w.from, w.from]);
    expect(text).toContain("duration: 2h30m");
    expect(reparsed(text).tasks[0]!.durationMin).toBe(150);
  });

  it("rewrites only the heading line for a title change", () => {
    const text = ok(updateTask(DOC, "demo/L1", { title: "Read the paper, twice" }, "demo.md"));
    const w = window(DOC, text);
    expect(w.toBefore - w.from).toBe(0);
    expect(lines(text)[w.from - 1]).toBe("### Read the paper, twice");
    expect(reparsed(text).tasks[0]!.title).toBe("Read the paper, twice");
  });

  it("keeps the keys in the order the file had them and appends a new one at the end", () => {
    const odd = `${FM}\n### T\n\n\`\`\`task\ntype: coding\nid: X\nduration: 40m\n\`\`\`\n`;
    const text = ok(updateTask(odd, "demo/X", { duration: 50, repeat: "daily", occurrences: 4 }, "demo.md"));
    expect(lines(text).slice(-7, -2)).toEqual(["type: coding", "id: X", "duration: 50m", "repeat: daily", "occurrences: 4"]);
    expect(reparsed(text).tasks[0]).toMatchObject({ durationMin: 50, repeat: "daily", occurrences: 4 });
  });

  it("removes a key set to null, and drops occurrences with repeat", () => {
    const base = ok(updateTask(DOC, "demo/L2", { repeat: "daily", occurrences: 5 }, "demo.md"));
    expect(base).toContain("occurrences: 5");
    const text = ok(updateTask(base, "demo/L2", { repeat: null }, "demo.md"));
    expect(text).not.toContain("repeat:");
    expect(text).not.toContain("occurrences:");
    const t = reparsed(text).tasks[1]!;
    expect(t.repeat).toBeUndefined();
    expect(t.occurrences).toBeUndefined();
  });

  it("replaces a single link with a list and back", () => {
    const two = ok(updateTask(DOC, "demo/L1", { links: ["[A](https://a.test/)", "[B](https://b.test/)"] }, "demo.md"));
    expect(reparsed(two).tasks[0]!.links).toEqual([
      { label: "A", url: "https://a.test/" },
      { label: "B", url: "https://b.test/" },
    ]);
    const one = ok(updateTask(two, "demo/L1", { links: [{ label: "C", url: "https://c.test/" }] }, "demo.md"));
    expect(reparsed(one).tasks[0]!.links).toEqual([{ label: "C", url: "https://c.test/" }]);
    const none = ok(updateTask(one, "demo/L1", { links: null }, "demo.md"));
    expect(reparsed(none).tasks[0]!.links).toEqual([]);
    expect(none).not.toContain("link:");
  });

  it("replaces the body span and leaves one blank line before the next heading", () => {
    const text = ok(updateTask(DOC, "demo/L1", { body: "New notes.\n\n#### Still inside\n\nMore." }, "demo.md"));
    const f = reparsed(text);
    expect(f.tasks[0]!.body).toBe("New notes.\n\n#### Still inside\n\nMore.");
    expect(f.tasks[1]!.body).toBe("Write a BPE tokenizer.");
    expect(text).not.toMatch(/\n\n\n/);
    expect(text).toContain("More.\n\n### Build the tokenizer");
  });

  it("clears the body", () => {
    const text = ok(updateTask(DOC, "demo/L1", { body: "" }, "demo.md"));
    expect(reparsed(text).tasks[0]!.body).toBe("");
    expect(text).toContain("```\n\n### Build the tokenizer");
  });

  it("moves a task to another section, keeping its body bytes", () => {
    const text = ok(updateTask(DOC, "demo/L1", { section: "Sources" }, "demo.md"));
    const f = reparsed(text);
    expect(f.tasks.map((t) => [t.uid, t.section])).toEqual([["demo/L2", "Week 1"], ["demo/L1", "Sources"]]);
    expect(f.tasks[1]!.body).toBe(reparsed(DOC).tasks[0]!.body);
    expect(text).not.toMatch(/\n\n\n/);
  });

  it("changes several things at once", () => {
    const text = ok(updateTask(DOC, "demo/L2", { title: "Build a BPE tokenizer", duration: "3h", type: "coding", body: "Start from the paper." }, "demo.md"));
    expect(reparsed(text).tasks[1]).toMatchObject({
      title: "Build a BPE tokenizer", durationMin: 180, type: "coding", body: "Start from the paper.",
    });
  });

  it("accepts a bare id as well as the uid", () =>
    expect(reparsed(ok(updateTask(DOC, "L2", { duration: 60 }, "demo.md"))).tasks[1]!.durationMin).toBe(60));

  it.each([
    ["demo/L1", { id: "L9" }, "immutable", /id is immutable/],
    ["demo/L1", { track: "other" }, "immutable", /track is immutable/],
    ["demo/nope", { duration: 60 }, "not_found", /no task "demo\/nope"/],
    ["demo/L1", { duration: "40" }, "invalid", /invalid duration/],
    ["demo/L1", { type: "nope" }, "invalid", /type must be one of/],
    ["demo/L1", { occurrences: 2 }, "invalid", /occurrences needs repeat/],
    ["demo/L1", { repeat: "weekly" }, "invalid", /repeat must be/],
    ["demo/L1", { title: "### T" }, "invalid", /must not start with #/],
    ["demo/L1", { body: "### Oops" }, "invalid", /may not contain a level-3 heading/],
    ["demo/L1", { links: ["nope"] }, "invalid", /link must be/],
  ] as const)("rejects %s %j", (uid, patch, code, message) => {
    const e = err(updateTask(DOC, uid, patch as never, "demo.md"));
    expect(e.code).toBe(code);
    expect(e.message).toMatch(message);
  });

  // An empty patch used to return the text unchanged. Over HTTP that is indistinguishable from a
  // successful edit, so a caller that dropped a field is told its change landed. It is a mistake now.
  it("rejects an empty patch rather than answering ok with nothing done", () => {
    const e = err(updateTask(DOC, "demo/L1", {}, "demo.md"));
    expect(e.code).toBe("unknown_field");
    expect(e.message).toMatch(/no fields to change/);
  });
});

describe("deleteTask", () => {
  it("removes heading, block and body and leaves one blank line between the neighbours", () => {
    const text = ok(deleteTask(DOC, "demo/L1", "demo.md"));
    const f = reparsed(text);
    expect(f.tasks.map((t) => t.uid)).toEqual(["demo/L2"]);
    expect(text).toContain("## Week 1\n\n### Build the tokenizer");
    expect(text).not.toContain("Focus on section 3");
    expect(text).not.toContain("#### Notes");
    expect(text).not.toMatch(/\n\n\n/);
    // Everything before the removed heading is byte-identical.
    expect(text.slice(0, text.indexOf("## Week 1"))).toBe(DOC.slice(0, DOC.indexOf("## Week 1")));
  });

  it("removes the last task without disturbing the prose after it", () => {
    const text = ok(deleteTask(DOC, "demo/L2", "demo.md"));
    expect(text).toContain("## Sources\n\n[Karpathy](https://karpathy.ai)\n");
    expect(reparsed(text).references).toEqual([{ label: "Karpathy", url: "https://karpathy.ai" }]);
  });

  it("removes the only task and keeps the file a valid task file", () => {
    const one = `${FM}\n# D\n\n### T\n\n\`\`\`task\nid: X\nduration: 1h\ntype: admin\n\`\`\`\n`;
    const text = ok(deleteTask(one, "demo/X", "demo.md"));
    expect(text).toBe(`${FM}\n# D\n`);
    expect(reparsed(text).tasks).toEqual([]);
  });

  it("rejects an unknown uid", () => expect(err(deleteTask(DOC, "demo/nope", "demo.md")).code).toBe("not_found"));
});

describe("updateMeta", () => {
  const withComments = `---
schema: planner/task-file@1
# the track is the uid prefix
track: demo
title: Demo
kind: prep
priority: 2
default_duration: 40m
---

# Demo
`;

  it("rewrites one key in place, keeping order, comments and every other byte", () => {
    const text = ok(updateMeta(withComments, { title: "Demo, renamed" }, "demo.md"));
    expect(lines(text).slice(0, 9)).toEqual([
      "---", "schema: planner/task-file@1", "# the track is the uid prefix", "track: demo",
      "title: Demo, renamed", "kind: prep", "priority: 2", "default_duration: 40m", "---",
    ]);
    expect(window(withComments, text)).toMatchObject({ from: 5, toBefore: 5, toAfter: 5 });
  });

  it("quotes a title that YAML would read as something else", () => {
    const text = ok(updateMeta(withComments, { title: "Demo: the sequel" }, "demo.md"));
    expect(text).toContain('title: "Demo: the sequel"');
    expect(parseTaskFile(text, "demo.md").file!.meta.title).toBe("Demo: the sequel");
  });

  it("accepts the API's camelCase names and renders durations canonically", () => {
    const text = ok(updateMeta(withComments, { defaultDuration: 150, startsAfter: "bcg", priority: 5 }, "demo.md"));
    expect(text).toContain("default_duration: 2h30m");
    expect(text).toContain("priority: 5");
    expect(text).toContain("starts_after: bcg");
    expect(parseTaskFile(text, "demo.md").file!.meta).toMatchObject({ defaultDurationMin: 150, startsAfter: "bcg", priority: 5 });
  });

  it("appends a new key before the closing --- and removes one set to null", () => {
    const added = ok(updateMeta(withComments, { startsAfter: "bcg" }, "demo.md"));
    expect(lines(added).slice(7, 9)).toEqual(["default_duration: 40m", "starts_after: bcg"]);
    const removed = ok(updateMeta(added, { startsAfter: null, default_duration: null }, "demo.md"));
    expect(removed).toBe(withComments.replace("default_duration: 40m\n", ""));
  });

  it("keeps the rest of the file untouched", () => {
    const text = ok(updateMeta(DOC, { title: "Other" }, "demo.md"));
    expect(text.slice(text.indexOf("---\n", 4))).toBe(DOC.slice(DOC.indexOf("---\n", 4)));
  });

  it.each([
    [{ track: "other" }, "immutable", /track is immutable/],
    [{ schema: "planner/task-file@2" }, "immutable", /schema is immutable/],
    [{ kind: "revision" }, "invalid", /kind must be one of/],
    [{ priority: 1.5 }, "invalid", /priority must be an integer/],
    [{ default_duration: "soon" }, "invalid", /invalid default_duration/],
    [{ starts_after: "../etc" }, "invalid", /must be a track slug/],
    [{ priorty: 1 }, "unknown_field", /unknown front-matter key "priorty"; did you mean "priority"\?/],
    [{ title: null }, "invalid", /title is required/],
  ] as const)("rejects %j", (patch, code, message) => {
    const e = err(updateMeta(withComments, patch as never, "demo.md"));
    expect(e.code).toBe(code);
    expect(e.message).toMatch(message);
  });

  it("refuses to leave a prep file without a priority", () => {
    expect(err(updateMeta(withComments, { priority: null }, "demo.md")).message).toMatch(/prep files need a priority/);
    expect(err(updateMeta(DOC, { kind: "prep" }, "demo.md")).message).toMatch(/prep files need a priority/);
    expect(ok(updateMeta(withComments, { kind: "lessons", priority: null }, "demo.md"))).not.toContain("priority:");
  });
});

describe("renderPlanFile", () => {
  it("writes a file the parser accepts with no tasks", () => {
    const r = renderPlanFile({ track: "newtrack", title: "New Track — prep", kind: "prep", priority: 4, defaultDuration: 150 }, "Why this plan exists.");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe(`---
schema: planner/task-file@1
track: newtrack
title: New Track — prep
kind: prep
priority: 4
default_duration: 2h30m
---

# New Track — prep

Why this plan exists.
`);
    const { file, errors } = parseTaskFile(r.text, "newtrack.md");
    expect(errors).toEqual([]);
    expect(file!.tasks).toEqual([]);
    expect(file!.meta).toMatchObject({ track: "newtrack", kind: "prep", priority: 4, defaultDurationMin: 150 });
  });

  it("round-trips a task inserted into a fresh plan", () => {
    const r = renderPlanFile({ track: "fresh", title: "Fresh", kind: "lessons" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = ok(insertTask(r.text, { id: "T1", title: "First task", duration: "2h", type: "build" }, "fresh.md"));
    const { file, errors } = parseTaskFile(text, "fresh.md");
    expect(errors).toEqual([]);
    expect(file!.tasks[0]).toMatchObject({ uid: "fresh/T1", durationMin: 120, type: "build" });
  });

  it("can write CRLF", () => {
    const r = renderPlanFile({ track: "crlf", title: "CRLF", kind: "lessons" }, undefined, { eol: "\r\n" });
    expect(r.ok && r.text.includes("\r\n") && !/[^\r]\n/.test(r.text)).toBe(true);
  });

  it.each([
    [{ track: "../etc", title: "T", kind: "lessons" }, /track must be a slug/],
    [{ track: "ok", title: "", kind: "lessons" }, /title is required/],
    [{ track: "ok", title: "T", kind: "revision" }, /kind must be one of/],
    [{ track: "ok", title: "T", kind: "prep" }, /prep files need a priority/],
    [{ track: "ok", title: "T", kind: "lessons", defaultDuration: "soon" }, /invalid default_duration/],
    [{ track: "ok", title: "T", kind: "lessons", startsAfter: "../x" }, /must be a track slug/],
  ] as const)("rejects %j", (meta, message) => expect(err(renderPlanFile(meta as never)).message).toMatch(message));
});

describe("findTask", () => {
  it("finds by uid and by bare id, and returns null otherwise", () => {
    expect(findTask(DOC, "demo/L2", "demo.md")?.title).toBe("Build the tokenizer");
    expect(findTask(DOC, "L2", "demo.md")?.uid).toBe("demo/L2");
    expect(findTask(DOC, "nope", "demo.md")).toBeNull();
    expect(findTask("# not a task file\n", "x", "x.md")).toBeNull();
  });
});

describe("diff", () => {
  it("is empty for identical texts", () => expect(diff(DOC, DOC, "demo.md")).toBe(""));

  it("writes standard headers and one hunk with three lines of context", () => {
    const text = ok(updateTask(DOC, "demo/L1", { duration: 150 }, "demo.md"));
    expect(diff(DOC, text, "resources/demo.md")).toBe(`--- a/resources/demo.md
+++ b/resources/demo.md
@@ -15,7 +15,7 @@
 
 \`\`\`task
 id: L1
-duration: 1h
+duration: 2h30m
 type: reading
 link: "[Paper](https://arxiv.org/abs/1706.03762)"
 \`\`\`
`);
  });

  it("marks a missing final newline", () => {
    expect(diff("a\nb", "a\nc", "f")).toBe("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n");
  });

  it("uses /dev/null for a created file", () => {
    expect(diff("", "a\n", "f")).toBe("--- /dev/null\n+++ b/f\n@@ -0,0 +1,1 @@\n+a\n");
    expect(diff("a\n", "", "f")).toBe("--- a/f\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n");
  });

  it("emits separate hunks for distant changes and one for near ones", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const far = before.replace("line 2\n", "line 2 edited\n").replace("line 30\n", "line 30 edited\n");
    expect(far.match(/^@@/gm)).toBeNull();
    expect(diff(before, far, "f").match(/^@@/gm)).toHaveLength(2);
    const near = before.replace("line 2\n", "line 2 edited\n").replace("line 5\n", "line 5 edited\n");
    expect(diff(before, near, "f").match(/^@@/gm)).toHaveLength(1);
  });
});
