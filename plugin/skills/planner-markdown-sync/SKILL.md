---
name: planner-markdown-sync
description: How the owner's study planner keeps its resources/*.md task files in step with the schedule and the calendar — the rule that every plan or task change must go through the API at http://127.0.0.1:4317 rather than a hand edit, which changes belong in Markdown and which in SQLite, the dryRun diff, the atomic surgical write, and the snapshot endpoints GET /backups and POST /backups/:name/restore. Use to check or explain what an edit did to a task file, to preview a diff before committing, to recover a file after a wrong edit or delete, when a task file and the plan disagree, or when something hand-edited a task file.
---

# Planner · Markdown synchronisation

The `resources/*.md` task files are the source of truth for **what the work is**. The planner's
SQLite store is the source of truth for **what has happened to it**. This skill is the mechanism that
keeps the first in step with the schedule and the calendar it generates, and how to inspect and
recover it.

## The rule

**Any update or removal of a plan or a task MUST go through the API.** The API writes the
corresponding `resources/*.md` file itself, in the same call that regenerates the affected days and
queues the calendar sync, so the file never falls behind the schedule it generated.

- **Claude Code must NEVER hand-edit a task file to change a task** — not with Edit, not with Write,
  not with `sed`. The endpoints in `study-planner:planner-create`,
  `study-planner:planner-update` and `study-planner:planner-delete` are the only way.
- **Claude Code must NEVER call Google Calendar directly.** The service rewrites the calendar after
  every change on its own.
- **Never touch `.data/`** (the SQLite store or the backups directory) by hand either.

## Which side is a change on?

> **If a change would survive `POST /reload`, it belongs in the Markdown. If `POST /reload` would
> wipe it, it belongs in SQLite.** (docs/PLAN.md, P9)

| Belongs in **Markdown** (written by the API) | Belongs in **SQLite** (never in a file) |
|---|---|
| `title` (the calendar event summary) | done |
| `duration` | skipped |
| `type` | progress (`doneMin`, `partsDone`, `remainingMin`) |
| `link` / `links` | held sessions (`occurrences` counting) |
| `repeat`, `occurrences` | days off |
| the order of tasks, the section they sit in | the pause |
| the body prose under a heading | the materialized plan items and their times |
| front matter: `track`, `title`, `kind`, `priority`, `default_duration`, `starts_after` | the calendar's event ids |

**Nothing is written to both.** `CLAUDE.md`'s rule still holds: status is never stored in Markdown.

So: "make A1 two hours" is a Markdown write (`PATCH /tasks/bcg%2FA1`). "I finished A1" is not
(`POST /tasks/bcg%2FA1/status`, `study-planner:planner-schedule`). A reload would keep the first and
wipe the second — which is exactly how to decide when you are unsure.

## Which endpoints write Markdown

| Endpoint | Writes `resources/*.md`? |
|---|---|
| `POST /plans`, `PATCH /plans/:track`, `DELETE /plans/:track` | **Yes** — `study-planner:planner-create` / `-update` / `-delete` |
| `POST /tasks`, `PATCH /tasks/:uid`, `DELETE /tasks/:uid` | **Yes** — same three skills |
| `POST /backups/:name/restore` | **Yes** — restores a whole file (below) |
| `POST /items/:key/status`, `POST /tasks/:uid/status` | No |
| `POST /plan/shift`, `/plan/shift/preview`, `/plan/regenerate` | No |
| `POST /plan/pause`, `/plan/resume` | No |
| `POST /reload` | No — it **reads** the files |
| `POST /sync`, every `GET` | No |

`POST /reload` is the only call for files that changed **outside** the API (a hand edit, a `git
pull`). Every write-back endpoint reloads and regenerates in the same call, so you never follow one
with `/reload`.

## Calling the API

Base URL `http://127.0.0.1:4317` by default. Loopback only, no auth, JSON. Send
`content-type: application/json` with a body.

**Finding the port.** It is `PLANNER_API_PORT`, default 4317:

1. `.data/runtime.json` in the repo, written at every `npm start` / `npm run dev`:
   `{ "apiUrl": "http://127.0.0.1:4417", … }` — the *last* start, so confirm with `GET <apiUrl>/health`.
2. `PLANNER_API_PORT` in the environment or the repo's `.env` (the environment wins).
3. The `[preflight] API: http://127.0.0.1:<port>` line `npm start` prints.
4. The default, 4317. 5. Otherwise, ask the user.

**Always start with `GET /health`** — `tasksLoaded` and `taskFileErrors` tell you whether the files
currently parse. Connection refused (curl exit 7) on every candidate port means the service is down:
ask the user to run `npm start`. **Don't fall back to editing or restoring files by hand.**

**Use the Bash tool with `curl -s`**, on every OS including Windows (Git Bash). Do **not** pass a
JSON body to `curl.exe` from Windows PowerShell 5.1: it strips the inner quotes, so
`'{"dryRun":true}'` arrives as `{dryRun:true}` and fails with `INVALID_INPUT`. Prefer the
`?dryRun=true` query form, or `Invoke-RestMethod` with `ConvertTo-Json`. An error answer makes
`Invoke-RestMethod` throw; the JSON body is in `$_.ErrorDetails.Message`.

**Identifiers.** Task uid `track/id` (`bcg/A1`, `lessons/DAILY`), URL-encoded as `bcg%2FA1`. Item key
`YYYY-MM-DD|<uid>|<part>`, rests `YYYY-MM-DD|rest|<n>`; the item key is also an event's
`plannerKey`. A plan's `track` must match `[a-z0-9][a-z0-9-]*` and maps to `resources/<track>.md`.

## Inspecting and recovering

| Endpoint | When to call it | Returns |
|---|---|---|
| `GET /plans` | Which plan files exist. | `{ plans: [{ track, path, title, kind, priority, tasks, startsAfter, defaultDurationMin }] }` |
| `GET /plans/:track` | Read a plan's front matter, its tasks **and its raw Markdown** — the way to see the file without opening it. | front matter + tasks + raw Markdown |
| `GET /backups` | List the snapshots after a wrong edit. | the snapshots in `.data/taskfile-backups/`, `<track>.<iso>.md`, newest 20 per track |
| `POST /backups/:name/restore` | Put a file back as it was, then reload and regenerate. Recovers a wrong edit or delete without git. | the write-back envelope |
| `POST /reload` | A file changed outside the API. On `422 TASK_FILE_ERRORS` the previous tasks stay loaded and `details` is `[{file,line,message}]`. | `{ tasks, files, skipped, errors: [], regenerated }` |

```sh
curl -s http://127.0.0.1:4317/plans
curl -s http://127.0.0.1:4317/plans/bcg
curl -s http://127.0.0.1:4317/backups
curl -s -X POST http://127.0.0.1:4317/backups/bcg.2026-10-01T09-14-22-317Z.md/restore
curl -s -X POST http://127.0.0.1:4317/reload
```

A restore replaces the **file**. It does not bring back status or progress that a delete dropped, and
it does not undo a status change (there was never any Markdown for that).

## The write-back envelope, and `dryRun`

Every mutating write-back call accepts `dryRun: true` in the body **or** `?dryRun=true`, and every
one answers with the same envelope:

```
{ plan|task, diff, file, regenerated: string[], backup, sync: "queued"|"skipped" }
```

- `diff` — a unified diff against the file as it was. Returned on **real** calls too, not just dry
  runs, so the answer always says exactly what was done to the document.
- `file` — the path written. `backup` — the snapshot taken first. `regenerated` — the dates rebuilt.
  `sync` — whether a calendar sync was queued.
- Three fields appear only when they apply: `warnings` (a derived `id`, a `section` that had to be
  created), `forgot` (rows a delete removed, per table) and `restyled`.
- **`restyled` vs `regenerated`.** A create or an update rebuilds the days **after today**, exactly
  as `POST /reload` does, so today keeps the shape it already had. A **delete** and a **restore**
  rebuild today too, because the work is gone from today as well and a hole in the timeline is not an
  answer. Separately, a change to what an item *shows* — `title`, `links`, `type` — is applied to
  today's already-placed items **in place**, keeping their times, keys, parts and status, so a rename
  is live in today's view and today's Google event immediately; `restyled` lists the dates that
  happened on. A change to **when** work runs (`duration`, `repeat`, `occurrences`, `section`,
  `priority`, `defaultDuration`) reaches today only via
  `POST /plan/regenerate {"from":"<today>"}`, which is the user's call because it also clears days off.
- **A write that changes no byte** answers `{ "diff": "", "backup": null, "sync": "skipped",
  "regenerated": [] }` instead of taking a pointless snapshot. That is a success, not a failure: the
  file already said what you asked for.
- **A paused plan does not block a write-back.** The file is the source of truth and must not sit out
  of step with the plan for the length of a pause, so the write lands and the future days are rebuilt
  as a reload would. Today — the frozen part — is untouched by a create or an update.

**Preview destructive or wide-reaching edits with `dryRun`, and show the user the returned diff
before committing.** Always dry-run: any delete, a `body` replacement, a `section` move, a new plan
file, a `repeat`/`occurrences` change, a batch of more than one or two edits, and anything you
inferred rather than quoted. **A dry run writes nothing** — the file's bytes and mtime are unchanged,
and the diff it returns is exactly the diff the real call then produces, so there is no reason to
skip it. Read the diff yourself before you show it: if it touches a line outside the span you
intended, stop and report that instead of committing.

## Why it is a surgical editor, not a serializer

These files are not data dumps. `bcg.md` is **1087 lines** of which the tasks are a small part: a
hand-written contents list, prose explaining what the assessment is, tables, `python` code fences,
"Transfers to:" notes. Parsing to `Task[]`, mutating and re-rendering would keep each task's body and
silently destroy everything that belongs to no task. So the editor changes the lines it was asked to
change and **leaves every other byte alone** — that is the acceptance criterion, not a goal.

It can do that because the parser exposes each task's span: the heading line, the ` ```task ` opening
fence, its closing fence, and the last line of the body (the line before the next heading of the same
or higher level).

### The guarantees you can rely on, and quote

1. **A bad edit cannot reach disk.** The API re-parses the **proposed** text before writing and
   rejects it with the parser's own `file:line: message`, having written nothing. Hand-editing
   `duration: 40` instead of `40m` leaves a file that parses as YAML and fails at the next reload,
   possibly days later.
2. **The schedule follows immediately.** The same call regenerates the affected days and queues the
   calendar sync, and reports which dates moved. A hand edit does nothing until someone remembers
   `POST /reload`.
3. **The state follows too.** A delete removes the task's `task_status` (the bare uid and every
   `uid@date`), `plan_items`, `task_progress`, `sessions_held` and `notifications` rows in the same
   transaction, and the next reconcile deletes its calendar events. Nothing is left for a later
   `POST /reload` to resurrect. The answer's `forgot` field counts what went, per table.
4. **It is reversible.** Every write that replaces or removes an existing file snapshots it first,
   into `.data/taskfile-backups/<track>.<iso>Z.md` (newest 20 per track), so a wrong delete is
   recoverable without git. The instant is written with `-` where a `:` or `.` would go, because a
   colon is not legal in a Windows file name: `bcg.2026-10-01T09-14-22-317Z.md`. A name is never
   reused, and `GET /backups` is sorted **newest first**, so the snapshot you want after a wrong edit
   is `backups[0]`. Creating a file that did not exist snapshots nothing, and `backup` is then `null`.
5. **It can be previewed.** `dryRun` returns the exact unified diff and the dates that would
   regenerate, with nothing written.
6. **No partial writes, ever.** The order is: validate the request → build the new text in memory →
   **re-parse that text** → confirm it yields the intended task → snapshot the old file → write
   atomically (a temp file in the same directory, then a rename) → reload → regenerate → queue sync.
   If any step before the rename fails, the file on disk is byte-identical to before. If the reload
   *after* the rename fails — text that parses in isolation but breaks the set, such as a duplicate
   uid across files — the snapshot is restored and the call fails. A mutation either happens
   completely or not at all.
7. **Rejected means untouched**: for a bad duration, an unknown type, a duplicate id, an unknown uid,
   a bad track name or a path-traversal attempt, the file's bytes **and mtime** are unchanged.
8. **Round-trip**: after any accepted mutation, re-parsing the file yields a task equal to the one the
   API returned, field for field.
9. **`id` is immutable.** The uid `track/id` is what stored progress, plan-item keys (`date|uid|part`)
   and the calendar's `plannerKey` all key on, so a rename would have to migrate three stores and
   every existing Google event. `PATCH` rejects `id`; renaming is delete + re-create. The `title` is
   free to change — it is the event summary, not the identity.
10. **Blank lines are normalised, never multiplied.** Removing a section leaves exactly one blank line
    between its neighbours; inserting one surrounds it with exactly one. A sequence of edits never
    makes the file drift.
11. **The hand-written contents list is not maintained.** It points at `##` sections and tasks are
    `###`, so editing a task cannot touch it; deleting a plan removes the whole file, so no dangling
    entry survives.
12. **Only under `resources/`.** Every resolved path is checked to be inside the task directory and to
    end in `.md`, **after symlink resolution**, and a `track` that is not `[a-z0-9][a-z0-9-]*` is
    rejected — so no request can name `../../.env`.
13. **The daemon never sees a half-written file**, because every write is an atomic rename. That is
    what makes the second reader safe without a lock.
14. **Calendar idempotency survives it**: after a mutation and its sync, a second sync reports
    `inserted: 0, patched: 0, deleted: 0`.

## When the file and the plan disagree

1. `GET /health` — `tasksLoaded`, `taskFileErrors`. A non-zero error count means the loaded tasks are
   **older** than the files: something changed them outside the API and the new text does not parse.
   A write-back that *failed* does not leave this set — it re-reads the directory after rolling the
   file back — so a non-zero count here is always a real, outstanding problem on disk.
2. `POST /reload`. On `422 TASK_FILE_ERRORS`, show `details` as `file:line: message`; the previous
   tasks stay loaded, so nothing is lost while it is broken.
3. **A file that does not parse cannot be repaired through the write-back API**, so do not try: a
   `PATCH` on a task whose block is broken answers `422` with the parser's `file:line: message`, and
   every other write is rolled back for as long as the set is broken, because each one re-reads all
   of `resources/`. In that order:
   a. `GET /backups` and `POST /backups/<backups[0].name>/restore` the last good snapshot — the
      newest is first in the list. This is the normal fix and it needs nothing from the user.
   b. If no snapshot covers it, show the user the `file:line: message` and ask them to fix that line,
      then `POST /reload`. Editing the file by hand is the escape hatch for a file that is **already**
      broken; it is still never the way to *change* a task.
   Once the set parses again, the write-back API works as usual — with `dryRun` first.
4. Reload regenerates only the future days. To fit changed work into **today**, follow with
   `POST /plan/regenerate {"from":"<today>"}` (`study-planner:planner-schedule`) — after `GET /today`,
   because regenerating from today also clears a day off.
5. If the user insists on hand-editing anyway: that is their file and their call, but tell them it is
   silent until `POST /reload`, that the API would have validated it first, and run `POST /reload`
   afterwards so the schedule catches up.

## Errors

Always `{"error":{"code","message","hint"}}` — show the `hint`.

| Code (HTTP) | Meaning | What to do |
|---|---|---|
| connection refused | The service is down. | Ask the user to run `npm start`. **Don't edit or restore files by hand.** |
| `TASK_FILE_ERRORS` (422) | A reload (or a proposed write) found invalid task files. `details` is `[{file,line,message}]`; the previous tasks stay loaded, and a failed post-rename reload restores the snapshot. | Show `details`, fix through the API, retry. |
| `INVALID_INPUT` (400) | A bad field, a bad track name, a path-traversal attempt, a missing `?confirm=<track>` on a plan delete. | Fix the request. The file was not touched. |
| `UNKNOWN_TASK` (404) | No such uid, track or backup name. | Use the hint, or `GET /plans` / `GET /backups`. |
| `FORBIDDEN_ORIGIN` / `FORBIDDEN_HOST` (403) | A browser `Origin`, or a `Host` other than `127.0.0.1:<port>`/`localhost:<port>`. | Call from the CLI on 127.0.0.1. |
| `CALENDAR_NOT_AUTHORIZED` (503) / `CALENDAR_ERROR` (502) | **The Markdown write succeeded**; only the calendar is behind. | Say so, then → `study-planner:planner-calendar-sync`. |
| `INTERNAL` (500) | Unexpected failure. | Report it; `GET /plans/:track` shows whether the file survived, and `GET /backups` the snapshot. |

## Where to go next

- Make the change: `study-planner:planner-create`, `study-planner:planner-update`,
  `study-planner:planner-delete`
- SQLite-side changes (done, skipped, shift, regenerate, reload) → `study-planner:planner-schedule`
- The calendar half of the sync → `study-planner:planner-calendar-sync`
- Reads → `study-planner:planner-read`

The binding spec is `docs/PLAN.md`, "P9 · Write-back: plan and task mutation APIs"; the endpoint
contract is `docs/API.md`.
