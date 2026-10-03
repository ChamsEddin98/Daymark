import { parse as parseYaml } from "yaml";
import {
  FILE_KINDS,
  SCHEMA_ID,
  TASK_TYPES,
  type FileKind,
  type FileMeta,
  type Link,
  type ParseIssue,
  type ParseResult,
  type Task,
  type TaskType,
} from "./types.ts";

const TASK_KEYS = new Set(["id", "duration", "type", "link", "repeat", "occurrences"]);
const FILE_KEYS = new Set(["schema", "track", "title", "kind", "priority", "default_duration", "source_html", "starts_after"]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MD_LINK_RE = /\[((?:[^\[\]]|\[[^\]]*\])*)\]\((https?:\/\/[^\s)]+(?:\([^\s)]*\)[^\s)]*)*)\)/g;
const AUTOLINK_RE = /<(https?:\/\/[^>\s]+)>/g;
const BARE_URL_RE = /https?:\/\/[^\s<>()\[\]`]+/g;
const firstLine = (e: unknown) => ((e as Error).message ?? String(e)).split("\n")[0]!.trim();

/** "40m" | "2h" | "2h30m" | "1h 30m" | 90 (minutes) -> minutes. */
export function parseDuration(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(?:(\d+)h)?\s*(?:(\d+)m)?$/);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const min = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  return min > 0 ? min : null;
}

export function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h && m ? `${h}h${m}m` : h ? `${h}h` : `${m}m`;
}

/** Every http(s) link in a markdown fragment, skipping fenced code. */
export function extractLinks(markdown: string): Link[] {
  const out: Link[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(MD_LINK_RE)) out.push({ label: m[1]!.trim(), url: m[2]! });
    for (const m of line.matchAll(AUTOLINK_RE)) out.push({ label: m[1]!, url: m[1]! });
    const rest = line.replace(MD_LINK_RE, " ").replace(AUTOLINK_RE, " ").replace(/`[^`]*`/g, " ");
    for (const m of rest.matchAll(BARE_URL_RE)) {
      const url = m[0].replace(/[.,;:!?'"]+$/, "");
      out.push({ label: url, url });
    }
  }
  return out;
}

function parseLinkValue(raw: unknown): Link | string {
  if (typeof raw !== "string") return "link entries must be strings";
  const s = raw.trim();
  const found = extractLinks(s);
  let link: Link;
  if (found.length === 1 && found[0]) link = found[0];
  else if (/^https?:\/\/\S+$/.test(s)) link = { label: s, url: s };
  else return `link must be "[label](https://…)" or a bare https URL, got: ${s}`;
  try {
    new URL(link.url);
  } catch {
    return `invalid URL: ${link.url}`;
  }
  return link;
}

interface Heading {
  level: number;
  text: string;
  line: number; // 0-based index into body lines
}

/**
 * Parse one task file. Never throws: structural problems come back as `errors` with
 * 1-based line numbers so a bad drop-in file is reported, not fatal.
 */
export function parseTaskFile(text: string, path: string): ParseResult {
  const errors: ParseIssue[] = [];
  const err = (line: number, message: string) => errors.push({ file: path, line, message });
  const src = text.replace(/\r\n?/g, "\n");

  // ---- front matter
  const fm = src.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) {
    err(1, /^---\n/.test(src)
      ? "front matter is not closed: add a line containing only --- after the last key"
      : "missing YAML front matter (file must start with ---)");
    return { file: null, errors };
  }
  const fmLineCount = fm[0].split("\n").length - 1;
  let rawMeta: Record<string, unknown>;
  try {
    rawMeta = (parseYaml(fm[1]!) ?? {}) as Record<string, unknown>;
  } catch (e) {
    const pos = (e as { linePos?: { line: number }[] }).linePos?.[0]?.line;
    err(pos ? pos + 1 : 2, `front matter is not valid YAML: ${firstLine(e).replace(/ at line \d+, column \d+:?$/, "")}`);
    return { file: null, errors };
  }
  // File line of a front-matter key (line 1 is the opening ---); 1 when the key is absent.
  const fmLines = fm[1]!.split("\n");
  const at = (key: string) => {
    const i = fmLines.findIndex((l) => l.startsWith(`${key}:`));
    return i < 0 ? 1 : i + 2;
  };
  for (const k of Object.keys(rawMeta)) if (!FILE_KEYS.has(k)) err(at(k), `unknown front-matter key "${k}"`);
  if (rawMeta.schema !== SCHEMA_ID) err(at("schema"), `schema must be "${SCHEMA_ID}"`);
  if (typeof rawMeta.track !== "string" || !ID_RE.test(rawMeta.track)) err(at("track"), "track must be a slug like \"bcg\"");
  if (typeof rawMeta.title !== "string" || !rawMeta.title.trim()) err(at("title"), "title is required");
  if (!FILE_KINDS.includes(rawMeta.kind as FileKind)) err(at("kind"), `kind must be one of ${FILE_KINDS.join(", ")}`);
  if (rawMeta.priority !== undefined && !Number.isInteger(rawMeta.priority)) err(at("priority"), "priority must be an integer");
  if (rawMeta.kind === "prep" && rawMeta.priority === undefined) err(at("kind"), "prep files need a priority");
  let defaultDurationMin: number | undefined;
  if (rawMeta.default_duration !== undefined) {
    defaultDurationMin = parseDuration(rawMeta.default_duration) ?? undefined;
    if (defaultDurationMin === undefined)
      err(at("default_duration"), `bad default_duration "${String(rawMeta.default_duration)}"`);
  }
  if (rawMeta.starts_after !== undefined && (typeof rawMeta.starts_after !== "string" || !ID_RE.test(rawMeta.starts_after)))
    err(at("starts_after"), "starts_after must be a track slug");
  if (errors.length) return { file: null, errors };

  const meta: FileMeta = {
    schema: SCHEMA_ID,
    track: rawMeta.track as string,
    title: (rawMeta.title as string).trim(),
    kind: rawMeta.kind as FileKind,
    ...(rawMeta.priority !== undefined && { priority: rawMeta.priority as number }),
    ...(defaultDurationMin !== undefined && { defaultDurationMin }),
    ...(typeof rawMeta.source_html === "string" && { sourceHtml: rawMeta.source_html }),
    ...(typeof rawMeta.starts_after === "string" && { startsAfter: rawMeta.starts_after }),
  };

  // ---- body scan: headings and task blocks, fence-aware
  const lines = src.slice(fm[0].length).split("\n");
  const lineNo = (i: number) => i + fmLineCount + 1;
  // A trailing newline makes split() yield a phantom empty entry; it is not a file line.
  const bodyLineCount = src.endsWith("\n") ? lines.length - 1 : lines.length;
  const headings: Heading[] = [];
  const taskBlocks: { open: number; close: number }[] = [];
  let fence: { marker: string; open: number; isTask: boolean } | null = null;
  lines.forEach((line, i) => {
    // Info strings may carry attributes (```python title="x.py"); only the first word matters.
    const f = line.match(/^(```+|~~~+)\s*([\w-]*)[^`]*$/);
    if (fence) {
      if (f && line.trim().startsWith(fence.marker) && !f[2]) {
        if (fence.isTask) taskBlocks.push({ open: fence.open, close: i });
        fence = null;
      }
      return;
    }
    if (f) {
      fence = { marker: f[1]!, open: i, isTask: f[2] === "task" };
      return;
    }
    // CommonMark: closing #s only count when preceded by whitespace ("Read: C#" keeps its #).
    const h = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (h) headings.push({ level: h[1]!.length, text: h[2]!.trim(), line: i });
  });
  if (fence) err(lineNo((fence as { open: number }).open), "unclosed code fence");

  const tasks: Task[] = [];
  const ownedByTask = new Set<number>();
  const seen = new Map<string, number>();

  for (const block of taskBlocks) {
    // The block must be the first non-blank thing after a heading.
    let j = block.open - 1;
    while (j >= 0 && lines[j]!.trim() === "") j--;
    const hIdx = headings.findIndex((h) => h.line === j);
    if (hIdx < 0) {
      err(lineNo(block.open), "```task block must directly follow a heading (the heading is the task title)");
      continue;
    }
    const heading = headings[hIdx]!;
    const at = lineNo(block.open);
    const blockLines = lines.slice(block.open + 1, block.close);
    // File line of a key inside this block; the fence line when the key is absent.
    const keyAt = (key: string) => {
      const i = blockLines.findIndex((l) => l.startsWith(`${key}:`));
      return i < 0 ? at : lineNo(block.open + 1 + i);
    };

    let raw: Record<string, unknown>;
    try {
      raw = (parseYaml(blockLines.join("\n")) ?? {}) as Record<string, unknown>;
    } catch (e) {
      const bad = blockLines.findIndex((l) => /^\w+:\s*\[/.test(l) && /\]\(/.test(l));
      if (bad >= 0) err(lineNo(block.open + 1 + bad), 'quote markdown links in YAML: link: "[label](https://…)"');
      else {
        const pos = (e as { linePos?: { line: number }[] }).linePos?.[0]?.line;
        err(pos ? lineNo(block.open + pos) : at, `task block is not valid YAML: ${firstLine(e).replace(/ at line \d+, column \d+:?$/, "")}`);
      }
      continue;
    }
    const before = errors.length;
    for (const k of Object.keys(raw)) if (!TASK_KEYS.has(k)) err(keyAt(k), `unknown task key "${k}"`);

    const id = raw.id === undefined ? "" : String(raw.id);
    if (!ID_RE.test(id)) err(keyAt("id"), `task id "${id}" must match ${ID_RE}`);
    else if (seen.has(id)) err(keyAt("id"), `duplicate task id "${id}" (first at line ${seen.get(id)})`);
    else seen.set(id, keyAt("id"));

    const durationMin = raw.duration === undefined ? meta.defaultDurationMin : parseDuration(raw.duration);
    if (raw.duration === undefined && !durationMin)
      err(at, "duration missing; add e.g. duration: 40m (or set default_duration)");
    else if (!durationMin) err(keyAt("duration"), `invalid duration "${String(raw.duration)}"; use 40m, 2h or 2h30m`);

    if (!TASK_TYPES.includes(raw.type as TaskType))
      err(keyAt("type"), `type must be one of ${TASK_TYPES.join(", ")}`);

    const links: Link[] = [];
    const rawLinks = raw.link === undefined ? [] : Array.isArray(raw.link) ? raw.link : [raw.link];
    for (const l of rawLinks) {
      const r = parseLinkValue(l);
      if (typeof r === "string") err(keyAt("link"), r);
      else links.push(r);
    }
    if (raw.repeat !== undefined && raw.repeat !== "daily") err(keyAt("repeat"), 'repeat must be "daily"');
    if (raw.occurrences !== undefined) {
      if (raw.repeat === undefined) err(keyAt("occurrences"), "occurrences needs repeat: daily");
      else if (!Number.isInteger(raw.occurrences) || (raw.occurrences as number) < 1)
        err(keyAt("occurrences"), "occurrences must be a positive integer");
    }
    if (errors.length > before) continue;

    // Body: until the next heading at the same or a higher level.
    const next = headings.slice(hIdx + 1).find((h) => h.level <= heading.level);
    const end = next ? next.line : lines.length;
    for (let k = heading.line; k < end; k++) ownedByTask.add(k);
    const body = lines.slice(block.close + 1, end).join("\n").trim();
    const parent = [...headings.slice(0, hIdx)].reverse().find((h) => h.level < heading.level);

    tasks.push({
      uid: `${meta.track}/${id}`,
      track: meta.track,
      id,
      title: heading.text,
      durationMin: durationMin!,
      type: raw.type as TaskType,
      links,
      ...(raw.repeat === "daily" && { repeat: "daily" as const }),
      ...(raw.occurrences !== undefined && { occurrences: raw.occurrences as number }),
      body,
      bodyLinks: extractLinks(body),
      section: parent?.text ?? null,
      order: tasks.length,
      file: path,
      line: lineNo(heading.line),
      span: {
        heading: lineNo(heading.line),
        blockOpen: lineNo(block.open),
        blockClose: lineNo(block.close),
        end: Math.max(lineNo(block.close), lineNo(Math.min(end, bodyLineCount) - 1)),
      },
    });
  }

  const prose = lines.filter((_, i) => !ownedByTask.has(i)).join("\n");
  return { file: { path, meta, tasks, references: extractLinks(prose) }, errors };
}
