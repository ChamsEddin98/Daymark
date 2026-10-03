import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseTaskFile } from "./parse.ts";
import type { ParseIssue, Task, TaskFile } from "./types.ts";

export interface LoadResult {
  files: TaskFile[];
  tasks: Task[];
  errors: ParseIssue[];
  /** .md files without `schema: planner/task-file@1` front matter; ignored on purpose. */
  skipped: string[];
}

function walk(dir: string): string[] {
  if (statSync(dir).isFile()) return dir.toLowerCase().endsWith(".md") ? [dir] : [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name.startsWith(".") || name === "node_modules") return [];
    return statSync(p).isDirectory() ? walk(p) : name.toLowerCase().endsWith(".md") ? [p] : [];
  });
}

/** Load every task file under the given roots. A file opts in by declaring the schema in front matter. */
export function loadTaskFiles(roots: string[], base = process.cwd()): LoadResult {
  const out: LoadResult = { files: [], tasks: [], errors: [], skipped: [] };
  const owner = new Map<string, string>();
  for (const root of roots) {
    let found: string[];
    try {
      found = walk(root).sort();
    } catch (e) {
      out.errors.push({ file: relative(base, root).replaceAll("\\", "/") || root, line: 0,
        message: `cannot read directory (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` });
      continue;
    }
    for (const abs of found) {
      const path = relative(base, abs).replaceAll("\\", "/");
      const text = readFileSync(abs, "utf8");
      if (!/^---\r?\n[\s\S]*?^schema:\s*planner\/task-file@/m.test(text.slice(0, 2000))) {
        // Task blocks without a valid schema line are almost certainly a typo, not a README.
        if (/^```task\s*$/m.test(text))
          out.errors.push({ file: path, line: 1, message: "file has ```task blocks but no `schema: planner/task-file@1` front matter; it was not loaded" });
        else out.skipped.push(path);
        continue;
      }
      const { file, errors } = parseTaskFile(text, path);
      out.errors.push(...errors);
      if (!file) continue;
      out.files.push(file);
      for (const t of file.tasks) {
        const prev = owner.get(t.uid);
        if (prev) {
          out.errors.push({ file: path, line: t.line, message: `task uid ${t.uid} already defined in ${prev}` });
          continue;
        }
        owner.set(t.uid, `${path}:${t.line}`);
        out.tasks.push(t);
      }
    }
  }
  const tracks = new Set(out.files.map((f) => f.meta.track));
  for (const f of out.files)
    if (f.meta.startsAfter && !tracks.has(f.meta.startsAfter))
      out.errors.push({ file: f.path, line: 1, message: `starts_after: no track "${f.meta.startsAfter}" is loaded` });
  return out;
}
