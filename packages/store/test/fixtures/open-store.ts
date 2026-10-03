// Child process for the concurrent-open test: waits for a shared start instant, then opens (and
// migrates) the store in argv[2] as the API and the daemon do when `npm start` launches them together.
import { PlannerStore, SCHEMA_VERSION } from "../../src/index.ts";

const [dir, startAt] = [process.argv[2]!, Number(process.argv[3])];
while (Date.now() < startAt) {
  /* spin to line the children up on the same millisecond */
}
try {
  const store = new PlannerStore({ dir });
  const v = store.schemaVersion;
  const mode = String((store.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode);
  store.close();
  if (v !== SCHEMA_VERSION || mode !== "wal") throw new Error(`schema ${v}, journal ${mode}`);
  process.stdout.write("ok\n");
} catch (e) {
  process.stdout.write(`fail: ${(e as Error).message}\n`);
  process.exit(1);
}
