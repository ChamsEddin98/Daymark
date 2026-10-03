/** Validate task files. Usage: npm run tasks:check [-- <dir> ...]   (default: resources/) */
import { resolve } from "node:path";
import { formatDuration, loadTaskFiles } from "../index.ts";

const repo = resolve(import.meta.dirname, "../../../..");
// npm runs workspace scripts from the package dir; INIT_CWD is where the user typed the command.
const cwd = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2);
const roots = args.length ? args.map((d) => resolve(cwd, d)) : [resolve(repo, "resources")];
const { files, tasks, errors, skipped } = loadTaskFiles(roots, repo);

for (const f of files) {
  const mins = f.tasks.reduce((s, t) => s + t.durationMin, 0);
  const linked = f.tasks.filter((t) => t.links.length).length;
  console.log(`${f.path}  [${f.meta.kind}${f.meta.priority ? ` p${f.meta.priority}` : ""}] ${f.meta.track}: ` +
    `${f.tasks.length} tasks, ${formatDuration(mins)}, ${linked} with platform links`);
}
for (const s of skipped) console.log(`skipped (no schema front matter): ${s}`);
for (const e of errors) console.error(`${e.file}:${e.line}: ${e.message}`);
console.log(`\n${tasks.length} tasks, ${errors.length} error(s)`);
process.exit(errors.length ? 1 : 0);
