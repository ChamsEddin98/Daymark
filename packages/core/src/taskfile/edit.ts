/**
 * P9 surgical editor for task files: text in, text out. Pure, like the rest of
 * `packages/core` — no filesystem, no clock, no network, no `Date`.
 *
 * Byte fidelity is structural rather than best effort. A file is modelled as lines that each
 * carry their own terminator, and only whole lines are ever spliced, so every line an edit
 * does not name comes back byte-identical: trailing whitespace, CRLF or LF (even mixed), and
 * the presence or absence of a final newline. New lines use the file's dominant ending.
 *
 * Positions always come from `Task.span`, which the parser already computed; the editor never
 * re-derives one. Nothing throws: bad input comes back as `{ ok: false, error }`, the contract
 * `parseTaskFile` already keeps with its `errors`.
 */
import { extractLinks, formatDuration, parseDuration, parseTaskFile } from "./parse.ts";
import {
  FILE_KINDS,
  SCHEMA_ID,
  TASK_TYPES,
  type FileKind,
  type Link,
  type ParseIssue,
  type Task,
  type TaskFile,
  type TaskSpan,
  type TaskType,
} from "./types.ts";

// ---------------------------------------------------------------- result types

export type EditErrorCode =
  /** The text is not a task file (no front matter, unclosed fence, invalid YAML). */
  | "unparsable"
  /** A field of the request is missing or malformed. */
  | "invalid"
  /** `id`, `track` and `schema` cannot be changed; delete and re-create instead. */
  | "immutable"
  /** Unknown uid, or an `after`/`section` anchor that is not in the file. */
  | "not_found"
  /** The id is already used in this file. */
  | "duplicate"
  /** The edit produced text that does not parse, or not into the intended task. */
  | "broken_result"
  /**
   * The request named a field this editor does not have, or named none at all. Both are rejected
   * rather than ignored: silently accepting `{ durationMin: 150 }` would answer "ok" with an empty
   * diff, and the caller - usually Claude Code, over HTTP - would report a change that never happened.
   */
  | "unknown_field";

export interface EditError {
  code: EditErrorCode;
  message: string;
  /** Present when the message comes from the parser. */
  file?: string;
  /** 1-based file line, when one applies. */
  line?: number;
}

export interface EditOk {
  ok: true;
  /** The complete new file text. */
  text: string;
  /** Where the edited task now lives; absent for `deleteTask` and `updateMeta`. */
  span?: TaskSpan;
  /** The task as the new text parses, so callers never re-parse to answer. */
  task?: Task;
  /** The file as the new text parses. */
  file?: TaskFile;
  warnings?: string[];
}

export type EditResult = EditOk | { ok: false; error: EditError };

const fail = (code: EditErrorCode, message: string, where?: { file?: string; line?: number }): EditResult => ({
  ok: false,
  error: { code, message, ...(where?.file !== undefined && { file: where.file }), ...(where?.line !== undefined && { line: where.line }) },
});

// ------------------------------------------------------------------ line model

/** One file line: its content and its own terminator. `e` is "" only on a file with no final newline. */
interface L {
  t: string;
  e: string;
}

interface Doc {
  lines: L[];
  /** Line ending used for lines the editor adds. */
  eol: string;
}

function splitLines(text: string): L[] {
  const out: L[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      out.push({ t: text.slice(start, i), e: "\n" });
      start = i + 1;
    } else if (c === "\r") {
      const crlf = text[i + 1] === "\n";
      out.push({ t: text.slice(start, i), e: crlf ? "\r\n" : "\r" });
      if (crlf) i++;
      start = i + 1;
    }
  }
  if (start < text.length) out.push({ t: text.slice(start), e: "" });
  return out;
}

/** The ending most of the file uses; LF when the file has none. */
export function detectEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  if (crlf >= lf && crlf >= cr && crlf > 0) return "\r\n";
  if (cr > lf && cr > 0) return "\r";
  return "\n";
}

const load = (text: string): Doc => ({ lines: splitLines(text), eol: detectEol(text) });
const dump = (doc: Doc): string => doc.lines.map((l) => l.t + l.e).join("");
const isBlank = (l: L | undefined): boolean => l !== undefined && l.t.trim() === "";

/**
 * Replace `count` lines at `start` with `insert`. The tail property — whether the file ends
 * with a newline — travels with the last line, so it survives edits at the end of the file.
 */
function splice(doc: Doc, start: number, count: number, insert: string[]): void {
  const touchesTail = start + count >= doc.lines.length;
  const tailTerm = doc.lines.length ? doc.lines[doc.lines.length - 1]!.e : doc.eol;
  const items: L[] = insert.map((t) => ({ t, e: doc.eol }));
  if (touchesTail && items.length) items[items.length - 1]!.e = tailTerm;
  doc.lines.splice(start, count, ...items);
  if (touchesTail && !items.length && doc.lines.length) doc.lines[doc.lines.length - 1]!.e = tailTerm;
  // Any line that is no longer the last one has to carry a terminator. In a file that ended without
  // a final newline the old last line has none, so a line appended after it would be swallowed: the
  // blank line rule 6 asks for would silently become that line's terminator and disappear.
  for (let i = 0; i < doc.lines.length - 1; i++) if (doc.lines[i]!.e === "") doc.lines[i]!.e = doc.eol;
}

/**
 * Insert lines at the 0-based boundary `at`, with exactly one blank line on each side that has
 * a neighbour (P9 rule 6). Returns the 0-based index the first inserted line landed on.
 */
function insertLines(doc: Doc, at: number, content: string[]): number {
  let before = at;
  while (before > 0 && isBlank(doc.lines[before - 1])) before--;
  let after = at;
  while (after < doc.lines.length && isBlank(doc.lines[after])) after++;
  const pad = before > 0 ? 1 : 0;
  const mid = [...(pad ? [""] : []), ...content, ...(after < doc.lines.length ? [""] : [])];
  splice(doc, before, after - before, mid);
  return before + pad;
}

/**
 * Remove the 1-based inclusive line range, leaving exactly one blank line between the
 * neighbours it had (P9 rule 6). Returns the removed lines' content.
 */
function cutLines(doc: Doc, fromLine: number, toLine: number): string[] {
  const from = fromLine - 1;
  const to = toLine; // exclusive, 0-based
  const removed = doc.lines.slice(from, to).map((l) => l.t);
  let before = from;
  while (before > 0 && isBlank(doc.lines[before - 1])) before--;
  let after = to;
  while (after < doc.lines.length && isBlank(doc.lines[after])) after++;
  const keepBlank = before > 0 && after < doc.lines.length;
  splice(doc, before, after - before, keepBlank ? [""] : []);
  return removed;
}

const splitBody = (body: string): string[] => {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
};

// -------------------------------------------------------------------- headings

interface HeadingAt {
  level: number;
  text: string;
  /** 1-based file line. */
  line: number;
}

/**
 * Every heading in the file, fence-aware — the same rules `parse.ts` uses, so a `#` inside a
 * ```python block or a task block is not mistaken for one.
 */
function scanHeadings(doc: Doc): HeadingAt[] {
  const out: HeadingAt[] = [];
  let fence: string | null = null;
  doc.lines.forEach((l, i) => {
    const f = l.t.match(/^(```+|~~~+)\s*([\w-]*)[^`]*$/);
    if (fence) {
      if (f && l.t.trim().startsWith(fence) && !f[2]) fence = null;
      return;
    }
    if (f) {
      fence = f[1]!;
      return;
    }
    const h = l.t.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (h) out.push({ level: h[1]!.length, text: h[2]!.trim(), line: i + 1 });
  });
  return out;
}

const headingLevel = (line: string): number => line.match(/^(#{1,6})\s/)?.[1]?.length ?? 3;
const renderHeading = (level: number, title: string): string => `${"#".repeat(Math.min(6, Math.max(1, level)))} ${title}`;

// --------------------------------------------------------------- field writing

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TRACK_RE = /^[a-z0-9][a-z0-9-]*$/;
const BLOCK_KEY_ORDER = ["id", "duration", "type", "link", "repeat", "occurrences"] as const;
const META_KEY_ORDER = ["schema", "track", "title", "kind", "priority", "default_duration", "source_html", "starts_after"] as const;
const KEY_LINE_RE = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:/;
/** Plain YAML scalars that need no quoting and cannot be read as a number, bool or null. */
const SAFE_SCALAR_RE = /^[A-Za-z¡-￿][^:#\r\n]*$/;

const yamlQuote = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const yamlScalar = (s: string): string => (SAFE_SCALAR_RE.test(s) && s === s.trim() && !s.includes(" #") ? s : yamlQuote(s));

/** `[label](url)` for a labelled link, the bare URL when the label adds nothing. */
function renderLinkValue(link: Link): string {
  const label = link.label.trim();
  return label === "" || label === link.url ? yamlQuote(link.url) : yamlQuote(`[${label}](${link.url})`);
}

function asLink(raw: Link | string): Link | string {
  if (typeof raw === "object" && raw !== null) {
    const url = String(raw.url ?? "").trim();
    const label = String(raw.label ?? "").trim();
    if (!/^https?:\/\/\S+$/.test(url)) return `link url must be an http(s) URL, got: ${url || "(empty)"}`;
    if (/[\r\n]/.test(label) || /[\[\]]/.test(label)) return `link label may not contain newlines or brackets: ${label}`;
    return { label: label || url, url };
  }
  if (typeof raw !== "string") return "link entries must be strings or { label, url }";
  const s = raw.trim();
  const found = extractLinks(s);
  if (found.length === 1 && found[0]) return found[0];
  if (/^https?:\/\/\S+$/.test(s)) return { label: s, url: s };
  return `link must be "[label](https://…)" or a bare https URL, got: ${s}`;
}

function normaliseLinks(raw: readonly (Link | string)[] | Link | string | null | undefined): Link[] | string {
  if (raw === null || raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : [raw as Link | string];
  const out: Link[] = [];
  for (const entry of list) {
    const r = asLink(entry);
    if (typeof r === "string") return r;
    // Verify by reading back what we are about to write (the parser's own reader).
    const rendered = renderLinkValue(r);
    const back = asLink(rendered.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
    if (typeof back === "string" || back.url !== r.url) return `link cannot be written to YAML: ${r.url}`;
    out.push(r);
  }
  return out;
}

export interface TaskBlockFields {
  id: string;
  /** Minutes, or a duration string (`40m`, `2h`, `2h30m`). Rendered canonically. */
  duration: number | string;
  type: TaskType | string;
  links?: readonly (Link | string)[] | null;
  repeat?: "daily" | null;
  occurrences?: number | null;
}

function durationText(duration: number | string): string {
  const min = parseDuration(duration);
  return min === null ? String(duration) : formatDuration(min);
}

function blockLines(f: TaskBlockFields): string[] {
  const out = [`id: ${f.id}`, `duration: ${durationText(f.duration)}`, `type: ${f.type}`];
  const links = normaliseLinks(f.links);
  if (typeof links !== "string") {
    if (links.length === 1) out.push(`link: ${renderLinkValue(links[0]!)}`);
    else if (links.length > 1) {
      out.push("link:");
      for (const l of links) out.push(`  - ${renderLinkValue(l)}`);
    }
  }
  if (f.repeat) out.push(`repeat: ${f.repeat}`);
  if (f.occurrences !== undefined && f.occurrences !== null) out.push(`occurrences: ${f.occurrences}`);
  return out;
}

/**
 * The body of a ` ```task ` block (no fences), keys in canonical order:
 * `id, duration, type, link, repeat, occurrences`. 150 minutes renders as `2h30m`.
 */
export function renderTaskBlock(fields: TaskBlockFields): string {
  return blockLines(fields).join("\n");
}

// ------------------------------------------------------------ key-region edits

/** The lines a key owns: its own line plus any continuation lines (a YAML list). */
function keyRegion(lines: string[], key: string): { start: number; end: number } | null {
  const start = lines.findIndex((l) => KEY_LINE_RE.exec(l)?.[1] === key);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !KEY_LINE_RE.test(lines[end]!)) end++;
  return { start, end };
}

/**
 * Apply `{ key: lines | null }` to a YAML region, in place. Existing keys keep their position
 * and their order; a new key is appended; `null` removes the key and its continuation lines.
 */
function applyKeys(lines: string[], patch: [string, string[] | null][]): void {
  for (const [key, value] of patch) {
    const region = keyRegion(lines, key);
    if (region) {
      if (value === null) lines.splice(region.start, region.end - region.start);
      else lines.splice(region.start, region.end - region.start, ...value);
    } else if (value !== null) {
      lines.push(...value);
    }
  }
}

// ------------------------------------------------------------------- verifying

const issueKey = (i: ParseIssue): string => `${i.line}:${i.message}`;

/** Re-parse the proposed text and refuse anything that broke (P9 rule 1). */
function reparse(text: string, path: string, before: ParseIssue[]): { file: TaskFile } | { error: EditError } {
  const { file, errors } = parseTaskFile(text, path);
  const known = new Set(before.map(issueKey));
  const fresh = errors.filter((e) => !known.has(issueKey(e)));
  if (fresh.length) {
    const e = fresh[0]!;
    return { error: { code: "broken_result", message: `${e.file}:${e.line}: ${e.message}`, file: e.file, line: e.line } };
  }
  if (!file) return { error: { code: "broken_result", message: "the edited text is not a valid task file" } };
  return { file };
}

interface Expected {
  title: string;
  durationMin: number;
  type: string;
  links: Link[];
  repeat?: "daily";
  occurrences?: number;
  body: string;
}

const sameLinks = (a: Link[], b: Link[]): boolean =>
  a.length === b.length && a.every((l, i) => l.url === b[i]!.url && l.label === b[i]!.label);

/** P9 invariant 3: the re-parsed task is exactly the task the caller asked for. */
function roundTripError(task: Task, want: Expected): EditError | null {
  const mismatch =
    task.title !== want.title ? "title" :
    task.durationMin !== want.durationMin ? "duration" :
    task.type !== want.type ? "type" :
    !sameLinks(task.links, want.links) ? "link" :
    (task.repeat ?? undefined) !== want.repeat ? "repeat" :
    (task.occurrences ?? undefined) !== want.occurrences ? "occurrences" :
    task.body !== want.body ? "body" :
    null;
  if (!mismatch) return null;
  return {
    code: "broken_result",
    message: `the edit did not round-trip: ${mismatch} reads back differently (${task.uid})`,
    file: task.file,
    line: task.span.heading,
  };
}

// ------------------------------------------------------------------- lookup

/** Find a task by `track/id` or by bare id. Returns null when the file does not parse. */
export function findTask(text: string, uid: string, path = "task file"): Task | null {
  const { file } = parseTaskFile(text, path);
  if (!file) return null;
  return file.tasks.find((t) => t.uid === uid) ?? file.tasks.find((t) => t.id === uid) ?? null;
}

/** An unused task id for this file, continuing the numbering of the last task where it can. */
export function nextTaskId(text: string, path = "task file"): string {
  const { file } = parseTaskFile(text, path);
  const tasks = file?.tasks ?? [];
  const used = new Set(tasks.map((t) => t.id));
  const last = tasks.length ? tasks[tasks.length - 1]!.id : "";
  const m = last.match(/^(.*?)(\d+)$/);
  if (m) {
    let n = Number(m[2]) + 1;
    while (used.has(`${m[1]}${n}`)) n++;
    return `${m[1]}${n}`;
  }
  let n = tasks.length + 1;
  while (used.has(`T${n}`)) n++;
  return `T${n}`;
}

// ------------------------------------------------------------------ validation

/** Levenshtein distance, capped: only used to suggest the field the caller probably meant. */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
}

/**
 * Reject a request that names a field we do not have, or that names nothing at all. An ignored field
 * is the worst outcome available here: the call succeeds, the diff is empty, and whoever sent
 * `durationMin` instead of `duration` is told the duration changed. `requireSome` is off for the
 * shapes where "change nothing" is legitimate.
 */
function checkFields(
  patch: object,
  known: readonly string[],
  what: string,
  requireSome = true,
): string | null {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  for (const k of Object.keys(patch)) {
    if (known.includes(k)) continue;
    const near = known
      .map((c) => [c, editDistance(k.toLowerCase(), c.toLowerCase())] as const)
      .filter(([, d]) => d <= Math.max(2, Math.floor(k.length / 3)))
      .sort((x, y) => x[1] - y[1])[0]?.[0];
    return `unknown ${what} "${k}"${near ? `; did you mean "${near}"?` : ""}. Known: ${known.join(", ")}`;
  }
  if (requireSome && keys.length === 0) return `no fields to change; send at least one of: ${known.join(", ")}`;
  return null;
}

export const TASK_PATCH_FIELDS = [
  "title", "duration", "type", "links", "repeat", "occurrences", "body", "section", "id", "track",
] as const;
export const INSERT_FIELDS = [
  "id", "title", "duration", "type", "links", "repeat", "occurrences", "body", "section", "after",
] as const;
export const PLAN_FILE_FIELDS = ["track", "title", "kind", "priority", "defaultDuration", "startsAfter"] as const;

function validateCommon(
  fields: { duration?: number | string; type?: string; repeat?: "daily" | null; occurrences?: number | null },
): string | null {
  if (fields.duration !== undefined) {
    const min = parseDuration(fields.duration);
    if (min === null) return `invalid duration "${String(fields.duration)}"; use 40m, 2h or 2h30m`;
  }
  if (fields.type !== undefined && !TASK_TYPES.includes(fields.type as TaskType))
    return `type must be one of ${TASK_TYPES.join(", ")}`;
  if (fields.repeat !== undefined && fields.repeat !== null && fields.repeat !== "daily") return 'repeat must be "daily"';
  if (fields.occurrences !== undefined && fields.occurrences !== null &&
      (!Number.isInteger(fields.occurrences) || fields.occurrences < 1))
    return "occurrences must be a positive integer";
  return null;
}

/** A body may not contain anything that would end the task's section or open a task block. */
function validateBody(body: string, level: number): string | null {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let fence: string | null = null;
  for (const line of lines) {
    const f = line.match(/^(```+|~~~+)\s*([\w-]*)[^`]*$/);
    if (fence) {
      if (f && line.trim().startsWith(fence) && !f[2]) fence = null;
      continue;
    }
    if (f) {
      if (f[2] === "task") return "the body may not contain a ```task block";
      fence = f[1]!;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+\S/);
    if (h && h[1]!.length <= level)
      return `the body may not contain a level-${h[1]!.length} heading; the task heading is level ${level}, so it would end the task`;
  }
  if (fence) return "the body has an unclosed code fence";
  return null;
}

const titleError = (title: unknown): string | null =>
  typeof title !== "string" || !title.trim() ? "title is required"
    : /[\r\n]/.test(title) ? "title must be a single line"
    : /^#{1,6}\s/.test(title.trim()) ? "title must not start with #; the heading marks are added for you"
    : null;

// --------------------------------------------------------------- insertTask

export interface InsertSpec {
  /** Omitted: an unused id is derived from the file (reported in `warnings`). */
  id?: string;
  title: string;
  duration: number | string;
  type: TaskType | string;
  links?: readonly (Link | string)[] | null;
  repeat?: "daily" | null;
  occurrences?: number | null;
  body?: string;
  /** Heading text of the section to append to. Created at the end of the file when unknown. */
  section?: string;
  /** A task uid (or bare id) to place the new task directly behind. Wins over `section`. */
  after?: string;
}

/** Insert a heading, its ` ```task ` block and its body, placed per the `after`/`section` rules. */
export function insertTask(text: string, spec: InsertSpec, path = "task file"): EditResult {
  const { file, errors } = parseTaskFile(text, path);
  if (!file) {
    const e = errors[0];
    return fail("unparsable", e ? `${e.file}:${e.line}: ${e.message}` : "not a task file", e);
  }
  const fErr = checkFields(spec, INSERT_FIELDS, "task field", false);
  if (fErr) return fail("unknown_field", fErr);
  const tErr = titleError(spec.title);
  if (tErr) return fail("invalid", tErr);
  const vErr = validateCommon(spec);
  if (vErr) return fail("invalid", vErr);
  if (spec.occurrences !== undefined && spec.occurrences !== null && !spec.repeat)
    return fail("invalid", "occurrences needs repeat: daily");
  const links = normaliseLinks(spec.links);
  if (typeof links === "string") return fail("invalid", links);

  const warnings: string[] = [];
  let id = spec.id;
  if (id === undefined) {
    id = nextTaskId(text, path);
    warnings.push(`id was generated: ${id}`);
  }
  if (!ID_RE.test(id)) return fail("invalid", `task id "${id}" must match ${ID_RE}`);
  if (file.tasks.some((t) => t.id === id)) return fail("duplicate", `task id "${id}" already exists in ${path}`);

  const doc = load(text);
  const headings = scanHeadings(doc);
  const taskLines = new Set(file.tasks.map((t) => t.span.heading));

  // ---- where it goes, and at which heading level
  let at: number;
  let level: number;
  if (spec.after !== undefined) {
    const anchor = file.tasks.find((t) => t.uid === spec.after) ?? file.tasks.find((t) => t.id === spec.after);
    if (!anchor) return fail("not_found", `no task "${spec.after}" in ${path} to insert after`);
    at = anchor.span.end; // 0-based index of the line after the anchor's last line
    level = headingLevel(doc.lines[anchor.span.heading - 1]?.t ?? "");
  } else if (spec.section !== undefined) {
    const want = spec.section.trim();
    const section =
      headings.find((h) => !taskLines.has(h.line) && h.text === want) ??
      headings.find((h) => !taskLines.has(h.line) && h.text.toLowerCase() === want.toLowerCase());
    if (section) {
      const next = headings.find((h) => h.line > section.line && h.level <= section.level);
      at = next ? next.line - 1 : doc.lines.length;
      const inside = file.tasks.filter((t) => t.span.heading > section.line && (!next || t.span.heading < next.line));
      level = inside.length
        ? headingLevel(doc.lines[inside[inside.length - 1]!.span.heading - 1]?.t ?? "")
        : section.level + 1;
    } else {
      // Unknown section: open one at the end of the file, at the level the file uses for sections.
      const lastTask = file.tasks[file.tasks.length - 1];
      const sectionLevel = lastTask
        ? Math.max(1, headingLevel(doc.lines[lastTask.span.heading - 1]?.t ?? "") - 1)
        : 2;
      insertLines(doc, doc.lines.length, [renderHeading(sectionLevel, want)]);
      warnings.push(`section "${want}" did not exist and was added at the end of the file`);
      at = doc.lines.length;
      level = sectionLevel + 1;
    }
  } else {
    at = doc.lines.length;
    const lastTask = file.tasks[file.tasks.length - 1];
    level = lastTask ? headingLevel(doc.lines[lastTask.span.heading - 1]?.t ?? "") : 3;
  }

  const body = spec.body ?? "";
  const bErr = validateBody(body, level);
  if (bErr) return fail("invalid", bErr);
  const bodyLines = splitBody(body);

  const block = blockLines({ id, duration: spec.duration, type: spec.type, links,
    ...(spec.repeat ? { repeat: spec.repeat } : {}),
    ...(spec.occurrences !== undefined && spec.occurrences !== null ? { occurrences: spec.occurrences } : {}) });
  const content = [renderHeading(level, spec.title.trim()), "", "```task", ...block, "```",
    ...(bodyLines.length ? ["", ...bodyLines] : [])];
  insertLines(doc, at, content);

  const out = dump(doc);
  const checked = reparse(out, path, errors);
  if ("error" in checked) return { ok: false, error: checked.error };
  const uid = `${file.meta.track}/${id}`;
  const task = checked.file.tasks.find((t) => t.uid === uid);
  if (!task) return fail("broken_result", `the inserted task ${uid} is not in the result`);
  const rt = roundTripError(task, {
    title: spec.title.trim(),
    durationMin: parseDuration(spec.duration)!,
    type: String(spec.type),
    links,
    ...(spec.repeat ? { repeat: "daily" as const } : {}),
    ...(spec.occurrences !== undefined && spec.occurrences !== null ? { occurrences: spec.occurrences } : {}),
    body: bodyLines.join("\n"),
  });
  if (rt) return { ok: false, error: rt };
  return { ok: true, text: out, span: task.span, task, file: checked.file, ...(warnings.length && { warnings }) };
}

// --------------------------------------------------------------- updateTask

export interface TaskPatch {
  title?: string;
  duration?: number | string;
  type?: TaskType | string;
  /** `null` or `[]` removes the `link` key. */
  links?: readonly (Link | string)[] | null;
  /** `null` removes `repeat` (and `occurrences` with it). */
  repeat?: "daily" | null;
  occurrences?: number | null;
  body?: string;
  /** Moves the whole task section under another heading. */
  section?: string;
  /** Rejected: the uid is what progress, plan items and calendar events key on (P9 rule 3). */
  id?: string;
  track?: string;
}

/** Rewrite only the heading line, the changed keys in the task block and the body span. */
export function updateTask(text: string, uid: string, patch: TaskPatch, path = "task file"): EditResult {
  const { file, errors } = parseTaskFile(text, path);
  if (!file) {
    const e = errors[0];
    return fail("unparsable", e ? `${e.file}:${e.line}: ${e.message}` : "not a task file", e);
  }
  const fErr = checkFields(patch, TASK_PATCH_FIELDS, "task field");
  if (fErr) return fail("unknown_field", fErr);
  const task = file.tasks.find((t) => t.uid === uid) ?? file.tasks.find((t) => t.id === uid);
  if (!task) return fail("not_found", `no task "${uid}" in ${path}`);
  // `repeat: null` takes `occurrences` with it, so asking for both at once is a contradiction.
  // Applying the stronger half silently is exactly the "ok, but not what you asked for" answer
  // the unknown-field check exists to prevent - insertTask already refuses the same pairing.
  if (patch.repeat === null && patch.occurrences !== undefined && patch.occurrences !== null)
    return fail("invalid", "occurrences needs repeat: daily, but this patch removes repeat; send one or the other");
  if (patch.id !== undefined && patch.id !== task.id)
    return fail("immutable", "id is immutable: stored progress, plan items and calendar events key on it; delete the task and create a new one");
  if (patch.track !== undefined && patch.track !== task.track)
    return fail("immutable", "track is immutable: it is half of the task uid; create a task in the other plan instead");
  if (patch.title !== undefined) {
    const tErr = titleError(patch.title);
    if (tErr) return fail("invalid", tErr);
  }
  const vErr = validateCommon(patch);
  if (vErr) return fail("invalid", vErr);

  const links = patch.links === undefined ? task.links : normaliseLinks(patch.links);
  if (typeof links === "string") return fail("invalid", links);
  const repeat = patch.repeat === undefined ? task.repeat : (patch.repeat ?? undefined);
  const occurrences = patch.repeat === null
    ? undefined
    : patch.occurrences === undefined ? task.occurrences : (patch.occurrences ?? undefined);
  if (occurrences !== undefined && repeat === undefined) return fail("invalid", "occurrences needs repeat: daily");
  const durationMin = patch.duration === undefined ? task.durationMin : parseDuration(patch.duration)!;
  const title = patch.title === undefined ? task.title : patch.title.trim();
  const type = patch.type === undefined ? task.type : String(patch.type);

  const doc = load(text);
  const level = headingLevel(doc.lines[task.span.heading - 1]?.t ?? "");
  if (patch.body !== undefined) {
    const bErr = validateBody(patch.body, level);
    if (bErr) return fail("invalid", bErr);
  }
  const bodyLines = patch.body === undefined ? null : splitBody(patch.body);

  // Bottom-up, so every span the parser gave stays valid while earlier regions are rewritten.
  if (bodyLines) {
    const from = task.span.blockClose; // 0-based index of the first body line
    const count = task.span.end - task.span.blockClose;
    const following = task.span.end < doc.lines.length;
    const region = bodyLines.length
      ? ["", ...bodyLines, ...(following ? [""] : [])]
      : following ? [""] : [];
    splice(doc, from, count, region);
  }

  const keyPatch: [string, string[] | null][] = [];
  if (patch.duration !== undefined) keyPatch.push(["duration", [`duration: ${durationText(patch.duration)}`]]);
  if (patch.type !== undefined) keyPatch.push(["type", [`type: ${type}`]]);
  if (patch.links !== undefined)
    keyPatch.push(["link", links.length === 0 ? null
      : links.length === 1 ? [`link: ${renderLinkValue(links[0]!)}`]
      : ["link:", ...links.map((l) => `  - ${renderLinkValue(l)}`)]]);
  if (patch.repeat !== undefined) keyPatch.push(["repeat", repeat ? [`repeat: ${repeat}`] : null]);
  if (patch.repeat === null || patch.occurrences !== undefined)
    keyPatch.push(["occurrences", occurrences === undefined ? null : [`occurrences: ${occurrences}`]]);
  if (keyPatch.length) {
    const from = task.span.blockOpen; // 0-based index of the first line inside the block
    const count = task.span.blockClose - task.span.blockOpen - 1;
    const interior = doc.lines.slice(from, from + count).map((l) => l.t);
    // Keep canonical order for keys we have to append.
    keyPatch.sort((a, b) => BLOCK_KEY_ORDER.indexOf(a[0] as never) - BLOCK_KEY_ORDER.indexOf(b[0] as never));
    applyKeys(interior, keyPatch);
    splice(doc, from, count, interior);
  }

  if (patch.title !== undefined && title !== task.title)
    splice(doc, task.span.heading - 1, 1, [renderHeading(level, title)]);

  let out = dump(doc);

  // A section change moves the whole section; everything else is already written.
  const warnings: string[] = [];
  const wantSection = patch.section === undefined ? undefined : patch.section.trim();
  if (wantSection !== undefined && wantSection !== (task.section ?? "")) {
    const moved = moveTaskToSection(out, task.uid, wantSection, path, errors);
    if (!moved.ok) return moved;
    out = moved.text;
    if (moved.warnings) warnings.push(...moved.warnings);
  }

  const checked = reparse(out, path, errors);
  if ("error" in checked) return { ok: false, error: checked.error };
  const after = checked.file.tasks.find((t) => t.uid === task.uid);
  if (!after) return fail("broken_result", `the updated task ${task.uid} is not in the result`);
  const rt = roundTripError(after, {
    title, durationMin, type, links,
    ...(repeat ? { repeat } : {}),
    ...(occurrences !== undefined ? { occurrences } : {}),
    body: bodyLines ? bodyLines.join("\n") : task.body,
  });
  if (rt) return { ok: false, error: rt };
  return { ok: true, text: out, span: after.span, task: after, file: checked.file, ...(warnings.length && { warnings }) };
}

/** Cut the task's lines and re-insert them, unchanged apart from the heading level, elsewhere. */
function moveTaskToSection(text: string, uid: string, section: string, path: string, known: ParseIssue[]): EditResult {
  const { file, errors } = parseTaskFile(text, path);
  if (!file) return fail("unparsable", "not a task file");
  const task = file.tasks.find((t) => t.uid === uid);
  if (!task) return fail("not_found", `no task "${uid}" in ${path}`);
  const doc = load(text);
  const headings = scanHeadings(doc);
  const taskLines = new Set(file.tasks.map((t) => t.span.heading));
  const target =
    headings.find((h) => !taskLines.has(h.line) && h.text === section) ??
    headings.find((h) => !taskLines.has(h.line) && h.text.toLowerCase() === section.toLowerCase());
  const warnings: string[] = [];

  const cut = cutLines(doc, task.span.heading, task.span.end);
  while (cut.length && cut[cut.length - 1]!.trim() === "") cut.pop();

  let at: number;
  let level: number;
  if (target) {
    // Positions shift when the cut was above the target, so re-scan the cut document.
    const after = scanHeadings(doc);
    const t2 = after.find((h) => h.level === target.level && h.text === target.text);
    if (!t2) return fail("not_found", `section "${section}" vanished while moving ${uid}`);
    const next = after.find((h) => h.line > t2.line && h.level <= t2.level);
    at = next ? next.line - 1 : doc.lines.length;
    level = t2.level + 1;
  } else {
    const sectionLevel = Math.max(1, headingLevel(cut[0] ?? "") - 1);
    insertLines(doc, doc.lines.length, [renderHeading(sectionLevel, section)]);
    warnings.push(`section "${section}" did not exist and was added at the end of the file`);
    at = doc.lines.length;
    level = sectionLevel + 1;
  }
  if (cut.length) cut[0] = renderHeading(level, task.title);
  insertLines(doc, at, cut);
  const out = dump(doc);
  const checked = reparse(out, path, [...known, ...errors]);
  if ("error" in checked) return { ok: false, error: checked.error };
  return { ok: true, text: out, ...(warnings.length && { warnings }) };
}

// --------------------------------------------------------------- deleteTask

/** Remove `span.heading` through `span.end`, leaving exactly one blank line behind (rule 6). */
export function deleteTask(text: string, uid: string, path = "task file"): EditResult {
  const { file, errors } = parseTaskFile(text, path);
  if (!file) {
    const e = errors[0];
    return fail("unparsable", e ? `${e.file}:${e.line}: ${e.message}` : "not a task file", e);
  }
  const task = file.tasks.find((t) => t.uid === uid) ?? file.tasks.find((t) => t.id === uid);
  if (!task) return fail("not_found", `no task "${uid}" in ${path}`);
  const doc = load(text);
  cutLines(doc, task.span.heading, task.span.end);
  const out = dump(doc);
  const checked = reparse(out, path, errors);
  if ("error" in checked) return { ok: false, error: checked.error };
  if (checked.file.tasks.some((t) => t.uid === task.uid))
    return fail("broken_result", `${task.uid} is still in the file after deleting it`);
  return { ok: true, text: out, file: checked.file };
}

// ---------------------------------------------------------------- updateMeta

/** Front-matter keys a PATCH may change, in the file's own spelling and the API's. */
const META_ALIASES: Record<string, string> = {
  title: "title",
  kind: "kind",
  priority: "priority",
  default_duration: "default_duration",
  defaultDuration: "default_duration",
  defaultDurationMin: "default_duration",
  starts_after: "starts_after",
  startsAfter: "starts_after",
  source_html: "source_html",
  sourceHtml: "source_html",
};

export type MetaPatch = Record<string, string | number | null | undefined>;

/**
 * Surgical front-matter edits, by line. The YAML is never round-tripped — that would reorder
 * keys and drop comments. Changed keys are rewritten where they are, new keys are appended
 * before the closing `---`, and a key set to `null` is removed.
 */
export function updateMeta(text: string, patch: MetaPatch, path = "task file"): EditResult {
  const { file, errors } = parseTaskFile(text, path);
  if (!file) {
    const e = errors[0];
    return fail("unparsable", e ? `${e.file}:${e.line}: ${e.message}` : "not a task file", e);
  }
  // The alias table below already rejects an unknown key by name; this only adds the "you sent me
  // nothing" case and the did-you-mean suggestion, so the two never disagree about what is known.
  const fErr = checkFields(patch, [...Object.keys(META_ALIASES), "track", "schema"], "front-matter key");
  if (fErr) return fail("unknown_field", fErr);
  const resolved: [string, string[] | null][] = [];
  // The kind the file will have decides whether priority may be absent.
  const nextKind = patch.kind === undefined || patch.kind === null ? file.meta.kind : String(patch.kind);
  const keepsPriority = patch.priority !== undefined && patch.priority !== null
    ? true
    : patch.priority === null ? false : file.meta.priority !== undefined;
  if (nextKind === "prep" && !keepsPriority)
    return fail("invalid", "prep files need a priority");
  for (const [rawKey, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (rawKey === "schema" || rawKey === "track")
      return fail("immutable", `${rawKey} is immutable: every task uid and calendar key is derived from it`);
    const key = META_ALIASES[rawKey];
    if (!key) return fail("invalid", `unknown front-matter key "${rawKey}"`);
    if (value === null) {
      if (key === "title" || key === "kind") return fail("invalid", `${key} is required and cannot be removed`);
      resolved.push([key, null]);
      continue;
    }
    let rendered: string;
    switch (key) {
      case "kind":
        if (!FILE_KINDS.includes(String(value) as FileKind)) return fail("invalid", `kind must be one of ${FILE_KINDS.join(", ")}`);
        rendered = String(value);
        break;
      case "priority":
        if (!Number.isInteger(Number(value))) return fail("invalid", "priority must be an integer");
        rendered = String(Number(value));
        break;
      case "default_duration": {
        const min = parseDuration(value);
        if (min === null) return fail("invalid", `invalid default_duration "${String(value)}"; use 40m, 2h or 2h30m`);
        rendered = formatDuration(min);
        break;
      }
      case "starts_after":
        if (!TRACK_RE.test(String(value))) return fail("invalid", 'starts_after must be a track slug like "bcg"');
        rendered = String(value);
        break;
      default: {
        const s = String(value);
        if (/[\r\n]/.test(s)) return fail("invalid", `${key} must be a single line`);
        if (key === "title" && !s.trim()) return fail("invalid", "title is required");
        rendered = yamlScalar(s);
      }
    }
    resolved.push([key, [`${key}: ${rendered}`]]);
  }
  if (!resolved.length) return { ok: true, text, file };

  const doc = load(text);
  if (doc.lines[0]?.t.trim() !== "---") return fail("unparsable", "file does not start with front matter");
  const close = doc.lines.findIndex((l, i) => i > 0 && l.t.trim() === "---");
  if (close < 0) return fail("unparsable", "front matter is not closed");
  const fm = doc.lines.slice(1, close).map((l) => l.t);
  // Canonical order for keys that have to be appended.
  resolved.sort((a, b) => META_KEY_ORDER.indexOf(a[0] as never) - META_KEY_ORDER.indexOf(b[0] as never));
  applyKeys(fm, resolved);
  splice(doc, 1, close - 1, fm);

  const out = dump(doc);
  const checked = reparse(out, path, errors);
  if ("error" in checked) return { ok: false, error: checked.error };
  return { ok: true, text: out, file: checked.file };
}

// -------------------------------------------------------------- renderPlanFile

export interface PlanMetaInput {
  track: string;
  title: string;
  kind: FileKind | string;
  priority?: number;
  /** Minutes or a duration string. */
  defaultDuration?: number | string;
  startsAfter?: string;
}

/** A new, empty, valid task file: front matter, an H1 of the title and the optional intro. */
export function renderPlanFile(meta: PlanMetaInput, intro?: string, opts?: { eol?: string }): EditResult {
  const eol = opts?.eol ?? "\n";
  const fErr = checkFields(meta, PLAN_FILE_FIELDS, "plan field", false);
  if (fErr) return fail("unknown_field", fErr);
  if (!TRACK_RE.test(meta.track)) return fail("invalid", 'track must be a slug like "bcg" ([a-z0-9][a-z0-9-]*)');
  const tErr = titleError(meta.title);
  if (tErr) return fail("invalid", tErr);
  if (!FILE_KINDS.includes(meta.kind as FileKind)) return fail("invalid", `kind must be one of ${FILE_KINDS.join(", ")}`);
  if (meta.priority !== undefined && !Number.isInteger(meta.priority)) return fail("invalid", "priority must be an integer");
  if (meta.kind === "prep" && meta.priority === undefined) return fail("invalid", "prep files need a priority");
  if (meta.startsAfter !== undefined && !TRACK_RE.test(meta.startsAfter))
    return fail("invalid", 'starts_after must be a track slug like "bcg"');
  let defaultDuration: string | undefined;
  if (meta.defaultDuration !== undefined) {
    const min = parseDuration(meta.defaultDuration);
    if (min === null) return fail("invalid", `invalid default_duration "${String(meta.defaultDuration)}"; use 40m, 2h or 2h30m`);
    defaultDuration = formatDuration(min);
  }
  const title = meta.title.trim();
  const lines = ["---", `schema: ${SCHEMA_ID}`, `track: ${meta.track}`, `title: ${yamlScalar(title)}`, `kind: ${meta.kind}`];
  if (meta.priority !== undefined) lines.push(`priority: ${meta.priority}`);
  if (defaultDuration !== undefined) lines.push(`default_duration: ${defaultDuration}`);
  if (meta.startsAfter !== undefined) lines.push(`starts_after: ${meta.startsAfter}`);
  lines.push("---", "", `# ${title}`);
  const introLines = splitBody(intro ?? "");
  if (introLines.length) lines.push("", ...introLines);
  const text = lines.map((l) => l + eol).join("");
  const path = `${meta.track}.md`;
  const checked = reparse(text, path, []);
  if ("error" in checked) return { ok: false, error: checked.error };
  return { ok: true, text, file: checked.file };
}

// ----------------------------------------------------------------------- diff

const CONTEXT = 3;
type Op = [" " | "-" | "+", string];

function diffSides(text: string): { lines: string[]; noFinalNewline: boolean } {
  if (text === "") return { lines: [], noFinalNewline: false };
  // Split on "\n" only, so a CR stays part of the line, exactly as git reports it.
  const lines = text.split("\n");
  const trailing = lines[lines.length - 1] === "";
  if (trailing) lines.pop();
  return { lines, noFinalNewline: !trailing };
}

function middleOps(a: string[], b: string[]): Op[] {
  if (!a.length) return b.map((l): Op => ["+", l]);
  if (!b.length) return a.map((l): Op => ["-", l]);
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return [...a.map((l): Op => ["-", l]), ...b.map((l): Op => ["+", l])];
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + j + 1]! + 1
        : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([" ", a[i]!]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      out.push(["-", a[i]!]);
      i++;
    } else {
      out.push(["+", b[j]!]);
      j++;
    }
  }
  while (i < n) out.push(["-", a[i++]!]);
  while (j < m) out.push(["+", b[j++]!]);
  return out;
}

function allOps(a: string[], b: string[]): Op[] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const ops: Op[] = [];
  for (let i = 0; i < p; i++) ops.push([" ", a[i]!]);
  ops.push(...middleOps(a.slice(p, a.length - s), b.slice(p, b.length - s)));
  for (let i = a.length - s; i < a.length; i++) ops.push([" ", a[i]!]);
  return ops;
}

/**
 * A standard unified diff with `---`/`+++` headers and `@@` hunks, three lines of context.
 * No dependency: the API has to return one of these on every mutation.
 */
export function diff(before: string, after: string, path = "file"): string {
  if (before === after) return "";
  const A = diffSides(before);
  const B = diffSides(after);
  const ops = allOps(A.lines, B.lines);
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let ol = 1;
  let nl = 1;
  for (const [kind] of ops) {
    oldNo.push(ol);
    newNo.push(nl);
    if (kind !== "+") ol++;
    if (kind !== "-") nl++;
  }
  const changed = ops.map(([k], i) => (k === " " ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return "";
  const groups: [number, number][] = [];
  for (const i of changed) {
    const last = groups[groups.length - 1];
    if (last && i - last[1] <= CONTEXT * 2 + 1) last[1] = i;
    else groups.push([i, i]);
  }
  const out: string[] = [
    `--- ${before === "" ? "/dev/null" : `a/${path}`}`,
    `+++ ${after === "" ? "/dev/null" : `b/${path}`}`,
  ];
  for (const [g0, g1] of groups) {
    const start = Math.max(0, g0 - CONTEXT);
    const end = Math.min(ops.length - 1, g1 + CONTEXT);
    let oldCount = 0;
    let newCount = 0;
    for (let i = start; i <= end; i++) {
      if (ops[i]![0] !== "+") oldCount++;
      if (ops[i]![0] !== "-") newCount++;
    }
    const oldStart = oldCount ? oldNo[start]! : oldNo[start]! - 1;
    const newStart = newCount ? newNo[start]! : newNo[start]! - 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (let i = start; i <= end; i++) {
      const [kind, line] = ops[i]!;
      out.push(kind + line);
      const lastOld = kind !== "+" && oldNo[i] === A.lines.length;
      const lastNew = kind !== "-" && newNo[i] === B.lines.length;
      if ((lastOld && A.noFinalNewline) || (lastNew && B.noFinalNewline))
        out.push("\\ No newline at end of file");
    }
  }
  return out.join("\n") + "\n";
}
