/**
 * P9 · write-back: the plan and task mutation endpoints (docs/PLAN.md, "P9"). The seven invariants
 * in that section are tests, not prose, and this file is where they live. Every test here works on a
 * *copy* of the fixtures, because these endpoints write to disk.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startFakeGoogle, type FakeGoogle } from "../../../packages/calendar/test/fake-google.ts";
import { fakeClient } from "../../../packages/calendar/test/helpers.ts";
import type { ApiOptions } from "../src/app.ts";
import { TODAY, checkDay, cleanup, enc, expectError, makeApi, tempDir, tempResources, type TestApi } from "./helpers.ts";

let t: TestApi;
let res: string;

afterEach(async () => {
  if (t) {
    await t.close();
    cleanup(t.dir);
  }
  if (res) cleanup(res);
});

async function withFiles(o: Partial<ApiOptions> = {}): Promise<TestApi> {
  res = tempResources();
  t = await makeApi({ resourcesDir: res, ...o });
  return t;
}

const path = (name: string) => join(res, name);
const read = (name = "alpha.md") => readFileSync(path(name), "utf8");
/** Bytes *and* mtime, which is what "untouched" has to mean (invariants 2 and 7). */
const fingerprint = (name = "alpha.md") => {
  const s = statSync(path(name));
  return `${s.size}:${s.mtimeMs}:${readFileSync(path(name)).toString("base64").length}`;
};
const lines = (text: string) => text.split(/\r?\n/);
/** Which line endings a text uses, so a write can be shown not to have changed them. */
const crlfMix = (text: string) => `crlf=${(text.match(/\r\n/g) ?? []).length} lf=${(text.match(/(^|[^\r])\n/g) ?? []).length}`;
const backups = () => {
  const d = join(t.dir, "taskfile-backups");
  return existsSync(d) ? readdirSync(d).sort() : [];
};

/** Lines that differ between two versions of a file, as `<1-based line>:<new text>`. */
function changed(before: string, after: string): string[] {
  const a = lines(before);
  const b = lines(after);
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(`${i + 1}:${b[i] ?? "<gone>"}`);
  return out;
}

// --------------------------------------------------------------- invariant 1

describe("1 · byte fidelity: only the intended span moves", () => {
  it("a duration change rewrites exactly one line and leaves every other byte alone", async () => {
    await withFiles();
    const before = read();
    const r = await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "2h30m" });
    expect(r.status).toBe(200);
    const after = read();
    expect(changed(before, after)).toEqual(["15:duration: 2h30m"]);
    expect(lines(after)).toHaveLength(lines(before).length);
    // The diff says the same thing the file does.
    expect(r.body.diff).toContain("-duration: 50m");
    expect(r.body.diff).toContain("+duration: 2h30m");
    expect(r.body.diff.split("\n").filter((l: string) => /^[-+][^-+]/.test(l))).toHaveLength(2);
  });

  it("a title change rewrites the heading line only, and it is the calendar summary", async () => {
    await withFiles();
    const before = read();
    const r = await t.patch(`/tasks/${enc("alpha/A2")}`, { title: "A2 · Alpha, renamed" });
    expect(r.status).toBe(200);
    expect(changed(before, read())).toEqual(["22:### A2 · Alpha, renamed"]);
    expect(r.body.task.title).toBe("A2 · Alpha, renamed");
    const items = (await t.get("/plan?days=7")).body.days.flatMap((d: any) => d.items);
    expect(items.some((i: any) => i.taskUid === "alpha/A2" && i.title.startsWith("A2 · Alpha, renamed"))).toBe(true);
  });

  it("a delete removes exactly the task's own lines", async () => {
    await withFiles();
    const before = read();
    const span = (await t.get(`/tasks/${enc("alpha/A2")}`)).body.span;
    const r = await t.del(`/tasks/${enc("alpha/A2")}`);
    expect(r.status).toBe(200);
    const after = read();
    // Exactly A2's lines, and not one more: deleting its span from `before` gives `after` byte for
    // byte, bar the single blank line rule 6 leaves between the neighbours.
    const kept = lines(before);
    kept.splice(span.heading - 1, span.end - span.heading + 1);
    expect(lines(after)).toEqual(kept);
    expect(after).not.toContain("id: A2");
    expect(after).not.toContain("Work on alpha 2.");
    expect(after).toContain("Work on alpha 1.");
    expect(after).toContain("Work on alpha 3.");
    // Rule 6: exactly one blank line where the section was, never a growing gap.
    expect(after).not.toMatch(/\n\n\n/);
    expect((await t.get("/plans/alpha")).body.tasks).toHaveLength(11);
  });

  it("the prose and front matter of a file are never re-rendered", async () => {
    await withFiles();
    // A hand-written document: a contents list, a table, a fenced block, a trailing note.
    const extra = [
      "---",
      "schema: planner/task-file@1",
      "track: notes",
      "title: Notes",
      "kind: portfolio",
      "---",
      "",
      "# Notes",
      "",
      "## Contents",
      "",
      "1. [Thing](#thing)",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```python",
      "x = 1  #   deliberate   spacing",
      "```",
      "",
      "### N1 · First note",
      "",
      "```task",
      "id: N1",
      "duration: 40m",
      "type: build",
      "```",
      "",
      "Body of N1.",
      "",
      "## Afterword",
      "",
      "Transfers to: nothing.   ",
      "",
    ].join("\n");
    writeFileSync(path("notes.md"), extra, "utf8");
    expect((await t.post("/reload")).status).toBe(200);
    const before = read("notes.md");
    expect((await t.patch(`/tasks/${enc("notes/N1")}`, { duration: "1h" })).status).toBe(200);
    const after = read("notes.md");
    expect(changed(before, after)).toEqual(["26:duration: 1h"]);
    // Trailing whitespace, the table, the fence and the final newline all survive byte for byte.
    expect(after).toContain("x = 1  #   deliberate   spacing");
    expect(after).toContain("Transfers to: nothing.   ");
    expect(after.endsWith("\n")).toBe(true);
  });
});

describe("1b · line endings and the final newline survive a write", () => {
    for (const [label, convert] of [
      ["CRLF", (x: string) => x.replace(/\r?\n/g, "\r\n")],
      ["CRLF with no final newline", (x: string) => x.replace(/\r?\n/g, "\r\n").replace(/\r\n$/, "")],
      ["LF with no final newline", (x: string) => x.replace(/\n$/, "")],
    ] as [string, (x: string) => string][]) {
      it(`${label}: the whole file keeps its endings`, async () => {
        await withFiles();
        const converted = convert(read());
        writeFileSync(path("alpha.md"), converted, "utf8");
        expect((await t.post("/reload")).status).toBe(200);

        expect((await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "2h30m" })).status).toBe(200);
        const after = read();
        // The one intended change, and nothing else - compared as bytes, not as lines.
        expect(after).toBe(converted.replace("duration: 50m", "duration: 2h30m"));
        const crlf = (x: string) => (x.match(/\r\n/g) ?? []).length;
        expect(crlf(after)).toBe(crlf(converted));
        expect((after.match(/(^|[^\r])\n/g) ?? []).length).toBe((converted.match(/(^|[^\r])\n/g) ?? []).length);
        expect(after.endsWith("\n")).toBe(converted.endsWith("\n"));
      });

      it(`${label}: an insert at the end of the file keeps exactly one blank line (rule 6)`, async () => {
        await withFiles();
        const converted = convert(read("lessons.md"));
        writeFileSync(path("lessons.md"), converted, "utf8");
        expect((await t.post("/reload")).status).toBe(200);

        const r = await t.post("/tasks", { track: "lessons", id: "TAIL", title: "At the very end", duration: "40m", type: "admin" });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        const after = read("lessons.md");
        expect(after).toContain("### At the very end");
        // Exactly one blank line between the previous last line and the new heading, never zero
        // (which a file with no final newline used to produce) and never two.
        const head = after.split(/\r?\n### At the very end/)[0]!;
        expect(/\r?\n$/.test(head), "no blank line before the new heading").toBe(true);
        expect(/\r?\n\r?\n$/.test(head), "more than one blank line before the new heading").toBe(false);
        expect(after).not.toMatch(/(\r?\n){4}/);
        // An insert adds lines, so the counts differ; the *kind* of ending must not. A CRLF file
        // must gain no lone LF, and an LF file no CR.
        if (converted.includes("\r\n")) expect(after.match(/(^|[^\r])\n/g) ?? []).toEqual([]);
        else expect(after).not.toContain("\r");
        // And it round-trips: deleting it again gives back the exact bytes.
        expect((await t.del(`/tasks/${enc("lessons/TAIL")}`)).status).toBe(200);
        expect(read("lessons.md")).toBe(converted);
      });
    }
  });

// --------------------------------------------------------------- invariant 2

describe("2 · rejected means untouched", () => {
  const bad: [string, "PATCH" | "DELETE" | "POST", string, unknown, number, string][] = [
    ["a duration that is not a duration", "PATCH", `/tasks/${enc("alpha/A1")}`, { duration: "40" }, 400, "INVALID_INPUT"],
    ["a duration in hours as a decimal", "PATCH", `/tasks/${enc("alpha/A1")}`, { duration: "0.5h" }, 400, "INVALID_INPUT"],
    ["an unknown type", "PATCH", `/tasks/${enc("alpha/A1")}`, { type: "codingg" }, 400, "INVALID_INPUT"],
    ["a field this editor does not have", "PATCH", `/tasks/${enc("alpha/A1")}`, { durationMin: 150 }, 400, "INVALID_INPUT"],
    ["an empty patch", "PATCH", `/tasks/${enc("alpha/A1")}`, {}, 400, "INVALID_INPUT"],
    ["the immutable id", "PATCH", `/tasks/${enc("alpha/A1")}`, { id: "A99" }, 400, "INVALID_INPUT"],
    ["the immutable track", "PATCH", `/tasks/${enc("alpha/A1")}`, { track: "beta" }, 400, "INVALID_INPUT"],
    ["an unknown uid", "PATCH", `/tasks/${enc("alpha/A99")}`, { duration: "1h" }, 404, "UNKNOWN_TASK"],
    ["an unknown uid, deleted", "DELETE", `/tasks/${enc("alpha/A99")}`, undefined, 404, "UNKNOWN_TASK"],
    ["a duplicate id", "POST", "/tasks", { track: "alpha", id: "A1", title: "X", duration: "40m", type: "coding" }, 409, "CONFLICT"],
    ["an unknown track", "POST", "/tasks", { track: "ghost", title: "X", duration: "40m", type: "coding" }, 404, "UNKNOWN_TASK"],
    ["a track that is a path", "POST", "/tasks", { track: "../../etc", title: "X", duration: "40m", type: "coding" }, 400, "INVALID_INPUT"],
    ["a track that is a path, on a plan", "PATCH", "/plans/..%2F..%2Fetc", { title: "X" }, 400, "INVALID_INPUT"],
    ["a plan that does not exist", "PATCH", "/plans/ghost", { title: "X" }, 404, "UNKNOWN_TASK"],
    ["an unknown front-matter key", "PATCH", "/plans/alpha", { priorty: 2 }, 400, "INVALID_INPUT"],
    ["front matter that is not a scalar", "PATCH", "/plans/alpha", { title: { a: 1 } }, 400, "INVALID_INPUT"],
    ["a plan delete with no confirmation", "DELETE", "/plans/alpha", undefined, 400, "INVALID_INPUT"],
    ["a task body on a delete", "DELETE", `/tasks/${enc("alpha/A1")}`, { duration: "1h" }, 400, "INVALID_INPUT"],
  ];

  for (const [label, method, url, payload, status, code] of bad) {
    it(`${label} -> ${status} ${code}, and the file is byte-identical`, async () => {
      await withFiles();
      const fp = [fingerprint("alpha.md"), fingerprint("beta.md"), fingerprint("lessons.md")];
      const before = read();
      const r = method === "PATCH" ? await t.patch(url, payload) : method === "DELETE" ? await t.del(url, payload) : await t.post(url, payload);
      const e = expectError(r, status, code);
      expect(e.message.length).toBeGreaterThan(0);
      expect(read()).toBe(before);
      expect([fingerprint("alpha.md"), fingerprint("beta.md"), fingerprint("lessons.md")]).toEqual(fp);
      expect(backups()).toEqual([]);
      // A refusal is not a reload: the tasks that were loaded are still loaded.
      expect((await t.get("/health")).body.tasksLoaded).toBe(34);
    });
  }

  it("a file broken under the API answers with the parser's own file:line: message", async () => {
    await withFiles();
    const broken = read().replace("duration: 50m", "duration: 50m\n  bad:\t[unclosed");
    writeFileSync(path("alpha.md"), broken, "utf8");
    // A1 is still loaded from the good parse, but its block on disk no longer parses. That is not
    // "no such task": the answer has to name the line.
    for (const call of [t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "2h" }), t.del(`/tasks/${enc("alpha/A1")}`)]) {
      const e = expectError(await call, 422, "TASK_FILE_ERRORS");
      expect(e.message).toMatch(/alpha\.md:\d+: /);
      expect(e.details[0]).toMatchObject({ file: expect.stringContaining("alpha.md"), line: expect.any(Number) });
      expect(e.hint).toContain("POST /reload");
    }
    expect(read()).toBe(broken);
    // A task that is simply not in a file that parses fine is still a plain 404.
    writeFileSync(path("alpha.md"), read().replace(broken, broken), "utf8");
  });

  it("a file deleted under the API says so instead of answering 500", async () => {
    await withFiles();
    rmSync(path("alpha.md"));
    for (const call of [
      t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "2h" }),
      t.del(`/tasks/${enc("alpha/A2")}`),
      t.del("/plans/alpha?confirm=alpha"),
      t.post("/tasks", { track: "alpha", title: "X", duration: "40m", type: "coding" }),
      t.get("/plans/alpha"),
    ]) {
      const e = expectError(await call, 409, "CONFLICT");
      expect(e.message).toContain("is gone");
      expect(e.hint).toContain("POST /reload");
    }
  });

  it("names the field you probably meant instead of ignoring it", async () => {
    await withFiles();
    const e = expectError(await t.patch(`/tasks/${enc("alpha/A1")}`, { durationMin: 150 }), 400, "INVALID_INPUT");
    expect(e.message).toContain('did you mean "duration"');
  });

  it("a file reached through a symlink out of the task directory is refused (rule 8)", async () => {
    await withFiles();
    // A task file that lives outside resources/ and is only visible through a link inside it. The
    // track name is innocent, so the name check cannot catch this: the resolved path has to.
    const outside = tempDir("planner-outside-");
    try {
      writeFileSync(
        join(outside, "sneaky.md"),
        ["---", "schema: planner/task-file@1", "track: sneaky", "title: Sneaky", "kind: portfolio", "---", "", "# Sneaky", "", "### S1 · Outside", "", "```task", "id: S1", "duration: 40m", "type: build", "```", ""].join("\n"),
        "utf8",
      );
      try {
        symlinkSync(outside, path("linked"), "junction");
      } catch {
        return; // no permission to create a link on this machine: nothing to assert
      }
      expect((await t.post("/reload")).status).toBe(200);
      const loaded = (await t.get(`/tasks/${enc("sneaky/S1")}`)).status === 200;
      if (!loaded) return; // the loader did not follow the link, so there is nothing to refuse
      const before = readFileSync(join(outside, "sneaky.md"), "utf8");
      for (const call of [t.patch(`/tasks/${enc("sneaky/S1")}`, { duration: "1h" }), t.del(`/tasks/${enc("sneaky/S1")}`), t.patch("/plans/sneaky", { title: "X" })]) {
        const e = expectError(await call, 400, "INVALID_INPUT");
        expect(e.message).toContain("outside the task directory");
      }
      expect(readFileSync(join(outside, "sneaky.md"), "utf8")).toBe(before);
    } finally {
      cleanup(outside);
    }
  });

  it("a path-traversal track is refused by name, before any file is opened", async () => {
    await withFiles();
    for (const track of ["../../.env", "a/b", "ALPHA", "alpha.md", "-x", "a_b", "x y"]) {
      const e = expectError(await t.patch(`/plans/${enc(track)}`, { title: "X" }), 400, "INVALID_INPUT");
      expect(e.message).toContain("track must be a slug");
    }
    // A bare `..` never even reaches a handler: the router normalises the path away.
    expectError(await t.patch("/plans/..", { title: "X" }), 404, "NOT_FOUND");
  });
});

// --------------------------------------------------------------- invariant 3

describe("3 · round trip: the answer is what the file now says", () => {
  it("re-parsing the file yields the task the API returned, field for field", async () => {
    await withFiles();
    const patch = {
      title: "A4 · Window functions, deeper",
      duration: "1h20m",
      type: "drill",
      links: ["[Rank Scores](https://example.com/rank)", "https://example.com/bare"],
      body: "Practise RANK, DENSE_RANK and ROW_NUMBER.\n\nThen write the three up.",
      section: "Alpha prep",
    };
    const r = await t.patch(`/tasks/${enc("alpha/A4")}`, patch);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const returned = r.body.task;
    expect(returned).toMatchObject({
      uid: "alpha/A4",
      id: "A4",
      track: "alpha",
      title: patch.title,
      durationMin: 80,
      type: "drill",
      links: [
        { label: "Rank Scores", url: "https://example.com/rank" },
        { label: "https://example.com/bare", url: "https://example.com/bare" },
      ],
    });
    expect(returned.body).toContain("DENSE_RANK");

    // What a fresh parse of the file on disk says, through a reload and the read endpoint.
    expect((await t.post("/reload")).status).toBe(200);
    const live = (await t.get(`/tasks/${enc("alpha/A4")}`)).body;
    for (const k of ["uid", "id", "track", "title", "durationMin", "type", "body", "section", "order"] as const)
      expect(live[k], `field ${k}`).toEqual(returned[k]);
    expect(live.links).toEqual(returned.links);
  });

  it("a created task comes back with the span it was written at", async () => {
    await withFiles();
    const r = await t.post("/tasks", {
      track: "alpha",
      id: "A42",
      title: "A42 · A new technique",
      duration: "40m",
      type: "coding",
      links: ["[Doc](https://example.com/doc)"],
      after: "alpha/A1",
      body: "Try it twice.",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const task = r.body.task;
    expect(task.uid).toBe("alpha/A42");
    const text = read();
    expect(lines(text)[task.span.heading - 1]).toBe("### A42 · A new technique");
    expect(lines(text)[task.span.blockOpen - 1]).toBe("```task");
    // `after` placed it behind A1, so it is scheduled before A2.
    expect(task.order).toBe(1);
    const uids = (await t.get("/tasks?track=alpha")).body.tasks.map((x: any) => x.uid);
    expect(uids.slice(0, 3)).toEqual(["alpha/A1", "alpha/A42", "alpha/A2"]);
  });

  it("an id is chosen when none is given, and it does not collide", async () => {
    await withFiles();
    const r = await t.post("/tasks", { track: "alpha", title: "Z · Auto id", duration: "40m", type: "coding" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.task.id).toBeTruthy();
    expect(r.body.warnings?.join(" ") ?? "").toContain(r.body.task.id);
    const again = await t.post("/tasks", { track: "alpha", title: "Z2 · Auto id", duration: "40m", type: "coding" });
    expect(again.body.task.id).not.toBe(r.body.task.id);
  });
});

// --------------------------------------------------------------- invariant 4

describe("4 · state follows: a delete is a delete everywhere", () => {
  it("leaves no row in any table and no item in the plan", async () => {
    await withFiles();
    // Give the task every kind of state there is: a status, progress, and plan items.
    const key = (await t.get("/today")).body.day.items.find((i: any) => i.taskUid === "alpha/A1")!.key;
    expect((await t.post(`/items/${enc(key)}/status`, { status: "done" })).status).toBe(200);
    const uid = "alpha/A3"; // 10 h: split across days, so it has items on several dates
    expect((await t.get(`/tasks/${enc(uid)}`)).body.items.length).toBeGreaterThan(1);
    const firstPart = (await t.get(`/tasks/${enc(uid)}`)).body.items[0].key;
    expect((await t.post(`/items/${enc(firstPart)}/status`, { status: "done" })).status).toBe(200);
    expect(t.api.store.getTaskProgress(uid).doneMin).toBeGreaterThan(0);

    const r = await t.del(`/tasks/${enc(uid)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.task.uid).toBe(uid);
    expect(r.body.forgot.items).toBeGreaterThan(0);
    expect(r.body.forgot.progress).toBe(1);

    const db = t.api.store.db;
    expect(db.prepare("SELECT count(*) n FROM plan_items WHERE task_uid = ?").get(uid)).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM task_status WHERE key = ? OR key LIKE ?").get(uid, `${uid}@%`)).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM task_progress WHERE uid = ?").get(uid)).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM sessions_held WHERE task_uid = ?").get(uid)).toMatchObject({ n: 0 });
    const items = (await t.get("/plan?days=7")).body.days.flatMap((d: any) => [...d.items, ...d.checked]);
    expect(items.filter((i: any) => i.taskUid === uid)).toEqual([]);
    // The other task's state is untouched.
    expect(t.api.store.getStatus("alpha/A1")?.status).toBe("done");
    // And the hole it left in today is closed, not left gaping.
    expect(r.body.regenerated).toContain(TODAY);
    const today = (await t.get("/today")).body.day;
    expect(today.items.every((i: any) => i.taskUid !== uid)).toBe(true);
  });

  it("takes the notifications of item keys the task no longer has", async () => {
    await withFiles();
    const uid = "alpha/A3"; // 10 h, so it is split into several parts across several days
    const keys = (await t.get(`/tasks/${enc(uid)}`)).body.items.map((i: any) => i.key);
    expect(keys.length).toBeGreaterThan(1);
    for (const key of keys) t.api.store.recordNotification({ at: "2026-09-28T09:00:00+01:00", type: "task_start", itemKey: key, title: "x" });
    const count = () => (t.api.store.db.prepare("SELECT count(*) n FROM notifications WHERE item_key LIKE ?").get(`%|${uid}|%`) as { n: number }).n;
    expect(count()).toBe(keys.length);

    // Re-split it first, so most of those keys no longer exist: a delete that only looked at the
    // rows still in plan_items would leave the rest behind for ever.
    expect((await t.patch(`/tasks/${enc(uid)}`, { duration: "40m" })).status).toBe(200);
    expect((await t.get(`/tasks/${enc(uid)}`)).body.items.length).toBeLessThan(keys.length);
    const r = await t.del(`/tasks/${enc(uid)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(count()).toBe(0);
    expect(r.body.forgot.notifications).toBeGreaterThan(0);
    expect((await t.get("/notifications")).body.filter((n: any) => n.itemKey.includes(uid))).toEqual([]);
  });

  it("a uid that is a prefix of another keeps its notifications and state", async () => {
    await withFiles();
    for (const uid of ["alpha/A1", "alpha/A10", "alpha/A11"])
      t.api.store.recordNotification({ at: "2026-09-28T09:00:00+01:00", type: "task_start", itemKey: `${TODAY}|${uid}|1`, title: uid });
    expect((await t.del(`/tasks/${enc("alpha/A1")}`)).status).toBe(200);
    const left = (t.api.store.db.prepare("SELECT item_key k FROM notifications").all() as { k: string }[]).map((r) => r.k);
    expect(left.sort()).toEqual([`${TODAY}|alpha/A10|1`, `${TODAY}|alpha/A11|1`]);
    expect((await t.get(`/tasks/${enc("alpha/A10")}`)).status).toBe(200);
  });

  it("a daily task's held sessions and per-date statuses go too", async () => {
    await withFiles();
    const uid = "lessons/DAILY";
    expect((await t.post(`/tasks/${enc(uid)}/status`, { status: "done", date: TODAY })).status).toBe(200);
    expect(t.api.store.getStatus(`${uid}@${TODAY}`)?.status).toBe("done");
    const r = await t.del(`/tasks/${enc(uid)}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(t.api.store.getStatus(`${uid}@${TODAY}`)).toBeUndefined();
    expect(t.api.store.heldSessionDates(uid)).toEqual([]);
  });

  it("a deleted task is not resurrected by a later reload", async () => {
    await withFiles();
    expect((await t.del(`/tasks/${enc("alpha/A5")}`)).status).toBe(200);
    expect((await t.post("/reload")).status).toBe(200);
    expectError(await t.get(`/tasks/${enc("alpha/A5")}`), 404, "UNKNOWN_TASK");
    const items = (await t.get("/plan?days=7")).body.days.flatMap((d: any) => d.items);
    expect(items.filter((i: any) => i.taskUid === "alpha/A5")).toEqual([]);
  });

  it("deleting a whole plan takes every task's state with it", async () => {
    await withFiles();
    expect((await t.post(`/tasks/${enc("alpha/A1")}/status`, { status: "done" })).status).toBe(200);
    const r = await t.del("/plans/alpha?confirm=alpha");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.plan).toMatchObject({ track: "alpha", tasks: 12 });
    expect(existsSync(path("alpha.md"))).toBe(false);
    expect(r.body.forgot.statuses).toBeGreaterThan(0);
    const db = t.api.store.db;
    expect(db.prepare("SELECT count(*) n FROM plan_items WHERE task_uid LIKE 'alpha/%'").get()).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM task_status WHERE key LIKE 'alpha/%'").get()).toMatchObject({ n: 0 });
    // Beta, the next prep track, takes over the prep slot.
    expect((await t.get("/plans")).body.plans.map((p: any) => p.track)).toEqual(["beta", "lessons", "portfolio"]);
    expect((await t.get("/today")).body.day.items.some((i: any) => i.track === "beta")).toBe(true);
  });
});

// --------------------------------------------------------------- invariant 7

describe("7 · a dry run writes nothing", () => {
  const cases: [string, "PATCH" | "DELETE" | "POST", string, unknown][] = [
    ["a task patch", "PATCH", `/tasks/${enc("alpha/A1")}`, { duration: "2h" }],
    ["a task delete", "DELETE", `/tasks/${enc("alpha/A1")}`, undefined],
    ["a plan patch", "PATCH", "/plans/alpha", { priority: 5 }],
  ];
  for (const [label, method, url, payload] of cases) {
    it(`${label}: bytes and mtime unchanged, and the diff equals the real call's`, async () => {
      await withFiles();
      const fp = fingerprint();
      const sep = url.includes("?") ? "&" : "?";
      const dry = method === "PATCH" ? await t.patch(`${url}${sep}dryRun=true`, payload) : method === "DELETE" ? await t.del(`${url}${sep}dryRun=true`) : await t.post(`${url}${sep}dryRun=true`, payload);
      expect(dry.status, JSON.stringify(dry.body)).toBe(200);
      expect(dry.body).toMatchObject({ dryRun: true, backup: null, sync: "skipped" });
      expect(dry.body.diff.length).toBeGreaterThan(0);
      expect(dry.body.regenerated.length).toBeGreaterThan(0);
      expect(fingerprint()).toBe(fp);
      expect(backups()).toEqual([]);
      expect(t.api.sync.queued).toBe(false);

      const real = method === "PATCH" ? await t.patch(url, payload) : method === "DELETE" ? await t.del(url) : await t.post(url, payload);
      expect(real.status, JSON.stringify(real.body)).toBe(200);
      expect(real.body.diff).toBe(dry.body.diff);
      // Exactly, not a superset: a real call touching more dates than the preview promised is the
      // direction that misleads.
      expect(real.body.regenerated).toEqual(dry.body.regenerated);
      expect(real.body.sync).toBe("queued");
      expect(fingerprint()).not.toBe(fp);
    });
  }

  it("dryRun in the body works too, and an unparsable preview is refused without writing", async () => {
    await withFiles();
    const fp = fingerprint();
    const r = await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "2h", dryRun: true });
    expect(r.body.dryRun).toBe(true);
    expect(fingerprint()).toBe(fp);
    expectError(await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "nope", dryRun: true }), 400, "INVALID_INPUT");
    expect(fingerprint()).toBe(fp);
  });

  it("a dry run of a plan creation writes no file", async () => {
    await withFiles();
    const r = await t.post("/plans?dryRun=true", { track: "gamma", title: "Gamma prep", kind: "prep", priority: 9 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.diff).toContain("+track: gamma");
    expect(existsSync(path("gamma.md"))).toBe(false);
    expect((await t.get("/plans")).body.plans.map((p: any) => p.track)).not.toContain("gamma");
  });

  it("an unknown query parameter is refused, so a typo cannot turn a preview into a real delete", async () => {
    await withFiles();
    const fp = fingerprint();
    const e = expectError(await t.del(`/tasks/${enc("alpha/A1")}?dryrun=true`), 400, "INVALID_INPUT");
    expect(e.message).toContain("dryrun");
    expect(e.hint).toContain("dryRun");
    expect(fingerprint()).toBe(fp);
    expectError(await t.patch(`/tasks/${enc("alpha/A1")}?preview=1`, { duration: "2h" }), 400, "INVALID_INPUT");
    expectError(await t.del(`/tasks/${enc("alpha/A1")}?dryRun=maybe`), 400, "INVALID_INPUT");
    expect(fingerprint()).toBe(fp);
  });
});

// ------------------------------------------------------- rules 1, 2 and 5

describe("no partial writes, and the rollback that makes it true", () => {
  it("a write whose reload breaks the set is undone, byte for byte", async () => {
    await withFiles();
    const before = read();
    const health = (await t.get("/health")).body;
    // `starts_after` is a valid slug but names no loaded track: the text parses alone and breaks the
    // set, which is only discovered by the reload *after* the rename. That is rule 2's hard case.
    const e = expectError(await t.patch("/plans/alpha", { startsAfter: "ghost" }), 422, "TASK_FILE_ERRORS");
    expect(e.details[0].message).toContain("ghost");
    expect(read()).toBe(before);
    expect((await t.get("/health")).body.tasksLoaded).toBe(health.tasksLoaded);
    expect((await t.get("/plans/alpha")).body.startsAfter).toBe(null);
    // And the API does not go on claiming the files are broken: they are not, any more.
    expect((await t.get("/health")).body.taskFileErrors).toBe(0);
    expect((await t.get("/health")).body.ok).toBe(true);
    // The snapshot taken before the attempt is kept: it is the file as it still is.
    expect(backups().filter((b) => b.startsWith("alpha."))).toHaveLength(1);
    expect(readFileSync(join(t.dir, "taskfile-backups", backups()[0]!), "utf8")).toBe(before);
    // And the plan still works.
    expect((await t.get("/today")).body.day.items.length).toBeGreaterThan(0);
  });

  it("a delete whose reload breaks the set keeps the state it was about to drop", async () => {
    await withFiles();
    // Beta now depends on alpha, so removing alpha breaks the set - and only the reload after the
    // rename can know that. The rows the delete had already removed have to come back with the file.
    expect((await t.patch("/plans/beta", { startsAfter: "alpha" })).status).toBe(200);
    expect((await t.post(`/tasks/${enc("alpha/A1")}/status`, { status: "done" })).status).toBe(200);
    expect(t.api.store.getTaskProgress("alpha/A1").doneMin).toBeGreaterThan(0);
    const before = read();
    const rows = () => t.api.store.db.prepare("SELECT count(*) n FROM task_status WHERE key LIKE 'alpha/%'").get() as { n: number };
    const had = rows().n;
    expect(had).toBeGreaterThan(0);

    const e = expectError(await t.del("/plans/alpha?confirm=alpha"), 422, "TASK_FILE_ERRORS");
    expect(e.details[0].message).toContain("alpha");
    expect(existsSync(path("alpha.md"))).toBe(true);
    expect(read()).toBe(before);
    expect(rows().n).toBe(had);
    expect(t.api.store.getTaskProgress("alpha/A1").doneMin).toBeGreaterThan(0);
    expect((await t.get(`/tasks/${enc("alpha/A1")}`)).body.status).toBe("done");
  });

  it("a successful write leaves no temp file behind", async () => {
    await withFiles();
    expect((await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "1h" })).status).toBe(200);
    expect(readdirSync(res).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(readdirSync(res).sort()).toEqual(["alpha.md", "beta.md", "lessons.md", "portfolio.md"]);
  });

  it("a patch that changes nothing says so instead of snapshotting", async () => {
    await withFiles();
    const fp = fingerprint();
    const r = await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "50m" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ diff: "", backup: null, sync: "skipped", regenerated: [] });
    expect(fingerprint()).toBe(fp);
    expect(backups()).toEqual([]);
  });
});

describe("5 · deletes are confirmed and recoverable", () => {
  it("a plan delete needs the track repeated, and says what would go", async () => {
    await withFiles();
    const e = expectError(await t.del("/plans/alpha"), 400, "INVALID_INPUT");
    expect(e.message).toContain("confirm=alpha");
    expect(e.hint).toContain("12");
    expectError(await t.del("/plans/alpha?confirm=beta"), 400, "INVALID_INPUT");
    expect(existsSync(path("alpha.md"))).toBe(true);
    expect((await t.del("/plans/alpha?confirm=alpha")).status).toBe(200);
  });

  it("every write snapshots first, and GET /backups lists them newest first", async () => {
    await withFiles();
    expect((await t.get("/backups")).body.backups).toEqual([]);
    const r1 = await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "1h" });
    expect(r1.body.backup).toMatch(/taskfile-backups[\\/]alpha\./);
    t.clock.set("2026-09-28T10:20:00+01:00");
    const r2 = await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "2h" });
    const list = (await t.get("/backups")).body.backups;
    expect(list).toHaveLength(2);
    expect(list[0].name > list[1].name).toBe(true);
    expect(list[0]).toMatchObject({ track: "alpha" });
    expect(Date.parse(list[0].at)).toBeGreaterThan(Date.parse(list[1].at));
    expect(list[0].bytes).toBeGreaterThan(0);
    expect(r2.body.backup).toContain(list[0].name);
    // The newest snapshot is the file as it was before the second write: 1 h, not 2 h.
    expect(readFileSync(join(t.dir, "taskfile-backups", list[0].name), "utf8")).toContain("duration: 1h");
    expect((await t.get("/backups?track=beta")).body.backups).toEqual([]);
  });

  it("two writes in the same second do not overwrite each other's snapshot", async () => {
    await withFiles();
    expect((await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "1h" })).status).toBe(200);
    expect((await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "2h" })).status).toBe(200);
    expect((await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "3h" })).status).toBe(200);
    const list = (await t.get("/backups")).body.backups;
    expect(list).toHaveLength(3);
    expect(new Set(list.map((b: any) => b.name)).size).toBe(3);
    expect(list.map((b: any) => readFileSync(join(t.dir, "taskfile-backups", b.name), "utf8")).filter((x: string) => x.includes("duration: 2h"))).toHaveLength(1);
  });

  it("only the newest 20 snapshots per track are kept", async () => {
    await withFiles();
    const written: string[] = [];
    for (let i = 1; i <= 23; i++) {
      const r = await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: `${i * 10 + 5}m` });
      expect(r.status).toBe(200);
      written.push(r.body.backup);
    }
    const list = (await t.get("/backups")).body.backups;
    expect(list).toHaveLength(20);
    expect(backups()).toHaveLength(20);
    // Exactly the three oldest were dropped, and what is left is the newest 20, newest first. The
    // clock is frozen in tests, so this is also what proves a snapshot name is never reused.
    expect(list.map((b: any) => b.name)).toEqual(written.slice(3).map((p) => p.split(/[\\/]/).pop()).reverse());
    for (const dropped of written.slice(0, 3)) expect(existsSync(dropped), dropped).toBe(false);
    for (const kept of written.slice(3)) expect(existsSync(kept), kept).toBe(true);
    // And the newest snapshot is the version just before the last write.
    expect(readFileSync(written.at(-1)!, "utf8")).toContain("duration: 3h45m"); // write 22: 225 min
  });

  it("a restore puts a wrongly deleted plan back, and the schedule follows", async () => {
    await withFiles();
    const before = read();
    const del = await t.del("/plans/alpha?confirm=alpha");
    expect(del.status).toBe(200);
    expect(existsSync(path("alpha.md"))).toBe(false);
    const name = (await t.get("/backups")).body.backups[0].name;
    const r = await t.post(`/backups/${name}/restore`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(read()).toBe(before);
    expect(r.body.plan).toMatchObject({ track: "alpha", tasks: 12 });
    expect((await t.get(`/tasks/${enc("alpha/A1")}`)).status).toBe(200);
    expect((await t.get("/today")).body.day.items.some((i: any) => i.track === "alpha")).toBe(true);
    // Restoring a file that was deleted snapshots nothing - there was nothing there to save.
    expect(r.body.backup).toBe(null);
    // Restoring the same snapshot again changes no byte, and says so rather than piling up snapshots.
    const second = await t.post(`/backups/${name}/restore`);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ diff: "", backup: null, sync: "skipped" });
  });

  it("a restore undoes a wrong edit", async () => {
    await withFiles();
    const before = read();
    expect((await t.patch(`/tasks/${enc("alpha/A1")}`, { title: "A1 · Oops", duration: "8h" })).status).toBe(200);
    expect(read()).not.toBe(before);
    const name = (await t.get("/backups")).body.backups[0].name;
    const r = await t.post(`/backups/${name}/restore`);
    expect(r.status).toBe(200);
    expect(read()).toBe(before);
    expect((await t.get(`/tasks/${enc("alpha/A1")}`)).body.durationMin).toBe(50);
    // The restore snapshotted the wrong version first, so even the undo is undoable.
    expect(r.body.backup).not.toBe(null);
    expect(readFileSync(join(t.dir, "taskfile-backups", r.body.backup.split(/[\/]/).pop()), "utf8")).toContain("A1 · Oops");
  });

  it("a snapshot name is the whole request: no path, no traversal", async () => {
    await withFiles();
    expect((await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "1h" })).status).toBe(200);
    // A name that is not a snapshot name is refused by shape, before anything is opened...
    for (const name of ["alpha.md", "nope", "alpha.2026-10-01T09:14:22Z.md", enc("../../../etc/passwd")])
      expectError(await t.post(`/backups/${name}/restore`), 400, "INVALID_INPUT");
    // ...and a path does not even route, because the name is one path segment.
    expectError(await t.post("/backups/../planner.db/restore"), 404, "NOT_FOUND");
    // A well-formed name that is not there is a 404, not a 500.
    expectError(await t.post("/backups/alpha.2020-01-01T00-00-00Z.md/restore"), 404, "UNKNOWN_TASK");
  });
});

// ---------------------------------------------------------------- plans

describe("plans", () => {
  it("GET /plans and GET /plans/:track describe the files without opening them", async () => {
    await withFiles();
    const plans = (await t.get("/plans")).body.plans;
    expect(plans.map((p: any) => p.track)).toEqual(["alpha", "beta", "lessons", "portfolio"]);
    expect(plans[0]).toMatchObject({ track: "alpha", title: "Alpha prep", kind: "prep", priority: 1, tasks: 12, startsAfter: null });
    const one = (await t.get("/plans/alpha")).body;
    expect(one.markdown).toBe(read());
    expect(one.tasks).toHaveLength(12);
    expect(one.tasks[0]).toMatchObject({ uid: "alpha/A1", span: { heading: expect.any(Number) } });
    expectError(await t.get("/plans/ghost"), 404, "UNKNOWN_TASK");
  });

  it("a track declared by two files is a conflict on the plan, and the task still resolves", async () => {
    await withFiles();
    // Two files may legitimately share a track (FileMeta.track says so), but then `:track` names no
    // single file, so the plan endpoints cannot act. A task still knows which file it came from.
    writeFileSync(
      path("alpha-extra.md"),
      ["---", "schema: planner/task-file@1", "track: alpha", "title: Alpha, continued", "kind: prep", "priority: 1", "---", "", "# Alpha, continued", "", "### X1 · Extra", "", "```task", "id: X1", "duration: 40m", "type: coding", "```", ""].join("\n"),
      "utf8",
    );
    expect((await t.post("/reload")).status).toBe(200);
    for (const call of [t.patch("/plans/alpha", { title: "X" }), t.del("/plans/alpha?confirm=alpha"), t.get("/plans/alpha"), t.post("/tasks", { track: "alpha", title: "Y", duration: "40m", type: "coding" })]) {
      const e = expectError(await call, 409, "CONFLICT");
      expect(e.message).toContain("2 files");
      expect(e.message).toContain("alpha-extra.md");
    }
    // The task endpoints address the file the task is in, so they still work on both.
    expect((await t.patch(`/tasks/${enc("alpha/X1")}`, { duration: "1h" })).status).toBe(200);
    expect(read("alpha-extra.md")).toContain("duration: 1h");
    expect((await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "1h" })).status).toBe(200);
    expect(read("alpha.md")).toContain("duration: 1h");
  });

  it("POST /plans creates a loadable file that POST /tasks can then fill", async () => {
    await withFiles();
    const r = await t.post("/plans", {
      track: "gamma",
      title: "Gamma prep",
      kind: "prep",
      priority: 9,
      defaultDuration: "1h",
      startsAfter: "beta",
      intro: "Notes for gamma.",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.plan).toMatchObject({ track: "gamma", kind: "prep", priority: 9, tasks: 0, startsAfter: "beta", defaultDurationMin: 60 });
    expect(r.body.backup).toBe(null); // nothing existed to snapshot
    const text = read("gamma.md");
    expect(text).toContain("schema: planner/task-file@1");
    expect(text).toContain("Notes for gamma.");
    expect((await t.get("/plans")).body.plans.map((p: any) => p.track)).toContain("gamma");

    const task = await t.post("/tasks", { track: "gamma", id: "G1", title: "G1 · First", duration: "40m", type: "coding" });
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    expect(task.body.task.uid).toBe("gamma/G1");
    expect((await t.get("/plans/gamma")).body.tasks).toHaveLength(1);
  });

  it("a duplicate track is a conflict, and a prep plan needs a priority", async () => {
    await withFiles();
    const e = expectError(await t.post("/plans", { track: "alpha", title: "X", kind: "prep", priority: 1 }), 409, "CONFLICT");
    expect(e.message).toContain("already exists");
    expectError(await t.post("/plans", { track: "gamma", title: "X", kind: "prep" }), 400, "INVALID_INPUT");
    expectError(await t.post("/plans", { track: "gamma", title: "X", kind: "nonsense" }), 400, "INVALID_INPUT");
    expectError(await t.post("/plans", { track: "gamma", title: "X", kind: "portfolio", colour: "red" }), 400, "INVALID_INPUT");
    expect(readdirSync(res).sort()).toEqual(["alpha.md", "beta.md", "lessons.md", "portfolio.md"]);
  });

  it("PATCH /plans/:track rewrites only the keys it was given, and reorders the prep tracks", async () => {
    await withFiles();
    const before = read();
    expect((await t.get("/today")).body.day.items[0].track).toBe("alpha");
    const r = await t.patch("/plans/alpha", { priority: 9, title: "Alpha, deprioritised" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(changed(before, read())).toEqual(["4:title: Alpha, deprioritised", "6:priority: 9"]);
    expect(r.body.plan).toMatchObject({ priority: 9, title: "Alpha, deprioritised" });
    // Beta is now the lowest-priority prep track, so it takes the prep slot - from tomorrow. Today
    // keeps the shape it already had, exactly as a POST /reload leaves it.
    expect(r.body.regenerated).not.toContain(TODAY);
    expect((await t.get("/today")).body.day.items[0].track).toBe("alpha");
    const tomorrow = (await t.get("/plan?days=2")).body.days[1];
    expect(tomorrow.items.find((i: any) => i.kind === "task").track).toBe("beta");
  });

  it("a front-matter key set to null is removed; title and kind cannot be", async () => {
    await withFiles();
    expect((await t.patch("/plans/alpha", { startsAfter: "beta" })).status).toBe(200);
    expect(read()).toContain("starts_after: beta");
    expect((await t.patch("/plans/alpha", { startsAfter: null })).status).toBe(200);
    expect(read()).not.toContain("starts_after");
    expectError(await t.patch("/plans/alpha", { title: null }), 400, "INVALID_INPUT");
    expectError(await t.patch("/plans/alpha", { track: "other" }), 400, "INVALID_INPUT");
  });
});

describe("placing a new task", () => {
  it("`after` puts it directly behind that task; `section` moves it under a heading", async () => {
    await withFiles();
    const r = await t.post("/tasks", { track: "alpha", id: "MID", title: "MID · Between", duration: "40m", type: "coding", after: "alpha/A5" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const uids = (await t.get("/tasks?track=alpha")).body.tasks.map((x: any) => x.uid);
    expect(uids[uids.indexOf("alpha/MID") - 1]).toBe("alpha/A5");
    expect(uids[uids.indexOf("alpha/MID") + 1]).toBe("alpha/A6");

    // A section that does not exist is created, and the API says so rather than inventing silently.
    const made = await t.post("/tasks", { track: "alpha", id: "SEC", title: "SEC · In a new section", duration: "40m", type: "coding", section: "Brand new section" });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect(made.body.warnings?.join(" ")).toContain("Brand new section");
    expect(read()).toContain("Brand new section");
    expect((await t.get(`/tasks/${enc("alpha/SEC")}`)).body.section).toBe("Brand new section");
  });

  it("an `after` or `section` anchor outside the file is refused, not guessed", async () => {
    await withFiles();
    const before = read();
    expectError(await t.post("/tasks", { track: "alpha", title: "X", duration: "40m", type: "coding", after: "beta/B1" }), 404, "UNKNOWN_TASK");
    expect(read()).toBe(before);
  });

  it("repeat and occurrences can be added and taken away again", async () => {
    await withFiles();
    const r = await t.post("/tasks", { track: "lessons", id: "EXTRA", title: "Extra lesson", duration: "30m", type: "reading", repeat: "daily", occurrences: 2 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.task).toMatchObject({ repeat: "daily", occurrences: 2 });
    const days = (await t.get("/plan?days=7")).body.days;
    expect(days.filter((d: any) => d.items.some((i: any) => i.taskUid === "lessons/EXTRA"))).toHaveLength(2);

    // A contradiction - stop repeating, but five occurrences - is refused rather than half-applied.
    const e = expectError(await t.patch(`/tasks/${enc("lessons/EXTRA")}`, { occurrences: 5, repeat: null }), 400, "INVALID_INPUT");
    expect(e.message).toContain("occurrences");
    const off = await t.patch(`/tasks/${enc("lessons/EXTRA")}`, { repeat: null });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    // Both lines go, and only from EXTRA's block: the fixture's own DAILY keeps its occurrences.
    expect(off.body.diff).toContain("-repeat: daily");
    expect(off.body.diff).toContain("-occurrences: 2");
    expect(off.body.task.repeat).toBeUndefined();
    expect(off.body.task.occurrences).toBeUndefined();
    expect((await t.get(`/tasks/${enc("lessons/DAILY")}`)).body.occurrences).toBe(3);
    const after = (await t.get("/plan?days=7")).body.days;
    expect(after.filter((d: any) => d.items.some((i: any) => i.taskUid === "lessons/EXTRA"))).toHaveLength(1);
  });
});

// -------------------------------------------------------- the schedule follows

describe("the schedule follows the file, in the same call", () => {
  it("a duration change re-splits the task and moves the days after today", async () => {
    await withFiles();
    const before = (await t.get("/plan?days=7")).body.days;
    const r = await t.patch(`/tasks/${enc("alpha/A4")}`, { duration: "5h" });
    expect(r.status).toBe(200);
    expect(r.body.regenerated.length).toBeGreaterThan(0);
    expect(r.body.regenerated).not.toContain(TODAY); // today keeps its shape, as a reload does
    const after = (await t.get("/plan?days=7")).body.days;
    const mins = (days: any[]) =>
      days.flatMap((d: any) => d.items).filter((i: any) => i.taskUid === "alpha/A4").reduce((n: number, i: any) => n + (Date.parse(i.end) - Date.parse(i.start)) / 60000, 0);
    expect(mins(before)).toBe(50);
    expect(mins(after)).toBe(300);
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });

  it("a new daily task appears on every day of the horizon", async () => {
    await withFiles();
    const r = await t.post("/tasks", { track: "lessons", id: "REVIEW", title: "Daily review", duration: "20m", type: "admin", repeat: "daily" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const days = (await t.get("/plan?days=7")).body.days;
    const withIt = days.filter((d: any) => d.items.some((i: any) => i.taskUid === "lessons/REVIEW"));
    expect(withIt.length).toBeGreaterThanOrEqual(6);
  });

  it("a rename refreshes today's placed items in place, and reports them as restyled", async () => {
    await withFiles();
    const day = (await t.get("/today")).body.day;
    const item = day.items.find((i: any) => i.taskUid === "alpha/A1");
    expect(item, "A1 should be on today's timeline").toBeTruthy();
    const { start, end, key, status } = item;

    const r = await t.patch(`/tasks/${enc("alpha/A1")}`, { title: "A1 · Renamed today", type: "drill", links: ["https://example.com/new"] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.restyled).toEqual([TODAY]);
    expect(r.body.regenerated).not.toContain(TODAY);

    const now = (await t.get("/today")).body.day.items.find((i: any) => i.key === key);
    // What it shows changed; when it runs, and its identity, did not.
    expect(now.title).toBe("A1 · Renamed today");
    expect(now.type).toBe("drill");
    expect(now.links).toEqual([{ label: "https://example.com/new", url: "https://example.com/new" }]);
    expect({ start: now.start, end: now.end, key: now.key, status: now.status }).toEqual({ start, end, key, status });
  });

  it("a re-timing change leaves today alone; only a regenerate from today reaches it", async () => {
    await withFiles();
    const before = (await t.get("/today")).body.day;
    // A task still ahead of `now`, so a rebuild of today could move it (a past item never moves).
    const ahead = before.items.filter((i: any) => i.kind === "task" && Date.parse(i.start) > Date.parse(before.items[0].start)).at(-1);
    const uid = ahead.taskUid as string;
    const mins = (day: any, u: string) => day.items.filter((i: any) => i.taskUid === u).reduce((n: number, i: any) => n + (Date.parse(i.end) - Date.parse(i.start)) / 60000, 0);

    const r = await t.patch(`/tasks/${enc(uid)}`, { duration: "20m" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // `duration` is when, not what it shows, so nothing was restyled and today kept its shape.
    expect(r.body.restyled).toBeUndefined();
    expect(r.body.regenerated).not.toContain(TODAY);
    const untouched = (await t.get("/today")).body.day;
    expect(mins(untouched, uid)).toBe(mins(before, uid));

    // The explicit rebuild is what pulls it into today.
    expect((await t.post("/plan/regenerate", { from: TODAY })).status).toBe(200);
    expect(mins((await t.get("/today")).body.day, uid)).toBe(20);
  });

  it("a split task keeps its part labels when it is renamed", async () => {
    await withFiles();
    const parts = (await t.get(`/tasks/${enc("alpha/A3")}`)).body.items.filter((i: any) => i.date === TODAY);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts[0].title).toMatch(/\(part \d+\/\d+\)$/);
    const r = await t.patch(`/tasks/${enc("alpha/A3")}`, { title: "A3 · Renamed and split" });
    expect(r.status).toBe(200);
    const after = (await t.get(`/tasks/${enc("alpha/A3")}`)).body.items.find((i: any) => i.key === parts[0].key);
    expect(after.title).toBe(`A3 · Renamed and split (part ${parts[0].part.index}/${parts[0].part.total})`);
  });

  it("every write queues one calendar sync and publishes one plan event", async () => {
    await withFiles();
    const seen: string[] = [];
    const off = t.api.bus.on((e) => seen.push(e.event));
    expect((await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "1h" })).status).toBe(200);
    off();
    expect(seen.filter((s) => s === "plan")).toHaveLength(1);
    expect(t.api.sync.queued).toBe(true);
  });

  it("a successful write needs no POST /reload afterwards", async () => {
    await withFiles();
    expect((await t.patch(`/tasks/${enc("alpha/A1")}`, { title: "A1 · Already live" })).status).toBe(200);
    // Visible straight away, with no reload in between.
    expect((await t.get(`/tasks/${enc("alpha/A1")}`)).body.title).toBe("A1 · Already live");
    const r = await t.post("/reload");
    expect(r.status).toBe(200);
    expect((await t.get(`/tasks/${enc("alpha/A1")}`)).body.title).toBe("A1 · Already live");
  });
});

// --------------------------------------------------------------- invariant 5

describe("5 · calendar follows", () => {
  let fake: FakeGoogle;
  beforeAll(async () => {
    fake = await startFakeGoogle();
  });
  afterAll(async () => {
    await fake.stop();
  });

  const noRetry = { retry: { maxTries: 2, sleep: async () => {} } };

  it("a title change patches the event, and a second sync is a no-op", async () => {
    const client = fakeClient(fake);
    await withFiles({ calendarClient: () => client, calendarOptions: noRetry });
    await t.api.sync.run();
    const calendarId = t.api.store.getCalendarId()!;
    const before = fake.liveEvents(calendarId).length;
    expect(before).toBeGreaterThan(0);

    expect((await t.patch(`/tasks/${enc("alpha/A1")}`, { title: "A1 · Renamed for Google" })).status).toBe(200);
    await t.api.sync.flush();
    const live = fake.liveEvents(calendarId);
    expect(live.some((e) => String(e.summary ?? "").startsWith("A1 · Renamed for Google"))).toBe(true);

    // Invariant 5: syncing again changes nothing at all.
    const again = await t.api.sync.run();
    expect({ inserted: again.inserted, patched: again.patched, deleted: again.deleted }).toEqual({ inserted: 0, patched: 0, deleted: 0 });
  });

  it("a deleted task's events are deleted, and the sync settles", async () => {
    const client = fakeClient(fake);
    await withFiles({ calendarClient: () => client, calendarOptions: noRetry });
    await t.api.sync.run();
    const calendarId = t.api.store.getCalendarId()!;
    // `alpha/A1` is a prefix of alpha/A10..A12, so the uid is matched between the key's separators.
    const isA1 = (e: { extendedProperties?: any }) => String(e.extendedProperties?.private?.plannerKey ?? "").includes("|alpha/A1|");
    expect(fake.liveEvents(calendarId).filter(isA1).length).toBeGreaterThan(0);

    expect((await t.del(`/tasks/${enc("alpha/A1")}`)).status).toBe(200);
    await t.api.sync.flush();
    expect(fake.liveEvents(calendarId).filter(isA1)).toEqual([]);
    const again = await t.api.sync.run();
    expect({ inserted: again.inserted, patched: again.patched, deleted: again.deleted }).toEqual({ inserted: 0, patched: 0, deleted: 0 });
  });

  it("a write still succeeds when Google is not authorized; the answer says the sync is queued", async () => {
    await withFiles(); // the default client throws NotAuthorizedError
    const r = await t.patch(`/tasks/${enc("alpha/A1")}`, { duration: "1h" });
    expect(r.status).toBe(200);
    expect(r.body.sync).toBe("queued");
    expect(read()).toContain("duration: 1h");
    await t.api.sync.flush();
    expect((await t.get("/sync/status")).body.lastError.code).toBe("CALENDAR_NOT_AUTHORIZED");
  });
});

// --------------------------------------------------------------- invariant 6

describe("6 · drift: the store never disagrees with the files", () => {
  /** Every task in the files is scheduled or closed, and nothing scheduled is missing from them. */
  async function expectNoDrift() {
    const plans = (await t.get("/plans")).body.plans;
    const inFiles = new Set<string>();
    for (const p of plans) for (const task of (await t.get(`/plans/${p.track}`)).body.tasks) inFiles.add(task.uid);
    const loaded = new Set((await t.get("/tasks")).body.tasks.map((x: any) => x.uid as string));
    expect([...loaded].sort()).toEqual([...inFiles].sort());
    const scheduled = new Set(
      (await t.get("/plan?days=7")).body.days.flatMap((d: any) => [...d.items, ...d.checked]).filter((i: any) => i.kind === "task").map((i: any) => i.taskUid as string),
    );
    for (const uid of scheduled) expect(inFiles, `${uid} is scheduled but not in any file`).toContain(uid);
    const rows = t.api.store.db.prepare("SELECT DISTINCT task_uid u FROM plan_items WHERE task_uid IS NOT NULL").all() as { u: string }[];
    for (const { u } of rows) expect(inFiles, `${u} has stored items but is not in any file`).toContain(u);
  }

  /** xorshift32: a named seed, so a failure is reproducible by re-running the same test. */
  function rng(seed: number) {
    let x = seed || 1;
    return () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return ((x >>> 0) % 1_000_000) / 1_000_000;
    };
  }

  it("200 random mutations interleaved with shifts and status changes leave no drift", async () => {
    await withFiles();
    const rand = rng(0x9e3779b9);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const live = new Set<string>(); // the uids this test created and has not deleted
    let n = 0;
    const counts: Record<string, number> = {};
    const did = (what: string) => (counts[what] = (counts[what] ?? 0) + 1);

    for (let op = 0; op < 200; op++) {
      const track = pick(["alpha", "beta", "lessons"]);
      switch (pick(["create", "create", "update", "update", "delete", "status", "shift", "regenerate", "reload"])) {
        case "create": {
          const id = `N${++n}`;
          const body: Record<string, unknown> = { track, id, title: `${id} · Generated`, duration: pick(["30m", "40m", "1h", "2h30m"]), type: pick(["coding", "concept", "drill", "admin"]) };
          if (rand() < 0.3) body.after = pick([...live, `${track}/A1`]);
          if (rand() < 0.2) body.repeat = "daily";
          if (rand() < 0.3) body.body = `Generated by op ${op}.`;
          const r = await t.post("/tasks", body);
          // An `after` naming a task in another file is a legitimate 404, not a drift bug.
          if (r.status === 200) {
            live.add(r.body.task.uid);
            did("create");
          } else expect(r.body.error.code, JSON.stringify(r.body)).toBe("UNKNOWN_TASK");
          break;
        }
        case "update": {
          const all: string[] = (await t.get("/tasks")).body.tasks.map((x: any) => x.uid as string);
          const uid: string = live.size && rand() < 0.7 ? pick([...live]) : pick(all);
          const patch = pick([{ duration: pick(["20m", "1h", "3h"]) }, { title: `Renamed at op ${op}` }, { type: pick(["reading", "build", "mock"]) }, { links: [`https://example.com/${op}`] }, { body: `Rewritten at op ${op}.` }]);
          const r = await t.patch(`/tasks/${enc(uid)}`, patch);
          expect(r.status, `update ${uid} ${JSON.stringify(patch)} -> ${JSON.stringify(r.body)}`).toBe(200);
          did("update");
          break;
        }
        case "delete": {
          if (!live.size) break;
          const uid = pick([...live]);
          const r = await t.del(`/tasks/${enc(uid)}`);
          expect(r.status, JSON.stringify(r.body)).toBe(200);
          live.delete(uid);
          did("delete");
          break;
        }
        case "status": {
          const items: { key: string }[] = (await t.get("/today")).body.day.items.filter((i: any) => i.kind === "task");
          if (!items.length) break;
          const r = await t.post(`/items/${enc(pick(items).key)}/status`, { status: pick(["done", "skipped", "pending"]) });
          expect([200, 409]).toContain(r.status);
          did("status");
          break;
        }
        case "shift": {
          const r = await t.post("/plan/shift", { amount: pick([10, 30]), unit: pick(["minutes", "hours"]) });
          expect([200, 400, 409]).toContain(r.status);
          did("shift");
          break;
        }
        case "regenerate": {
          const r = await t.post("/plan/regenerate", {});
          expect(r.status).toBe(200);
          did("regenerate");
          break;
        }
        case "reload": {
          expect((await t.post("/reload")).status).toBe(200);
          did("reload");
          break;
        }
      }
      // Every tenth operation, and always at the end: the files and the store must still agree.
      if (op % 10 === 9) await expectNoDrift();
    }

    // The mix actually exercised every kind of mutation, so a zero in any of these would mean the
    // test proved less than it claims.
    for (const what of ["create", "update", "delete", "status", "shift", "regenerate", "reload"]) expect(counts[what], what).toBeGreaterThan(0);

    await expectNoDrift();
    // And a reload changes nothing: that is what "the store is what the files describe" means.
    const before = (await t.get("/plan?days=7")).body;
    expect((await t.post("/reload")).status).toBe(200);
    await expectNoDrift();
    expect(JSON.stringify((await t.get("/plan?days=7")).body)).toBe(JSON.stringify(before));
    expect((await t.get("/tasks")).body.tasks).toHaveLength(34 + live.size);
    // Every day the plan still holds is still a legal day.
    for (const day of (await t.get("/plan?days=7")).body.days) checkDay(day);
  }, 180_000);
});
