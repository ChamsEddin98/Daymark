import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, "fixtures", "open-store.ts");
const PKG = resolve(HERE, "..");
const ROUNDS = 20;
const PARALLEL = 5;
const dirs: string[] = [];

function openIn(dir: string, startAt: number): Promise<string> {
  return new Promise((res) => {
    const p = spawn(process.execPath, ["--import", "tsx", CHILD, dir, String(startAt)], { cwd: PKG, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => res(code === 0 ? "ok" : out.trim() || `exit ${code}`));
  });
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("opening a brand-new database from several processes at once", () => {
  it(`${PARALLEL} processes x ${ROUNDS} fresh databases all open, switch to WAL and migrate`, async () => {
    const failures: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const dir = mkdtempSync(join(tmpdir(), "planner-open-"));
      dirs.push(dir);
      const startAt = Date.now() + 1500; // after every child has loaded tsx
      const results = await Promise.all(Array.from({ length: PARALLEL }, () => openIn(dir, startAt)));
      results.forEach((r, i) => r !== "ok" && failures.push(`round ${round} child ${i}: ${r}`));
    }
    expect(failures).toEqual([]);
  }, 180_000);
});
