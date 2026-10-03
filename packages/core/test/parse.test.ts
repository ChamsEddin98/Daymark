import { describe, expect, it } from "vitest";
import { parseDuration, parseTaskFile } from "../src/index.ts";

const FM = `---
schema: planner/task-file@1
track: demo
title: Demo
kind: lessons
---
`;

const file = (body: string, fm = FM) => parseTaskFile(fm + body, "demo.md");

describe("parseDuration", () => {
  it.each([["40m", 40], ["2h", 120], ["2h30m", 150], ["1h 5m", 65], [90, 90]])("%s -> %d", (raw, min) =>
    expect(parseDuration(raw)).toBe(min));
  it.each(["", "0m", "1.5h", "forty", "30", -5, 0])("rejects %s", (raw) => expect(parseDuration(raw)).toBeNull());
});

describe("parseTaskFile", () => {
  it("reads a task: heading is the title, block is metadata, prose until the next heading is the body", () => {
    const { file: f, errors } = file(`
# Lessons

## Week 1

### Read: attention is all you need

\`\`\`task
id: L1
duration: 1h
type: reading
link: "[Paper](https://arxiv.org/abs/1706.03762)"
\`\`\`

Focus on section 3. See [the annotated version](https://nlp.seas.harvard.edu/annotated-transformer/).

#### Notes

Sub-headings stay inside the body.

### Build: tokenizer

\`\`\`task
id: L2
duration: 2h30m
type: build
\`\`\`

Write a BPE tokenizer.

## Sources

[Karpathy](https://karpathy.ai)
`);
    expect(errors).toEqual([]);
    const [a, b] = f!.tasks;
    expect(a).toMatchObject({
      uid: "demo/L1", title: "Read: attention is all you need", durationMin: 60, type: "reading",
      links: [{ label: "Paper", url: "https://arxiv.org/abs/1706.03762" }], section: "Week 1", order: 0,
    });
    expect(a!.body).toContain("#### Notes");
    expect(a!.body).not.toContain("tokenizer");
    expect(a!.bodyLinks.map((l) => l.url)).toEqual(["https://nlp.seas.harvard.edu/annotated-transformer/"]);
    expect(b).toMatchObject({ uid: "demo/L2", durationMin: 150, links: [], order: 1 });
    expect(b!.body).toBe("Write a BPE tokenizer.");
    expect(f!.references.map((l) => l.url)).toEqual(["https://karpathy.ai"]);
  });

  it("accepts a list of links and a bare URL; the first is primary", () => {
    const { file: f, errors } = file(`## T\n\n\`\`\`task\nid: x\nduration: 10m\ntype: coding\nlink:\n  - https://a.dev/1\n  - "[B](https://b.dev/2)"\n\`\`\`\n`);
    expect(errors).toEqual([]);
    expect(f!.tasks[0]!.links).toEqual([{ label: "https://a.dev/1", url: "https://a.dev/1" }, { label: "B", url: "https://b.dev/2" }]);
  });

  it("falls back to default_duration", () => {
    const fm = FM.replace("kind: lessons", "kind: lessons\ndefault_duration: 45m");
    const { file: f } = file(`## T\n\n\`\`\`task\nid: x\ntype: reading\n\`\`\`\n`, fm);
    expect(f!.tasks[0]!.durationMin).toBe(45);
  });

  it("ignores ```task inside another fence", () => {
    const { file: f, errors } = file("## Example\n\n````markdown\n```task\nid: nope\n```\n````\n");
    expect(errors).toEqual([]);
    expect(f!.tasks).toEqual([]);
  });

  // The fence is file line 10, so block keys start at line 11. Missing keys point at the fence.
  it.each([
    ["unknown key", "id: x\nduration: 1h\ntype: coding\nestimate: 1h", 14, /unknown task key "estimate"/],
    ["bad duration", "id: x\nduration: 1.5h\ntype: coding", 12, /invalid duration "1.5h"/],
    ["missing duration", "id: x\ntype: coding", 10, /duration missing/],
    ["bad type", "id: x\nduration: 1h\ntype: video", 13, /type must be one of/],
    ["bad id", "id: has space\nduration: 1h\ntype: coding", 11, /task id/],
    ["bad link", "id: x\nduration: 1h\ntype: coding\nlink: leetcode two sum", 14, /link must be/],
    ["unquoted md link", "id: x\nduration: 1h\ntype: coding\nlink: [A](https://a.dev)", 14, /quote markdown links/],
  ])("reports %s on the offending line", (_n, yaml, line, msg) => {
    const { errors } = file(`\n## T\n\n\`\`\`task\n${yaml}\n\`\`\`\n`);
    expect(errors[0]).toMatchObject({ file: "demo.md", line, message: expect.stringMatching(msg) });
  });

  it("keeps a trailing # that is part of the title, strips closing hashes", () => {
    const { file: f } = file("## Read: intro to C#\n\n```task\nid: a\nduration: 1h\ntype: reading\n```\n\n## Build: x ##\n\n```task\nid: b\nduration: 1h\ntype: build\n```\n");
    expect(f!.tasks.map((t) => t.title)).toEqual(["Read: intro to C#", "Build: x"]);
  });

  it("says when the front matter is opened but never closed", () => {
    expect(parseTaskFile("---\nschema: planner/task-file@1\n# body", "x.md").errors[0]!.message).toMatch(/not closed/);
  });

  it("rejects duplicate ids and orphan task blocks", () => {
    const { errors } = file("## A\n\n```task\nid: x\nduration: 1h\ntype: coding\n```\n\nprose\n\n```task\nid: y\nduration: 1h\ntype: coding\n```\n\n## B\n\n```task\nid: x\nduration: 1h\ntype: coding\n```\n");
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/must directly follow a heading/),
      expect.stringMatching(/duplicate task id "x"/),
    ]);
  });

  it("validates front matter", () => {
    expect(parseTaskFile("# no front matter", "x.md").errors[0]!.message).toMatch(/missing YAML front matter/);
    const bad = parseTaskFile("---\nschema: planner/task-file@1\ntrack: Bad Track\ntitle: t\nkind: prep\n---\n", "x.md");
    expect(bad.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/track must be a slug/),
      expect.stringMatching(/prep files need a priority/),
    ]);
  });

  it("reads repeat/occurrences and starts_after", () => {
    const fm = FM.replace("kind: lessons", "kind: recurring\nstarts_after: bcg");
    const { file: f, errors } = file("## Daily\n\n```task\nid: d\nduration: 2h\ntype: reading\nrepeat: daily\noccurrences: 28\n```\n", fm);
    expect(errors).toEqual([]);
    expect(f!.meta.startsAfter).toBe("bcg");
    expect(f!.tasks[0]).toMatchObject({ repeat: "daily", occurrences: 28 });
  });

  it.each([
    ["repeat: weekly", /repeat must be "daily"/],
    ["occurrences: 3", /occurrences needs repeat/],
    ["repeat: daily\noccurrences: 0", /positive integer/],
  ])("rejects %s", (extra, msg) => {
    const { errors } = file("## T\n\n```task\nid: x\nduration: 1h\ntype: coding\n" + extra + "\n```\n");
    expect(errors[0]!.message).toMatch(msg);
  });

  it("collects bare URLs in prose, trimming trailing punctuation", () => {
    const { file: f } = file("Docs at https://pandas.pydata.org/docs/. Also `https://in.code/x`.\n");
    expect(f!.references.map((l) => l.url)).toEqual(["https://pandas.pydata.org/docs/"]);
  });

  it("points front-matter errors at the offending key's line, one line per message", () => {
    const { errors } = parseTaskFile("---\nschema: planner/task-file@1\ntrack: t\ntitle: T\nkind: lessons\npriorty: 2\n---\n", "x.md");
    expect(errors).toEqual([{ file: "x.md", line: 6, message: 'unknown front-matter key "priorty"' }]);
    const yaml = parseTaskFile("---\nschema: [unclosed\n---\n", "y.md").errors[0]!;
    expect(yaml.message).not.toContain("\n");
  });

  it("handles CRLF files", () => {
    const { file: f, errors } = parseTaskFile((FM + "## T\n\n```task\nid: x\nduration: 5m\ntype: admin\n```\n").replace(/\n/g, "\r\n"), "w.md");
    expect(errors).toEqual([]);
    expect(f!.tasks).toHaveLength(1);
  });
});
