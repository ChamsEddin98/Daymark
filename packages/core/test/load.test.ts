import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadTaskFiles } from "../src/index.ts";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const good = "---\nschema: planner/task-file@1\ntrack: ok\ntitle: Ok\nkind: lessons\n---\n\n## A\n\n```task\nid: a\nduration: 1h\ntype: reading\n```\n";

it("skips plain markdown but reports task files with a mistyped schema line", () => {
  dir = mkdtempSync(join(tmpdir(), "tasks-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "README.md"), "# Notes\n");
  writeFileSync(join(dir, "ok.md"), good);
  writeFileSync(join(dir, "sub", "typo.md"), good.replace("schema:", "shema:").replace("track: ok", "track: typo"));
  const r = loadTaskFiles([dir], dir);
  expect(r.skipped).toEqual(["README.md"]);
  expect(r.tasks.map((t) => t.uid)).toEqual(["ok/a"]);
  expect(r.errors).toEqual([{ file: "sub/typo.md", line: 1, message: expect.stringMatching(/no `schema:/) }]);
});

it("reports a missing root instead of throwing", () => {
  dir = mkdtempSync(join(tmpdir(), "tasks-"));
  const r = loadTaskFiles([join(dir, "nope")], dir);
  expect(r.errors[0]).toMatchObject({ file: "nope", line: 0, message: expect.stringMatching(/ENOENT/) });
});
