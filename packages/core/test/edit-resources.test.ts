/**
 * P9 against the documents it has to survive: the real files in `resources/`. `bcg.md` is 1087
 * lines of hand-written contents list, tables, blockquotes and ```python fences inside task
 * bodies, which is exactly what a naive editor destroys.
 *
 * Every case asserts invariant 1 (byte fidelity: the only lines that differ are inside the
 * intended span, trailing whitespace and line endings included) and invariant 3 (the result
 * re-parses with zero errors into exactly the intended task). Each file is tried as it is on
 * disk (LF), converted to CRLF, and converted to CRLF without a final newline.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteTask,
  diff,
  insertTask,
  parseTaskFile,
  updateMeta,
  updateTask,
  type EditResult,
  type Task,
} from "../src/index.ts";

const RES = resolve(import.meta.dirname, "../../../resources");
const NAMES = ["bcg.md", "salesforce.md", "anthropic.md", "lessons.md", "portfolio.md", "apply.md"];
const source = (name: string) => readFileSync(resolve(RES, name), "utf8");

interface Variant {
  eol: string;
  text: string;
  finalNewline: boolean;
}
const variants = (text: string): Variant[] => [
  { eol: "\n", text, finalNewline: true },
  { eol: "\r\n", text: text.replace(/\n/g, "\r\n"), finalNewline: true },
  { eol: "\r\n", text: text.replace(/\n/g, "\r\n").replace(/\r\n$/, ""), finalNewline: false },
];
const label = (v: Variant) => `${v.eol === "\n" ? "LF" : "CRLF"}${v.finalNewline ? "" : ", no final newline"}`;

function ok(r: EditResult): string {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.text;
}

/** Lines with their terminators, so a comparison is a byte comparison. */
const rawLines = (text: string) => text.split(/(?<=\n)/);
/** The 1-based window of lines that differ. */
function window(before: string, after: string) {
  const a = rawLines(before);
  const b = rawLines(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { from: p + 1, toBefore: a.length - s, toAfter: b.length - s };
}

/** Everything a round-trip has to preserve about a task that the edit did not name. */
const sig = (t: Task) =>
  JSON.stringify([t.uid, t.title, t.durationMin, t.type, t.links, t.repeat, t.occurrences, t.body, t.section]);

function parsed(text: string, path: string) {
  const { file, errors } = parseTaskFile(text, path);
  expect(errors, `${path} must parse with zero errors`).toEqual([]);
  expect(file).not.toBeNull();
  return file!;
}

/** Line endings and the final-newline property are part of "byte-identical". */
function endingsKept(v: Variant, after: string) {
  if (v.eol === "\r\n") expect(/[^\r]\n/.test(after), "a lone LF appeared in a CRLF file").toBe(false);
  else expect(after.includes("\r"), "a CR appeared in an LF file").toBe(false);
  expect(/\n$/.test(after), "the final-newline property changed").toBe(v.finalNewline);
}

/** A spread of tasks: the first, the second, one in the middle, the last, and every one whose
 *  block holds a multi-line YAML list (the region cases that a line editor can get wrong). */
function spread(tasks: Task[]): Task[] {
  const idx = new Set([0, 1, Math.floor(tasks.length / 2), tasks.length - 1].filter((i) => i >= 0 && i < tasks.length));
  const out = [...idx].map((i) => tasks[i]!);
  for (const t of tasks) if (t.links.length > 1 && !out.includes(t)) out.push(t);
  return out;
}

describe.each(NAMES)("%s", (name) => {
  const text = source(name);
  const path = `resources/${name}`;
  const file = parsed(text, path);
  const lines = rawLines(text).map((l) => l.replace(/\r?\n$/, ""));

  it("parses with zero errors and has tasks", () => {
    expect(file.tasks.length).toBeGreaterThan(0);
  });

  it("spans point at the lines they claim", () => {
    for (const t of file.tasks) {
      expect(t.span.heading, `${t.uid} heading`).toBe(t.line);
      expect(lines[t.span.heading - 1], `${t.uid} heading line`).toMatch(/^#{1,6}\s+\S/);
      expect(lines[t.span.heading - 1]).toContain(t.title);
      expect(lines[t.span.blockOpen - 1]!.trim(), `${t.uid} open fence`).toBe("```task");
      expect(lines[t.span.blockClose - 1]!.trim(), `${t.uid} close fence`).toBe("```");
      expect(t.span.heading).toBeLessThan(t.span.blockOpen);
      expect(t.span.blockOpen).toBeLessThan(t.span.blockClose);
      expect(t.span.blockClose).toBeLessThanOrEqual(t.span.end);
      expect(t.span.end).toBeLessThanOrEqual(lines.length);
      // The body the parser returned is exactly the span's tail.
      expect(lines.slice(t.span.blockClose, t.span.end).join("\n").trim()).toBe(t.body);
      // The block's interior is YAML, never another fence (``` python bodies live past blockClose).
      for (let i = t.span.blockOpen; i < t.span.blockClose - 1; i++)
        expect(lines[i], `${t.uid} interior line ${i + 1}`).not.toMatch(/^(```|~~~)/);
    }
  });

  it("spans do not overlap and follow the file order", () => {
    let prev = 0;
    for (const t of file.tasks) {
      expect(t.span.heading, `${t.uid} after the previous span`).toBeGreaterThan(prev);
      prev = t.span.end;
    }
  });

  describe.each(variants(text))(`$eol`, (v) => {
    const title = label(v);
    /** Every task for the file as it is on disk; the spread for the converted variants, which
     *  exercise the line-ending and tail handling rather than the file's own shape. */
    const subjects = (tasks: Task[]) => (v.text === text ? tasks : spread(tasks));

    it(`${title}: a duration change rewrites only the duration line`, () => {
      for (const t of subjects(parsed(v.text, path).tasks)) {
        const want = t.durationMin === 150 ? 45 : 150; // has to differ, or there is no edit to see
        const after = ok(updateTask(v.text, t.uid, { duration: want }, path));
        const w = window(v.text, after);
        expect([w.from, w.toBefore, w.toAfter], `${t.uid} window`)
          .toEqual([t.span.blockOpen + 1 + lines.slice(t.span.blockOpen, t.span.blockClose - 1).findIndex((l) => l.startsWith("duration:")), w.from, w.from]);
        endingsKept(v, after);
        const re = parsed(after, path);
        expect(re.tasks.find((x) => x.uid === t.uid)!.durationMin).toBe(want);
        expect(re.tasks.filter((x) => x.uid !== t.uid).map(sig)).toEqual(file.tasks.filter((x) => x.uid !== t.uid).map(sig));
      }
    });

    it(`${title}: a title change rewrites only the heading line`, () => {
      for (const t of subjects(parsed(v.text, path).tasks)) {
        const after = ok(updateTask(v.text, t.uid, { title: `${t.title} (revised)` }, path));
        expect(window(v.text, after), `${t.uid} window`).toEqual({ from: t.span.heading, toBefore: t.span.heading, toAfter: t.span.heading });
        endingsKept(v, after);
        const re = parsed(after, path);
        expect(re.tasks.find((x) => x.uid === t.uid)!.title).toBe(`${t.title} (revised)`);
        expect(re.references).toEqual(file.references);
      }
    });

    it(`${title}: a delete removes only the task's own lines`, () => {
      for (const t of subjects(parsed(v.text, path).tasks)) {
        const after = ok(deleteTask(v.text, t.uid, path));
        const w = window(v.text, after);
        // One line of slack on each side for the blank lines rule 6 normalises, and one more in
        // a file with no final newline: the line that becomes the last one loses its terminator,
        // which is what keeps the file's "no final newline" property true.
        expect(w.from, `${t.uid} first changed line`).toBeGreaterThanOrEqual(t.span.heading - (v.finalNewline ? 1 : 2));
        expect(w.toBefore, `${t.uid} last changed line`).toBeLessThanOrEqual(t.span.end + 1);
        endingsKept(v, after);
        expect(after).not.toMatch(/\r?\n[ \t]*\r?\n[ \t]*\r?\n/);
        const re = parsed(after, path);
        expect(re.tasks.map(sig)).toEqual(file.tasks.filter((x) => x.uid !== t.uid).map(sig));
        expect(re.references).toEqual(file.references);
      }
    });

    it(`${title}: a body change rewrites only the body span`, () => {
      for (const t of spread(parsed(v.text, path).tasks)) {
        const body = "Rewritten body.\n\n```python\ndf.head()\n```";
        const after = ok(updateTask(v.text, t.uid, { body }, path));
        const w = window(v.text, after);
        // The closing fence itself can only change in a file with no final newline, where it is
        // the last line and has to gain a terminator before a body can follow it.
        expect(w.from, `${t.uid} first changed line`).toBeGreaterThanOrEqual(t.span.blockClose + (v.finalNewline ? 1 : 0));
        expect(w.toBefore, `${t.uid} last changed line`).toBeLessThanOrEqual(t.span.end);
        endingsKept(v, after);
        const re = parsed(after, path);
        expect(re.tasks.find((x) => x.uid === t.uid)!.body).toBe(body);
        expect(re.tasks.filter((x) => x.uid !== t.uid).map(sig)).toEqual(file.tasks.filter((x) => x.uid !== t.uid).map(sig));
      }
    });

    it(`${title}: a link change rewrites only the link region, list or not`, () => {
      for (const t of spread(parsed(v.text, path).tasks)) {
        const after = ok(updateTask(v.text, t.uid, { links: ["[One](https://one.test/)", "[Two](https://two.test/)"] }, path));
        const w = window(v.text, after);
        expect(w.from).toBeGreaterThan(t.span.blockOpen);
        expect(w.toBefore).toBeLessThan(t.span.blockClose);
        endingsKept(v, after);
        expect(parsed(after, path).tasks.find((x) => x.uid === t.uid)!.links).toEqual([
          { label: "One", url: "https://one.test/" },
          { label: "Two", url: "https://two.test/" },
        ]);
        // …and removing it again leaves the block one line shorter and nothing else.
        const none = ok(updateTask(after, t.uid, { links: null }, path));
        expect(parsed(none, path).tasks.find((x) => x.uid === t.uid)!.links).toEqual([]);
      }
    });

    it(`${title}: inserting after a task, in a section and at the end`, () => {
      const tasks = parsed(v.text, path).tasks;
      const anchor = tasks[tasks.length - 1]!;
      const section = tasks.find((t) => t.section)?.section;
      const specs = [
        { id: "P9A", title: "P9 after anchor", duration: "45m", type: "drill" as const, after: anchor.uid },
        { id: "P9B", title: "P9 at the end", duration: 150, type: "mock" as const, body: "With a body.\n\n| a | b |\n|---|---|\n| 1 | 2 |" },
        ...(section ? [{ id: "P9C", title: "P9 in a section", duration: "1h", type: "admin" as const, section }] : []),
      ];
      for (const spec of specs) {
        const after = ok(insertTask(v.text, spec, path));
        endingsKept(v, after);
        expect(after).not.toMatch(/\r?\n[ \t]*\r?\n[ \t]*\r?\n/);
        const re = parsed(after, path);
        const added = re.tasks.find((x) => x.id === spec.id)!;
        expect(added, spec.id).toBeDefined();
        expect(added.durationMin).toBe(spec.duration === 150 ? 150 : spec.duration === "45m" ? 45 : 60);
        if ("section" in spec) expect(added.section).toBe(spec.section);
        if ("after" in spec) expect(re.tasks[re.tasks.indexOf(added) - 1]!.uid).toBe(anchor.uid);
        if ("body" in spec) expect(added.body).toBe(spec.body);
        // Every task that was already there is untouched.
        expect(re.tasks.filter((x) => x.id !== spec.id).map(sig)).toEqual(file.tasks.map(sig));
        expect(re.references).toEqual(file.references);
        // Inserting and deleting again returns the file to its exact bytes (no drift, rule 6).
        expect(ok(deleteTask(after, `${file.meta.track}/${spec.id}`, path))).toBe(v.text);
      }
    });

    it(`${title}: a front-matter change rewrites only that key's line`, () => {
      const after = ok(updateMeta(v.text, { title: `${file.meta.title} (2026)` }, path));
      const w = window(v.text, after);
      expect(w.toBefore).toBe(w.from);
      expect(w.toAfter).toBe(w.from);
      expect(lines[w.from - 1]).toMatch(/^title:/);
      endingsKept(v, after);
      const re = parsed(after, path);
      expect(re.meta.title).toBe(`${file.meta.title} (2026)`);
      expect(re.tasks.map(sig)).toEqual(file.tasks.map(sig));
      // Appending a key touches only the line before the closing ---.
      const added = ok(updateMeta(v.text, { defaultDuration: 150 }, path));
      expect(parsed(added, path).meta.defaultDurationMin).toBe(150);
      const w2 = window(v.text, added);
      expect(lines[w2.from - 1]).toMatch(/^(default_duration:|---)/);
    });
  });

  it("the diff of an edit reconstructs the edited file exactly", () => {
    for (const t of spread(file.tasks)) {
      for (const after of [
        ok(updateTask(text, t.uid, { duration: 45, title: `${t.title}!` }, path)),
        ok(deleteTask(text, t.uid, path)),
        ok(insertTask(text, { id: "P9Z", title: "Added", duration: 30, type: "admin", after: t.uid }, path)),
      ]) {
        const patch = diff(text, after, path);
        expect(patch.startsWith(`--- a/${path}\n+++ b/${path}\n@@ `), "unified diff header").toBe(true);
        expect(applyDiff(text, patch), `${t.uid} diff must reconstruct the file`).toBe(after);
      }
    }
  });
});

describe("bcg.md, the awkward one", () => {
  const path = "resources/bcg.md";
  const text = source("bcg.md");
  const file = parsed(text, path);

  it("has the document features that break naive editors", () => {
    expect(file.tasks.length).toBeGreaterThanOrEqual(57);
    expect(text).toContain("## Contents");
    expect(text).toMatch(/^\|.*\|$/m); // tables
    expect(text).toMatch(/^> /m); // blockquotes
    expect(text).toContain("```python");
    // python fences live inside task bodies, which is why fence tracking has to be task-aware.
    expect(file.tasks.filter((t) => t.body.includes("```python")).length).toBeGreaterThan(20);
  });

  it("keeps the hand-written contents list byte-identical through every kind of edit (rule 7)", () => {
    const contents = (s: string) => s.slice(s.indexOf("## Contents"), s.indexOf("## 1. What the assessment is"));
    const first = file.tasks[0]!;
    const edits = [
      ok(updateTask(text, first.uid, { duration: 150, title: "Renamed", body: "New." }, path)),
      ok(deleteTask(text, first.uid, path)),
      ok(insertTask(text, { id: "NEW", title: "New task", duration: 30, type: "admin" }, path)),
      ok(updateMeta(text, { title: "Renamed plan", priority: 9 }, path)),
    ];
    for (const after of edits) expect(contents(after)).toBe(contents(text));
  });

  it("keeps trailing whitespace on lines it does not edit", () => {
    // The real files have none, so pad every blank line and prove the padding survives.
    const padded = text.replace(/^$/gm, "  ");
    const t = parsed(padded, path).tasks[3]!;
    const after = ok(updateTask(padded, t.uid, { duration: 55 }, path));
    expect(window(padded, after)).toMatchObject({ toBefore: window(padded, after).from });
    expect(after.split("\n").filter((l) => l === "  ").length).toBe(padded.split("\n").filter((l) => l === "  ").length);
    expect(parsed(after, path).tasks.find((x) => x.uid === t.uid)!.durationMin).toBe(55);
  });

  it("a long sequence of interleaved edits does not make the file drift (rule 6)", () => {
    let current = text;
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const tasks = parsed(current, path).tasks;
      const anchor = tasks[(i * 7) % tasks.length]!;
      const id = `P9D${i}`; // bcg already owns D1..D10
      ids.push(id);
      current = ok(insertTask(current, { id, title: `Drift ${i}`, duration: 30 + i, type: "drill", after: anchor.uid, body: `Body ${i}.` }, path));
      current = ok(updateTask(current, `bcg/${id}`, { duration: 60 + i, body: `Body ${i} again.` }, path));
    }
    const grown = parsed(current, path);
    expect(grown.tasks.length).toBe(file.tasks.length + 20);
    expect(current).not.toMatch(/\n\n\n/);
    for (const id of ids.reverse()) current = ok(deleteTask(current, `bcg/${id}`, path));
    // Back to the original bytes.
    expect(current).toBe(text);
  });

  it("rejects a bad edit with the parser's own message and returns no text", () => {
    const r = updateTask(text, "bcg/A1", { duration: "40" }, path);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("invalid");
    expect(r.error.message).toMatch(/invalid duration "40"/);
    expect(updateTask(text, "bcg/nope", { duration: 60 }, path)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(insertTask(text, { id: "A1", title: "Clash", duration: 30, type: "admin" }, path))
      .toMatchObject({ ok: false, error: { code: "duplicate" } });
  });
});

/** A minimal unified-diff applier, so invariant 1 is checked by reconstruction, not by trust. */
function applyDiff(before: string, patch: string): string {
  const a = before.split("\n");
  const hadFinalNewline = a[a.length - 1] === "";
  if (hadFinalNewline) a.pop();
  const out: string[] = [];
  let cursor = 0;
  let finalNewline = hadFinalNewline;
  let lastKind = " ";
  const patchLines = patch.split("\n");
  if (patchLines[patchLines.length - 1] === "") patchLines.pop();
  for (const l of patchLines) {
    if (l.startsWith("--- ") || l.startsWith("+++ ")) continue;
    const h = l.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    if (h) {
      const start = Number(h[2]) === 0 ? Number(h[1]) : Number(h[1]) - 1;
      while (cursor < start) out.push(a[cursor++]!);
      expect(cursor, "hunks must be in order").toBe(start);
      continue;
    }
    if (l === "\\ No newline at end of file") {
      if (lastKind !== "-") finalNewline = false;
      continue;
    }
    lastKind = l[0]!;
    const body = l.slice(1);
    if (lastKind === " " || lastKind === "-") {
      expect(a[cursor], "context and removed lines must match the original").toBe(body);
      cursor++;
      if (lastKind === " ") out.push(body);
    } else if (lastKind === "+") out.push(body);
  }
  while (cursor < a.length) out.push(a[cursor++]!);
  return out.join("\n") + (finalNewline ? "\n" : "");
}
