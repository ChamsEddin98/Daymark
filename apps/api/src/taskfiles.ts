/**
 * P9 write-back (docs/PLAN.md, "P9 · Write-back"): the engine behind the plan and task mutation
 * endpoints. Claude Code and the web UI create, update and delete tasks and plans here, and every
 * such change is written into the `resources/*.md` file that produced the schedule, so the file never
 * falls behind.
 *
 * The dividing line, which this module is one half of:
 *
 * > If a change would survive `POST /reload`, it belongs in the Markdown. If `POST /reload` would
 * > wipe it, it belongs in SQLite.
 *
 * Title, duration, type, links, repeat, order and front matter are Markdown and come through here.
 * Done, skipped, progress, days off and the pause are SQLite and never touch a file. Nothing is
 * written to both.
 *
 * Every mutation runs the same pipeline (rule 1), and `write()` is the only place that implements it:
 *
 *   validate -> build the new text in memory -> re-parse it -> snapshot the old file ->
 *   write atomically -> reload -> regenerate -> queue the calendar sync
 *
 * The editing itself is `packages/core/src/taskfile/edit.ts`: surgical, never a re-render. This
 * module adds the things that need the filesystem and the store - paths, atomicity, snapshots,
 * rollback and the stored state a delete has to take with it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  deleteTask as cutTask,
  diff,
  insertTask,
  parseTaskFile,
  renderPlanFile,
  updateMeta,
  updateTask,
  type EditErrorCode,
  type EditOk,
  type EditResult,
  type InsertSpec,
  type MetaPatch,
  type ParseIssue,
  type Task,
  type TaskFile,
  type TaskPatch,
} from "@planner/core";
import { PlannerError, REPO_ROOT, loadResources, type ForgetCounts, type LoadedTasks, type PlanService, type PlannerStore } from "@planner/store";

/** A plan's `track`, which is also its file name. Rule 8: nothing else may name a file. */
export const TRACK_RE = /^[a-z0-9][a-z0-9-]*$/;
/**
 * `<track>.<timestamp>Z.md`, the timestamp being an ISO instant with `:` and `.` replaced by `-`,
 * because a colon is not a legal character in a Windows file name. The millisecond field is always
 * written, so that the names of one track sort lexicographically in exactly time order - which is
 * what both the listing and the pruning rely on. Older names without it are still accepted.
 */
const BACKUP_RE = /^([a-z0-9][a-z0-9-]*)\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?)Z\.md$/;
const BACKUPS_DIR = "taskfile-backups";
/** Rule 5: newest 20 snapshots per track are kept. */
export const BACKUPS_PER_TRACK = 20;

const rel = (abs: string) => (abs.startsWith(REPO_ROOT) ? abs.slice(REPO_ROOT.length + 1) : abs).replaceAll("\\", "/");

const invalid = (message: string, hint: string) => new PlannerError("INVALID_INPUT", message, hint);

/**
 * How an editor refusal reaches HTTP. `immutable` and `unknown_field` are plain bad requests; a
 * `duplicate` id is a conflict with what is already in the file; text that will not parse is the same
 * 422 `POST /reload` answers, because it is the same failure for the same reason.
 */
const CODE_FOR: Record<EditErrorCode, "INVALID_INPUT" | "UNKNOWN_TASK" | "CONFLICT" | "TASK_FILE_ERRORS"> = {
  invalid: "INVALID_INPUT",
  immutable: "INVALID_INPUT",
  unknown_field: "INVALID_INPUT",
  not_found: "UNKNOWN_TASK",
  duplicate: "CONFLICT",
  unparsable: "TASK_FILE_ERRORS",
  broken_result: "TASK_FILE_ERRORS",
};

const HINT_FOR: Record<EditErrorCode, string> = {
  invalid: "Fix the named field and send the request again; the file was not touched.",
  immutable: "Delete the task and create a new one with the id you want (DELETE /tasks/:uid, then POST /tasks). The title changes freely.",
  unknown_field: "The message lists the fields this endpoint has. The file was not touched.",
  not_found: "GET /tasks lists the task uids and GET /plans the tracks.",
  duplicate: "Choose another id, or omit `id` and let the API pick the next free one.",
  unparsable: "The file on disk is not a valid task file; fix it by hand and POST /reload. `npm run tasks:check` shows the same list.",
  broken_result: "This is a bug in the editor: the edit produced text that does not parse back into the task asked for. Nothing was written.",
};

/** One plan file, as `GET /plans` lists it. */
export interface PlanSummary {
  track: string;
  path: string;
  title: string;
  kind: string;
  priority: number | null;
  tasks: number;
  startsAfter: string | null;
  defaultDurationMin: number | null;
}

const planSummary = (f: TaskFile): PlanSummary => ({
  track: f.meta.track,
  path: f.path,
  title: f.meta.title,
  kind: f.meta.kind,
  priority: f.meta.priority ?? null,
  tasks: f.tasks.length,
  startsAfter: f.meta.startsAfter ?? null,
  defaultDurationMin: f.meta.defaultDurationMin ?? null,
});

/** The envelope every mutating write-back call answers with (docs/PLAN.md, P9 "Endpoints"). */
export interface WriteBack {
  /** A unified diff against the file as it was. Returned on real calls too, not just dry runs. */
  diff: string;
  /** The repo-relative path written. */
  file: string;
  /** The dates the plan was rebuilt for - or, on a dry run, the dates a real call would rebuild. */
  regenerated: string[];
  /** The snapshot taken before the write, repo-relative; `null` for a dry run or a new file. */
  backup: string | null;
  sync: "queued" | "skipped";
  dryRun?: true;
  warnings?: string[];
  /** Stored rows a delete removed, per table (P9 rule 4). */
  forgot?: ForgetCounts;
  /**
   * Dates whose already-placed items had their title, links or type refreshed in place - not
   * re-timed. In practice today, which a write never rebuilds: it is how a rename reaches today's
   * calendar event without moving a day that is already under way.
   */
  restyled?: string[];
}

/** The task a mutation produced; for a delete, the task as it was. `null` when none applies. */
export interface TaskWriteBack extends WriteBack {
  task: Task | null;
}

export interface PlanWriteBack extends WriteBack {
  plan: PlanSummary | null;
}

export interface BackupInfo {
  name: string;
  track: string;
  /** The instant in the file name, as a proper ISO string. */
  at: string;
  bytes: number;
  path: string;
}

/** What a reload installed: the parse, the dates re-planned and the dates restyled in place. */
export interface Installed {
  loaded: LoadedTasks;
  regenerated: string[];
  restyled: string[];
}

export interface WriteBackDeps {
  resourcesDir: string;
  dataDir: string;
  store: PlannerStore;
  service: PlanService;
  /** Keeps the API's task-file error list in step with every reload done here. */
  setErrors: (errors: ParseIssue[]) => void;
  /** SSE + the debounced calendar sync, for the dates a write changed. */
  announce: (dates: string[], reason: string) => void;
  log?: (msg: string) => void;
}

/** A sync sleep, for the handful of fs retries below. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write via a temp file in the same directory and a rename, so a reader (the daemon) never sees a
 * half-written file and no failure can leave one (rule 9). The temp name starts with a dot, which
 * `loadTaskFiles` skips, so even a crash between the two steps cannot leave something that loads.
 * Windows can refuse the rename while another process has the target open; that is transient.
 */
function writeAtomic(abs: string, text: string): void {
  const tmp = join(dirname(abs), `.${basename(abs)}.${process.pid}.${Date.now()}.tmp`);
  const discard = () => {
    try {
      unlinkSync(tmp);
    } catch {
      /* never created, or already gone */
    }
  };
  try {
    writeFileSync(tmp, text, "utf8");
  } catch (e) {
    // A failed write (no space, no permission) must not leave a dot-file behind: the loader skips
    // dot-names, so it would never appear in `skipped` and would sit in resources/ unnoticed.
    discard();
    throw e;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, abs);
      return;
    } catch (e) {
      if (attempt >= 4) {
        discard();
        throw e;
      }
      sleepSync(20 * (attempt + 1));
    }
  }
}

export class TaskFiles {
  constructor(private readonly d: WriteBackDeps) {}

  private get service() {
    return this.d.service;
  }

  // ------------------------------------------------------------------ reads

  listPlans(): { plans: PlanSummary[] } {
    return { plans: [...this.service.files].sort((a, b) => (a.path < b.path ? -1 : 1)).map(planSummary) };
  }

  /**
   * One plan in full: its front matter, its tasks and its raw Markdown, so a caller can quote the
   * file without opening it. `tasks` is the list here, not the count `GET /plans` reports.
   */
  readPlan(track: string): Omit<PlanSummary, "tasks"> & { meta: TaskFile["meta"]; tasks: Task[]; references: TaskFile["references"]; markdown: string } {
    const { file, abs } = this.planFile(track);
    const { tasks: _count, ...summary } = planSummary(file);
    return { ...summary, meta: file.meta, tasks: file.tasks, references: file.references, markdown: this.readText(abs, `plan "${track}"`) };
  }

  // ------------------------------------------------------------------ plans

  createPlan(input: Record<string, unknown>, dryRun: boolean): PlanWriteBack {
    const { intro, ...meta } = input;
    const track = meta.track;
    if (typeof track !== "string" || !TRACK_RE.test(track))
      throw invalid(
        `track must be a slug like "bcg" (${TRACK_RE.source}); got ${JSON.stringify(track)}`,
        "The track is the file name: it becomes resources/<track>.md and the first half of every task uid.",
      );
    if (intro !== undefined && typeof intro !== "string") throw invalid("intro must be a string", "Omit it for a file with front matter and a heading only.");
    const existing = this.service.files.find((f) => f.meta.track === track);
    if (existing)
      throw new PlannerError(
        "CONFLICT",
        `track "${track}" already exists in ${existing.path}`,
        `PATCH /plans/${track} changes its front matter, and POST /tasks adds tasks to it. Pick another track for a new plan.`,
      );
    const abs = this.guard(join(this.d.resourcesDir, `${track}.md`));
    if (existsSync(abs))
      throw new PlannerError("CONFLICT", `${rel(abs)} already exists but declares no task-file schema`, "Delete or fix that file by hand, then try again.");
    const ok = this.edited(renderPlanFile(meta as never, intro as string | undefined));
    const out = this.write({ track, abs, before: null, after: ok.text, reason: "plan-create", dryRun, warnings: ok.warnings });
    return { plan: ok.file ? planSummary(ok.file) : null, ...out };
  }

  patchPlan(track: string, patch: Record<string, unknown>, dryRun: boolean): PlanWriteBack {
    const { file, abs } = this.planFile(track);
    const before = this.readText(abs, `plan "${track}"`);
    const ok = this.edited(updateMeta(before, scalars(patch), file.path));
    const out = this.write({ track, abs, before, after: ok.text, reason: "plan-update", dryRun, warnings: ok.warnings });
    return { plan: ok.file ? planSummary(ok.file) : planSummary(file), ...out };
  }

  /**
   * Delete the whole file and everything it owns (rule 4 and rule 5). `confirm` has to repeat the
   * track, so a mistyped path cannot destroy a thousand lines of hand-written material.
   */
  deletePlan(track: string, confirm: unknown, dryRun: boolean): PlanWriteBack {
    const { file, abs } = this.planFile(track);
    if (confirm !== track)
      throw invalid(
        `deleting a plan needs ?confirm=${track}; got ${confirm === undefined ? "nothing" : JSON.stringify(confirm)}`,
        `This removes ${file.path} with all ${file.tasks.length} of its tasks and their status, progress and calendar events. Repeat the track to confirm: DELETE /plans/${track}?confirm=${track}`,
      );
    const before = this.readText(abs, `plan "${track}"`);
    const summary = planSummary(file);
    const out = this.write({
      track,
      abs,
      before,
      after: null,
      reason: "plan-delete",
      dryRun,
      forget: file.tasks.map((t) => t.uid),
      fromToday: true,
    });
    return { plan: summary, ...out };
  }

  // ------------------------------------------------------------------ tasks

  createTask(input: Record<string, unknown>, dryRun: boolean): TaskWriteBack {
    const { track, ...spec } = input;
    if (typeof track !== "string" || !track) throw invalid("track is required", 'Send { "track": "bcg", "title": "...", "duration": "40m", "type": "coding" }. GET /plans lists the tracks.');
    const { file, abs } = this.planFile(track);
    const before = this.readText(abs, `plan "${track}"`);
    const ok = this.edited(insertTask(before, spec as unknown as InsertSpec, file.path));
    const out = this.write({ track, abs, before, after: ok.text, reason: "task-create", dryRun, warnings: ok.warnings });
    return { task: ok.task ?? null, ...out };
  }

  patchTask(uid: string, patch: TaskPatch, dryRun: boolean): TaskWriteBack {
    const { task, abs } = this.taskFile(uid);
    const before = this.readText(abs, task.uid);
    this.ensureStillParses(before, task);
    const ok = this.edited(updateTask(before, task.uid, patch, task.file));
    const out = this.write({ track: task.track, abs, before, after: ok.text, reason: "task-update", dryRun, restyle: [task.uid], warnings: ok.warnings });
    return { task: ok.task ?? null, ...out };
  }

  /**
   * Remove the task's heading, block and body, and then everything the store knows about it. A
   * deleted task leaves nothing behind that a later reload could resurrect, so unlike every other
   * write this one rebuilds **today** as well: its minutes are gone from today's timeline too, and a
   * hole where the work used to be is not an answer.
   */
  deleteTask(uid: string, dryRun: boolean): TaskWriteBack {
    const { task, abs } = this.taskFile(uid);
    const before = this.readText(abs, task.uid);
    this.ensureStillParses(before, task);
    const ok = this.edited(cutTask(before, task.uid, task.file));
    const out = this.write({
      track: task.track,
      abs,
      before,
      after: ok.text,
      reason: "task-delete",
      dryRun,
      forget: [task.uid],
      fromToday: true,
      warnings: ok.warnings,
    });
    return { task, ...out };
  }

  // ---------------------------------------------------------------- backups

  private backupsDir(): string {
    return join(this.d.dataDir, BACKUPS_DIR);
  }

  listBackups(track?: string): { backups: BackupInfo[] } {
    const dir = this.backupsDir();
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return { backups: [] };
    }
    const out: BackupInfo[] = [];
    for (const name of names) {
      const m = BACKUP_RE.exec(name);
      if (!m || (track !== undefined && m[1] !== track)) continue;
      const path = join(dir, name);
      let bytes = 0;
      try {
        bytes = statSync(path).size;
      } catch {
        continue;
      }
      out.push({ name, track: m[1]!, at: isoFromStamp(m[2]!), bytes, path: rel(path) });
    }
    // The stamp is fixed-width, so a reverse name sort is a reverse time sort.
    return { backups: out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)) };
  }

  /**
   * Put a snapshot back. The current file is snapshotted first, so a restore is itself undoable.
   * It replaces the *file*: status and progress a delete dropped do not come back, and nothing is
   * forgotten for tasks the snapshot happens not to contain.
   */
  restoreBackup(name: string, dryRun: boolean): PlanWriteBack {
    const m = BACKUP_RE.exec(name);
    if (!m)
      throw invalid(
        `${JSON.stringify(name)} is not a snapshot name`,
        "GET /backups lists them; a name looks like bcg.2026-10-01T09-14-22Z.md. The name is all that is accepted - no path.",
      );
    const track = m[1]!;
    const path = join(this.backupsDir(), name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      throw new PlannerError("UNKNOWN_TASK", `no snapshot "${name}"`, "GET /backups lists the snapshots that exist.");
    }
    // The file may be gone (restoring a deleted plan) or live somewhere other than
    // resources/<track>.md (a loaded file in a subdirectory), so the loaded path wins when there is one.
    const loaded = this.service.files.find((f) => f.meta.track === track);
    const abs = this.guard(loaded ? resolve(REPO_ROOT, loaded.path) : join(this.d.resourcesDir, `${track}.md`));
    const before = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    const out = this.write({ track, abs, before, after: text, reason: "restore", dryRun, fromToday: true, restyle: this.service.tasks.filter((x) => x.track === track).map((x) => x.uid) });
    const file = this.service.files.find((f) => f.meta.track === track);
    return { plan: file ? planSummary(file) : null, ...out };
  }

  /**
   * Snapshot `text` as the state of `track` before a write, and prune to the newest
   * `BACKUPS_PER_TRACK`. The name carries the instant with `-` for `:`, because a colon is not a
   * legal character in a Windows file name.
   */
  private snapshot(track: string, text: string): string {
    const dir = this.backupsDir();
    mkdirSync(dir, { recursive: true });
    // The names of one track must keep increasing, because that is how the listing and the pruning
    // both decide which snapshot is newest. Starting from the bare clock is not enough: under a
    // frozen clock (PLANNER_NOW, tests) a prune frees the low names, the next snapshot walks back
    // into one, and sorts as the oldest - so the newest snapshot would be the first one dropped.
    const newest = this.listBackups(track).backups[0];
    let ms = Math.max(this.service.nowMs(), newest ? Date.parse(newest.at) + 1 : 0);
    let path = join(dir, `${track}.${stamp(ms)}.md`);
    // And a second snapshot inside the same millisecond walks forward until the name is free, so a
    // snapshot can never overwrite a snapshot.
    while (existsSync(path)) path = join(dir, `${track}.${stamp(++ms)}.md`);
    writeFileSync(path, text, "utf8");
    this.prune(track);
    return rel(path);
  }

  private prune(track: string): void {
    const expired = this.listBackups(track).backups.slice(BACKUPS_PER_TRACK);
    for (const b of expired) {
      try {
        unlinkSync(join(this.backupsDir(), b.name));
      } catch (e) {
        this.d.log?.(`could not prune snapshot ${b.name}: ${(e as Error).message}`);
      }
    }
  }

  // ------------------------------------------------------------- the pipeline

  /**
   * Re-read `resources/`, install it, re-plan and announce it. Throws `TASK_FILE_ERRORS` with the
   * parser's own list when the set is broken, *before* installing anything, so the previously loaded
   * tasks stay loaded: that is both what `POST /reload` answers and the signal a write-back reads as
   * "put the snapshot back". The one definition of "reload" - `POST /reload` comes through here too.
   */
  reload(reason = "reload", opts: { fromToday?: boolean; restyle?: readonly string[] } = {}): Installed {
    const out = this.install(opts);
    this.d.announce([...out.regenerated, ...out.restyled], reason);
    return out;
  }

  /**
   * The transactional half of a reload: load, check, install, re-plan. It announces nothing, so a
   * caller can run it inside a larger store transaction and have the whole thing roll back together
   * - which is how a delete's forgotten rows and its re-plan either both happen or neither does.
   */
  private install(opts: { fromToday?: boolean; restyle?: readonly string[] } = {}): Installed {
    const loaded = loadResources(this.d.resourcesDir);
    if (loaded.errors.length) {
      this.d.setErrors(loaded.errors);
      const first = loaded.errors[0]!;
      throw new PlannerError(
        "TASK_FILE_ERRORS",
        `${loaded.errors.length} error(s) in task files; the previous ${this.service.tasks.length} tasks stay loaded`,
        `Fix ${first.file}:${first.line} (${first.message}) and POST /reload again. \`npm run tasks:check\` shows the same list.`,
        loaded.errors,
      );
    }
    this.d.setErrors([]);
    const previous = [...this.service.files];
    try {
      return this.d.store.transaction(() => {
        this.service.setFiles(loaded.files);
        const regenerated = opts.fromToday ? this.service.replan(this.service.today()) : this.service.regenerateFuture();
        // After the re-plan, so a date that was rebuilt needs no restyle: its items are already new.
        const touched = new Set<string>();
        for (const uid of opts.restyle ?? []) for (const d of this.service.restyleTask(uid)) if (!regenerated.includes(d)) touched.add(d);
        return { loaded, regenerated, restyled: [...touched].sort() };
      });
    } catch (e) {
      // The store rolls its own transaction back; the in-memory file list has to be put back by hand.
      this.service.setFiles(previous);
      throw e;
    }
  }

  /**
   * The common tail of every mutation (rule 1), and the only place that writes a task file.
   *
   * `before === null` creates the file, `after === null` removes it. Nothing is written when the
   * text is unchanged and there is no state to forget: an empty diff is the honest answer, not a
   * pointless snapshot. `forget` names the uids whose stored state goes with the write, and it is
   * applied in the same SQLite transaction as the regeneration, so the two cannot half-happen.
   *
   * No partial writes (rule 2): if anything up to the rename fails, the file is byte-identical to
   * before. If the reload *after* the rename fails - text that parses alone but breaks the set, such
   * as a duplicate uid across files - the snapshot goes back and the call fails.
   */
  private write(args: {
    track: string;
    abs: string;
    before: string | null;
    after: string | null;
    reason: string;
    dryRun: boolean;
    /** Uids whose stored state this write removes (P9 rule 4). */
    forget?: readonly string[];
    /** Rebuild today as well, not just the days after it. Deletes and restores do. */
    fromToday?: boolean;
    /** Uids whose already-placed items should show the new title/links/type (see `restyled`). */
    restyle?: readonly string[];
    warnings?: string[];
  }): WriteBack {
    const { track, abs, before, after, reason, dryRun, forget = [], fromToday = false } = args;
    const file = rel(abs);
    const d = diff(before ?? "", after ?? "", file);
    const warn = args.warnings?.length ? { warnings: args.warnings } : {};

    if (dryRun)
      return { diff: d, file, regenerated: this.service.wouldReplan(fromToday ? this.service.today() : undefined), backup: null, sync: "skipped", dryRun: true, ...warn };

    if (before !== null && after !== null && before === after && !forget.length)
      return { diff: "", file, regenerated: [], backup: null, sync: "skipped", ...warn };

    const backup = before === null ? null : this.snapshot(track, before);
    // The one case where the file can end up ahead of the store: the write landed, the reload
    // failed, and putting the file back failed too. The answer has to say so rather than claim
    // nothing was written.
    let restoreFailed = false;
    const restore = () => {
      try {
        if (before === null) rmSync(abs, { force: true });
        else writeAtomic(abs, before);
      } catch (e) {
        this.d.log?.(`could not restore ${file} after a failed write: ${(e as Error).message}; the snapshot is ${backup}`);
        restoreFailed = true;
      }
    };

    if (after === null) rmSync(abs, { force: true });
    else writeAtomic(abs, after);

    // The forgotten rows and the re-plan share one transaction with the reload that validates the
    // set, so a broken set rolls both back. Without that, deleting a plan another file's
    // `starts_after` names would restore the file and keep the state it had already wiped.
    let done: Installed & { forgot?: ForgetCounts };
    try {
      done = this.d.store.transaction(() => {
        const forgot = forget.length ? this.d.store.forgetTasks(forget) : undefined;
        return { ...this.install({ fromToday, restyle: args.restyle }), ...(forgot ? { forgot } : {}) };
      });
    } catch (e) {
      restore();
      // The service is still holding the files from before the write, which is exactly what is back
      // on disk, so there is nothing to re-install - but `install` set the error list from the parse
      // that failed, and those errors describe a file that no longer exists. Re-derive it from what
      // is on disk now, or `GET /health` would report a broken set until the next POST /reload.
      try {
        this.d.setErrors(loadResources(this.d.resourcesDir).errors);
      } catch (re) {
        this.d.log?.(`could not re-read the task files after rolling back ${file}: ${(re as Error).message}`);
      }
      if (restoreFailed && e instanceof PlannerError)
        throw new PlannerError(
          e.code,
          `${e.message} - and ${file} could NOT be put back`,
          `The file on disk may now be ahead of the loaded plan. Restore it from ${backup ?? "a snapshot (GET /backups)"} and POST /reload.`,
          e.details,
        );
      throw e;
    }
    const { regenerated, restyled, forgot } = done;
    this.d.announce([...regenerated, ...restyled], reason);
    return { diff: d, file, regenerated, backup, sync: "queued", ...(forgot ? { forgot } : {}), ...(restyled.length ? { restyled } : {}), ...warn };
  }

  // ------------------------------------------------------------------ lookup

  /** The one loaded file of a track, or the error that says why there is not exactly one. */
  private planFile(track: unknown): { file: TaskFile; abs: string } {
    if (typeof track !== "string" || !TRACK_RE.test(track))
      throw invalid(`track must be a slug like "bcg" (${TRACK_RE.source}); got ${JSON.stringify(track)}`, "GET /plans lists the tracks that exist.");
    const files = this.service.files.filter((f) => f.meta.track === track);
    if (!files.length) {
      const known = [...new Set(this.service.files.map((f) => f.meta.track))];
      throw new PlannerError("UNKNOWN_TASK", `no plan with track "${track}"`, known.length ? `Tracks: ${known.join(", ")}. GET /plans lists them with their files.` : "No plans are loaded.");
    }
    if (files.length > 1)
      throw new PlannerError(
        "CONFLICT",
        `track "${track}" is declared by ${files.length} files (${files.map((f) => f.path).join(", ")})`,
        "These endpoints address one file per track. Merge them, or give one of them its own track, then try again.",
      );
    const file = files[0]!;
    return { file, abs: this.guard(resolve(REPO_ROOT, file.path)) };
  }

  private taskFile(uid: string): { task: Task; abs: string } {
    // `getTask` throws UNKNOWN_TASK with the closest-match hint, which is the answer we want here.
    const task = this.service.task(uid) ?? (this.service.getTask(uid) as never as Task);
    return { task, abs: this.guard(resolve(REPO_ROOT, task.file)) };
  }

  /**
   * Rule 8: a path has to end in `.md` and resolve inside the task directory, after symlinks. The
   * track pattern already makes `..` and separators impossible, so what is left to catch is a
   * symlinked file or directory pointing out of the tree, and a loaded file that somehow is not
   * under `resources/` at all.
   */
  private guard(abs: string): string {
    if (!abs.toLowerCase().endsWith(".md")) throw invalid(`${rel(abs)} is not a .md file`, "Task files are Markdown; only *.md under resources/ can be written.");
    const root = realpathSync(this.d.resourcesDir);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      // A file that does not exist yet: its directory is what has to be inside the tree.
      real = join(realpathSync(dirname(abs)), basename(abs));
    }
    if (real !== root && !real.startsWith(root + sep))
      throw invalid(`${rel(abs)} resolves outside the task directory`, `Task files live under ${rel(root)}; a symlink out of it is refused.`);
    return abs;
  }

  /**
   * Read a task file the service believes in. A file deleted or renamed outside the API since it was
   * loaded is not an internal error - it is a stale load, and the answer has to say so and name the
   * call that fixes it.
   */
  private readText(abs: string, what: string): string {
    try {
      return readFileSync(abs, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      throw new PlannerError(
        "CONFLICT",
        `${rel(abs)} is gone: ${what} is loaded from a file that is no longer there`,
        "The file was deleted or renamed outside the API. POST /reload to pick up what is on disk now, or GET /backups and POST /backups/:name/restore to put it back.",
      );
    }
  }

  /**
   * A task the service has loaded but the file on disk no longer yields is not a missing task: the
   * file has been broken since it was loaded, and the parser's own `file:line: message` is the useful
   * answer. Only a file that parses cleanly *without* the task is a genuine "not found".
   */
  private ensureStillParses(text: string, task: Task): void {
    const { file, errors } = parseTaskFile(text, task.file);
    if (file?.tasks.some((t) => t.uid === task.uid) || !errors.length) return;
    const first = errors[0]!;
    throw new PlannerError(
      "TASK_FILE_ERRORS",
      `${first.file}:${first.line}: ${first.message}`,
      `${task.uid} is loaded from ${task.file}, but that file no longer parses, so it cannot be edited. Fix the file by hand and POST /reload, or restore a snapshot (GET /backups).`,
      errors,
    );
  }

  /** Unwrap an editor result, turning a refusal into the HTTP error it deserves. */
  private edited(r: EditResult): EditOk {
    if (r.ok) return r;
    const { code, message, file, line } = r.error;
    throw new PlannerError(
      CODE_FOR[code],
      file !== undefined && line !== undefined && !message.startsWith(`${file}:`) ? `${file}:${line}: ${message}` : message,
      HINT_FOR[code],
      code === "unparsable" || code === "broken_result" ? [{ file: file ?? "task file", line: line ?? 0, message }] : undefined,
    );
  }
}

/**
 * Front matter holds YAML scalars, so a JSON body may only offer one per key. An object, an array or
 * a boolean is refused by name rather than stringified into the file as `[object Object]`.
 */
function scalars(patch: Record<string, unknown>): MetaPatch {
  const out: MetaPatch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && v !== undefined && typeof v !== "string" && typeof v !== "number")
      throw invalid(
        `${k} must be a string, a number or null; got ${Array.isArray(v) ? "an array" : typeof v}`,
        "Front-matter values are single YAML scalars. `null` removes an optional key.",
      );
    out[k] = v as string | number | null | undefined;
  }
  return out;
}

/** `2026-10-01T09-14-22-123Z`: an ISO instant a Windows file name can hold, and that sorts by time. */
function stamp(ms: number): string {
  const [date, time] = new Date(ms).toISOString().split("T") as [string, string];
  const [hms, frac] = time.replace("Z", "").split(".") as [string, string];
  return `${date}T${hms.replaceAll(":", "-")}-${frac}Z`;
}

/** The inverse of `stamp`, for `GET /backups`. */
function isoFromStamp(s: string): string {
  const [date, time] = s.split("T") as [string, string];
  const p = time.split("-");
  const hms = `${p[0]}:${p[1]}:${p[2]}`;
  return `${date}T${hms}${p[3] ? `.${p[3]}` : ""}Z`;
}
