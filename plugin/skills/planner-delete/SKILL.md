---
name: planner-delete
description: Remove a task or a whole plan from the owner's study planner through the local service at http://127.0.0.1:4317 — DELETE /tasks/:uid removes a task's heading, block, body and all of its stored state, and DELETE /plans/:track?confirm=<track> deletes an entire task file and everything it owns. The API writes the resources/*.md file itself, so never hand-delete from a task file. Confirm with the user before deleting a plan, and preview with dryRun. Use for "delete that task", "remove A42", "drop the Salesforce plan", "I don't need this track any more", and for renaming a task id (delete, then re-create).
---

# Planner · delete a task or a plan

Two nouns:

- A **plan** is one task file in `resources/` — one track, its front matter, its hand-written prose.
  `bcg.md` is a plan: **1087 lines**, of which the tasks are a small part.
- A **task** is one heading plus its ` ```task ` block inside a plan.

**Deleting is the one operation here that destroys the owner's writing. Slow down.**

## The Markdown rule — read this before you write anything

**Every removal goes through this API, which edits the `resources/*.md` file for you**, in the same
transaction that drops the task's stored state, regenerates the affected days and queues the calendar
sync. That is what keeps the file, the schedule and Google Calendar in step.

- **Never** delete from a task file with Edit or Write. A hand delete orphans the task's status,
  progress, held sessions and calendar events, does nothing to the schedule until someone remembers
  `POST /reload`, and has no undo once the editor is closed. The API removes all of it in one
  transaction and snapshots the file first.
- **Never** call Google Calendar directly to delete events. The next reconcile removes them because
  the items no longer exist.
- **Never** touch `.data/` (the SQLite state).

**The dividing line** (docs/PLAN.md, P9):

> **If a change would survive `POST /reload`, it belongs in the Markdown. If `POST /reload` would
> wipe it, it belongs in SQLite.**

The existence of a task or a plan is Markdown — this skill. Done, skipped, progress, days off and the
pause are SQLite: `study-planner:planner-schedule` and `study-planner:planner-pause-resume`.

**Delete is not skip.** If the user says "drop A1", "I don't want to do A1" or "take A1 off the
plan", **ask which they mean**:

- **Skipped** (`POST /tasks/bcg%2FA1/status {"status":"skipped"}`,
  `study-planner:planner-schedule`) keeps the task in the file and in history, and can be undone with
  `{"status":"pending"}`. This is almost always what they want — it is how a retired skip-test
  technique is recorded.
- **Deleted** (this skill) removes the task, its progress and its events for good. The Markdown is
  recoverable from a snapshot; the progress is not.

## Calling the API

Base URL `http://127.0.0.1:4317` by default. Loopback only, no auth, JSON.

**Finding the port.** It is `PLANNER_API_PORT`, default 4317:

1. `.data/runtime.json` in the repo, written at every `npm start` / `npm run dev`:
   `{ "apiUrl": "http://127.0.0.1:4417", … }` — the *last* start, so confirm with `GET <apiUrl>/health`.
2. `PLANNER_API_PORT` in the environment or the repo's `.env` (the environment wins).
3. The `[preflight] API: http://127.0.0.1:<port>` line `npm start` prints.
4. The default, 4317. 5. Otherwise, ask the user.

**Always start with `GET /health`.** Connection refused (curl exit 7) on every candidate port means
the service is down: ask the user to run `npm start` from the repo root. **Do not fall back to
deleting from the file yourself.** Don't set a short `-m`/`--max-time`.

**Use the Bash tool with `curl -s`**, on every OS including Windows (Git Bash). Do **not** pass a
JSON body to `curl.exe` from Windows PowerShell 5.1: it strips the inner quotes, so
`'{"dryRun":true}'` arrives as `{dryRun:true}` and fails with `INVALID_INPUT` — which on a delete is
the difference between a preview and the real thing, so prefer the `?dryRun=true` query form, or
PowerShell:

```powershell
Invoke-RestMethod -Method Delete -Uri 'http://127.0.0.1:4317/tasks/bcg%2FA42?dryRun=true'
```

An error answer makes `Invoke-RestMethod` throw; the JSON body is in `$_.ErrorDetails.Message`.

**Identifiers.** Task uid `track/id` (`bcg/A1`, `lessons/DAILY`), URL-encoded as `bcg%2FA1`. Item key
`YYYY-MM-DD|<uid>|<part>`. Tracks: `bcg` (prep, priority 1), `salesforce` (2), `anthropic` (3),
`lessons`, `portfolio`, `apply`.

## Endpoints

| Endpoint | Query | Effect |
|---|---|---|
| `DELETE /tasks/:uid` | `?dryRun=true` optional | Removes the heading, the ` ```task ` block and the body, **and** the task's stored state. |
| `DELETE /plans/:track` | **`?confirm=<track>` required**, `?dryRun=true` optional | Deletes the whole file and every task, status, progress and calendar event it owns. |
| `GET /backups` | — | Lists the snapshots: `.data/taskfile-backups/<track>.<iso>.md`, newest 20 per track. |
| `POST /backups/:name/restore` | — | Restores one snapshot, then reloads and regenerates. Recovers a wrong delete without git. |

Both deletes accept `dryRun: true` in the body or `?dryRun=true`, and both answer with the same
envelope:

```
{ task|plan, diff, file, regenerated: string[], backup, sync: "queued"|"skipped" }
```

`diff` is a unified diff against the file as it was, returned on **real** calls too, so the answer
always says exactly what was removed. `backup` names the snapshot taken first — quote it to the user
after any delete.

```sh
# a task: preview, then commit
curl -s -X DELETE "http://127.0.0.1:4317/tasks/bcg%2FA42?dryRun=true"
curl -s -X DELETE http://127.0.0.1:4317/tasks/bcg%2FA42

# a whole plan: confirm with the USER first, then dry-run, then commit
curl -s -X DELETE "http://127.0.0.1:4317/plans/salesforce?confirm=salesforce&dryRun=true"
curl -s -X DELETE "http://127.0.0.1:4317/plans/salesforce?confirm=salesforce"

# recovery
curl -s http://127.0.0.1:4317/backups
curl -s -X POST http://127.0.0.1:4317/backups/salesforce.2026-10-01T09-14-22-317Z.md/restore
```

## `DELETE /plans/:track` — confirm with the user, every time

`?confirm=<track>` must repeat the track exactly, so a mistyped path cannot destroy a 1000-line file.
**That guard protects against your typo, not against a misunderstanding — so before you call it:**

1. **Ask the user, in plain words, and wait for an answer.** Name what goes: the file
   `resources/<track>.md` and all of its hand-written material (for `bcg`, 1087 lines: the contents
   list, the prose explaining the assessment, the tables, the `python` fences, the "Transfers to:"
   notes), every task in it, every task's status, progress and held sessions, and every Google
   Calendar event it owns.
2. **Show them what is in it first**: `GET /plans/:track` (front matter, tasks, raw Markdown) and
   `GET /tracks` for how much is already done. "This deletes 23 tasks, 9 of them done" is the
   sentence that stops a mistake.
3. **Dry-run it** and show the diff and the dates that would regenerate.
4. Only then commit — and report the `backup` path, so they know the file is recoverable.
5. **Offer the alternative.** If they only want to stop working on a track, a days shift or skipping
   its tasks (`study-planner:planner-schedule`) leaves the writing in place.

Never run the real delete in the same breath as the dry run, and never infer the confirmation from an
earlier "yes" to something else.

## `DELETE /tasks/:uid` — a delete is a delete everywhere

In one transaction it removes the Markdown section and then the task's rows in `task_status` (the
bare uid **and** every `uid@date` a daily task has), `plan_items`, `task_progress`, `sessions_held`
and the `notifications` already fired for its items. The next reconcile deletes its calendar events,
because its items no longer exist. **A deleted task leaves nothing behind that a later `POST /reload`
could resurrect**, and no row in any of those five tables mentions the uid afterwards. The answer's
`forgot` field reports the counts per table, so quote it.

A delete rebuilds **today** as well as the days after it — a restore is the only other write-back
that does — because the minutes are gone from today's timeline too, and a hole where the work used to
be is not an answer. So `regenerated` includes today, and `GET /today` is already correct when the
call returns.

So a half-finished task's progress goes with it. Check `GET /tasks/:uid` first: if
`progress.doneMin > 0`, say so before deleting, and offer `skipped` instead.

## Renaming a task id

`id` is immutable: the uid `track/id` is what stored progress, plan-item keys (`date|uid|part`) and
the calendar's `plannerKey` all key on, so renaming one would have to migrate three stores and every
existing Google event. `PATCH /tasks/:uid` rejects `id`.

**A rename is therefore `DELETE /tasks/<old uid>` then `POST /tasks` with the new id**
(`study-planner:planner-create`). Tell the user the cost first: the delete drops the task's status,
progress and held sessions, so a partly done task comes back as new work. If what they want is a
better *name*, `PATCH` the `title` instead (`study-planner:planner-update`) — the title is the
calendar event summary, not the identity.

## How to work

1. **Find the exact target.** `GET /tasks/:uid` or `GET /tasks?track=<track>`, `GET /plans`. Ids
   repeat across tracks (`A1` is in `bcg` *and* `salesforce`), so resolve the track before deleting
   and ask if it is ambiguous. **Never** delete on a guessed uid.
2. **Always dry-run first** — a delete is destructive by definition — and show the user the returned
   `diff`. A dry run writes nothing: bytes and mtime unchanged, and the diff it returns is exactly the
   diff the real call then produces.
3. For a plan, get the user's explicit confirmation (above).
4. Commit, then report: what was removed, the dates in `regenerated`, the `backup` path, and whether
   the sync was `queued` or `skipped`.
5. **Never follow a successful delete with `POST /reload`.** The call already reloaded.
6. **If it was wrong**, `GET /backups`, find the newest snapshot for that track, then
   `POST /backups/<name>/restore`. That restores the **Markdown**; the deleted status and progress do
   not come back.

## What the service guarantees

- **Surgical, not re-rendered.** A task delete touches only the lines inside the task's span and
  leaves every other byte of the file alone.
- **No partial writes, ever.** Validate → build the new text → **re-parse it** → snapshot → write
  atomically (temp file, then rename) → drop the stored state → reload → regenerate → queue sync. If
  anything before the rename fails, the file is byte-identical to before; if the reload after it
  fails, the snapshot is restored and the call fails.
- **Blank lines are normalised, never multiplied**: removing a section leaves exactly one blank line
  between its neighbours.
- **The hand-written contents list is not maintained.** It points at `##` sections and tasks are
  `###`, so a task delete cannot leave a dangling entry; a plan delete removes the whole file, so no
  entry survives either.
- **Only under `resources/`**: every resolved path is checked to be inside the task directory and to
  end in `.md`, after symlink resolution; a `track` that is not `[a-z0-9][a-z0-9-]*` is rejected, so
  no request can name `../../.env`.
- **Snapshots**: `.data/taskfile-backups/<track>.<iso>.md`, the newest 20 per track.

## Errors

Always `{"error":{"code","message","hint"}}` — show the `hint`.

| Code (HTTP) | Meaning | What to do |
|---|---|---|
| connection refused | The service is down. | Ask the user to run `npm start`. **Don't edit the file yourself.** |
| `INVALID_INPUT` (400) | A missing or mismatched `?confirm=<track>`, a bad track name, a path-traversal attempt. | Repeat the track exactly in `confirm`. The file was not touched. |
| `UNKNOWN_TASK` (404) | No such uid or track. | Use the hint (the closest uid), or `GET /tasks` / `GET /plans`. **Don't retry with a guess — the next guess might exist.** |
| `TASK_FILE_ERRORS` (422) | The reload after the write broke the set; the snapshot was restored. | Show `details`, then investigate before retrying. |
| `CONFLICT` (409) | The target cannot be removed in its current state. | Explain, then act on what the hint names. |
| `FORBIDDEN_ORIGIN` / `FORBIDDEN_HOST` (403) | A browser `Origin`, or a `Host` other than `127.0.0.1:<port>`/`localhost:<port>`. | Call from the CLI on 127.0.0.1. |
| `CALENDAR_NOT_AUTHORIZED` (503) / `CALENDAR_ERROR` (502) | **The Markdown delete and the local state change did succeed**; only the calendar is behind. | Say so, then → `study-planner:planner-calendar-sync`. |
| `INTERNAL` (500) | Unexpected failure. | Report it with the request; check the API console output and `GET /plans/:track` to see whether the file survived. |

## Where to go next

- Skip instead of delete, or shift a track out of the way → `study-planner:planner-schedule`
- Re-create a task after a rename → `study-planner:planner-create`
- Change a task instead of removing it → `study-planner:planner-update`
- Backups, diffs and how the write-back works → `study-planner:planner-markdown-sync`
- Reads → `study-planner:planner-read`
