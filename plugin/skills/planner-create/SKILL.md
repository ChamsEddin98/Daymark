---
name: planner-create
description: Add work to the owner's study planner through the local service at http://127.0.0.1:4317 — create a new task inside an existing plan (POST /tasks) or start a whole new plan file / track (POST /plans). The API writes the resources/*.md file itself and regenerates the schedule in the same call, so never hand-edit a task file. Use for "add a task", "add this LeetCode problem to BCG", "new mock interview", "put a 2h build task after A6", "start an Anthropic plan", "create a new track".
---

# Planner · create a task or a plan

Two nouns:

- A **plan** is one task file in `resources/` — one track, its front matter, its prose. `bcg.md` is a
  plan.
- A **task** is one heading plus its ` ```task ` block inside a plan.

## The Markdown rule — read this before you write anything

**Every create goes through this API, which writes the `resources/*.md` file for you**, in the same
call that re-parses it, regenerates the affected days and queues the calendar sync. That is what
keeps the file, the schedule and Google Calendar in step.

- **Never** create or edit a task file with Edit or Write. A hand-written task does nothing until
  someone remembers `POST /reload`, and text that parses as YAML but not as a task block (`duration:
  40` instead of `40m`) breaks the next reload, possibly days later. The API re-parses the *proposed*
  text before writing and rejects it with the parser's own `file:line: message`, having written
  nothing.
- **Never** call Google Calendar directly. The service creates the events on its own.
- **Never** touch `.data/` (the SQLite state).

**The dividing line** (docs/PLAN.md, P9):

> **If a change would survive `POST /reload`, it belongs in the Markdown. If `POST /reload` would
> wipe it, it belongs in SQLite.**

Title, duration, type, links, `repeat`, `occurrences`, order, body and front matter are Markdown —
this skill. Done, skipped, progress, days off and the pause are SQLite:
`study-planner:planner-schedule` and `study-planner:planner-pause-resume`. Nothing is written to
both.

## Calling the API

Base URL `http://127.0.0.1:4317` by default. Loopback only, no auth, JSON. Send
`content-type: application/json`.

**Finding the port.** It is `PLANNER_API_PORT`, default 4317:

1. `.data/runtime.json` in the repo, written at every `npm start` / `npm run dev`:
   `{ "apiUrl": "http://127.0.0.1:4417", … }` — the *last* start, so confirm with `GET <apiUrl>/health`.
2. `PLANNER_API_PORT` in the environment or the repo's `.env` (the environment wins).
3. The `[preflight] API: http://127.0.0.1:<port>` line `npm start` prints.
4. The default, 4317. 5. Otherwise, ask the user.

**Always start with `GET /health`.** Connection refused (curl exit 7) on every candidate port means
the service is down: ask the user to run `npm start` from the repo root. **Do not fall back to
writing the Markdown yourself.** Don't set a short `-m`/`--max-time`.

**Use the Bash tool with `curl -s`**, on every OS including Windows (Git Bash). Do **not** pass a
JSON body to `curl.exe` from Windows PowerShell 5.1: it strips the inner quotes, so
`'{"status":"done"}'` arrives as `{status:done}` and fails with `INVALID_INPUT` — and a task body is
far longer than that. PowerShell fallback:

```powershell
$body = @{ track = 'bcg'; id = 'A42'; title = 'A42 · Window functions'; duration = '40m'; type = 'coding' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4317/tasks' -ContentType 'application/json' -Body $body
```

An error answer makes `Invoke-RestMethod` throw; the JSON body is in `$_.ErrorDetails.Message`.
For a long body from Bash, prefer `-d @file.json` over a quoted one-liner.

**Identifiers.** Task uid `track/id` (`bcg/A1`, `lessons/DAILY`), URL-encoded as `bcg%2FA1`. Item key
`YYYY-MM-DD|<uid>|<part>`; rests are `YYYY-MM-DD|rest|<n>`. Existing tracks: `bcg` (prep, priority
1), `salesforce` (2), `anthropic` (3), `lessons`, `portfolio`, `apply`.

## Endpoints

| Endpoint | Body | Effect |
|---|---|---|
| `POST /tasks` | `{ track, id?, title, duration, type, links?, repeat?, occurrences?, body?, section?, after? }` | Inserts the task's heading, its ` ```task ` block and its body into `resources/<track>.md`. `after` is a task uid to place it behind; the default is the end of its section. |
| `POST /plans` | `{ track, title, kind, priority?, defaultDuration?, startsAfter?, intro? }` | Creates `resources/<track>.md` with front matter and **no tasks**. `intro` is prose placed under the front matter. |

Both accept `dryRun: true` in the body or `?dryRun=true`, and both answer with the same envelope:

```
{ task|plan, diff, file, regenerated: string[], backup, sync: "queued"|"skipped" }
```

- `diff` is a unified diff against the file as it was. It comes back on **real** calls too, so the
  answer always says exactly what was done to the document.
- `file` is the path written, `backup` the snapshot taken first, `regenerated` the dates rebuilt.
  A **new** plan file snapshots nothing, so `backup` is `null` there.
- `warnings` appears when the API had to decide something for you: an `id` it derived because you sent
  none, or a `section` that did not exist and was added at the end of the file. Read it and say so.
- A create rebuilds the days **after today**; today keeps the shape it already had, exactly as
  `POST /reload` leaves it. If the new task should also run today, check `GET /today` and then
  `POST /plan/regenerate {"from":"<today>"}` (`study-planner:planner-schedule`) — that call also
  clears a day off, so it is the user's to ask for.
- A paused plan does not block a create: the write lands and the future days are rebuilt as a reload
  would. Today — the frozen part — is untouched.

```sh
# a task
curl -s -X POST http://127.0.0.1:4317/tasks -H "content-type: application/json" -d '{
  "track":"bcg","id":"A42","title":"A42 · Window functions","duration":"40m","type":"coding",
  "links":["[Rank Scores](https://leetcode.com/problems/rank-scores/)"],
  "after":"bcg/A41","body":"Practise RANK, DENSE_RANK and ROW_NUMBER."
}'

# preview first
curl -s -X POST "http://127.0.0.1:4317/tasks?dryRun=true" -H "content-type: application/json" -d @task.json

# a plan
curl -s -X POST http://127.0.0.1:4317/plans -H "content-type: application/json" -d '{
  "track":"anthropic","title":"Anthropic prep","kind":"prep","priority":3,
  "defaultDuration":"1h","startsAfter":"salesforce","intro":"Research notes and interview prep."
}'
```

## Field rules

### A task

| Field | Rule |
|---|---|
| `track` | An existing plan's track. `GET /plans` lists them. Must match `[a-z0-9][a-z0-9-]*`. |
| `id` | Unique within the track, and **immutable once created** (see below). Optional — omit it and the service derives one — but prefer choosing it explicitly, because you cannot rename it later. |
| `title` | The heading text, and the Google Calendar event summary. Free to change later. |
| `duration` | `40m`, `2h`, `2h30m`. **Not** `40`, not `0.5h`. |
| `type` | One of `coding` `concept` `build` `mock` `drill` `reading` `admin`. |
| `links` | Optional: `"[label](url)"`, a bare URL, or a list of either. |
| `repeat` | Optional: `daily`. Makes it a daily task, whose status is set per date. |
| `occurrences` | Optional, with `repeat: daily`: the number of **sessions**, never a window of dates. |
| `body` | Optional prose, notes or fenced code under the heading, up to the next heading of the same or higher level. |
| `section` | Optional: the `##` section to put it in. |
| `after` | Optional: a task uid to place it behind. Default is the end of its section. |

### A plan

| Field | Rule |
|---|---|
| `track` | The slug, and the file name: `resources/<track>.md`. Must match `[a-z0-9][a-z0-9-]*`, so no request can name `../../.env`. |
| `title` | Front-matter `title`. |
| `kind` | `prep` \| `lessons` \| `portfolio` \| `recurring`. |
| `priority` | **prep only**; lower runs first. |
| `defaultDuration` | Optional, e.g. `1h`, used by tasks that omit `duration`. |
| `startsAfter` | Optional: a track whose completion gates this one (`apply` starts the day BCG finishes). |
| `intro` | Optional prose under the front matter. |

The file the service writes always carries `schema: planner/task-file@1`.

### `id` is immutable

The uid `track/id` is what stored progress, plan-item keys (`date|uid|part`) and the calendar's
`plannerKey` (`extendedProperties.private.plannerKey`) **all** key on. Renaming one would have to
migrate three stores and every existing Google event, so it is not allowed: `PATCH /tasks/:uid`
rejects `id`. **Renaming means `DELETE /tasks/:uid` then `POST /tasks` with the new id**
(`study-planner:planner-delete`, then this skill) — and the task's progress and history go with the
delete. The **title** is free to change; it is the event summary, not the identity. So pick the id
once, and pick it well.

## How to work

1. **Look before you write.** `GET /plans` for the tracks, `GET /plans/:track` for the file's
   sections and existing ids, `GET /tasks?track=<track>` for the ids in use. A duplicate id is
   rejected, and placing a task well needs `after` or `section`.
2. **Preview wide or destructive edits with `dryRun`,** and show the user the returned `diff` before
   committing. Always dry-run a new plan file, a task with a long `body`, anything you are inferring
   rather than quoting, and any batch of more than one or two tasks. A dry run writes nothing: the
   file's bytes and mtime are unchanged, and the diff it returns is exactly the diff the real call
   then produces.
3. **Then commit** with the same body and no `dryRun`.
4. **Report from the response**: the task's uid, the dates in `regenerated`, and whether the sync was
   `queued` or `skipped`.
5. **Does it land on today?** The call regenerates the affected days. If today is not in
   `regenerated` and the user wants the new work today, follow up with
   `POST /plan/regenerate {"from":"<today>"}` (`study-planner:planner-schedule`) — and check
   `GET /today` first, because regenerating from today also clears a day off.
6. **Never follow a successful create with `POST /reload`.** The call already reloaded; `/reload` is
   only for files changed outside the API.

## What the service guarantees

- **Surgical, not re-rendered.** The editor changes the lines it was asked to change and leaves every
  other byte alone — the hand-written contents list, the prose, the tables, the `python` fences in
  `bcg.md` (1087 lines, of which the tasks are a small part) all survive untouched.
- **No partial writes, ever.** Validate → build the new text in memory → **re-parse it** → confirm it
  yields the intended task → snapshot the old file → write atomically (temp file, then rename) →
  reload → regenerate → queue sync. If anything before the rename fails, the file is byte-identical
  to before. If the reload after the rename fails — text that parses alone but breaks the set, such
  as a duplicate uid across files — the snapshot is restored and the call fails.
- **Rejected means untouched**: bytes and mtime unchanged, and the error carries the parser's own
  `file:line: message` where one applies.
- **Round-trip**: after an accepted create, re-parsing the file yields a task equal to the one the
  API returned, field for field.
- **Blank lines are normalised, never multiplied**: an inserted section is surrounded by exactly one
  blank line, so a sequence of edits never makes the file drift.
- **Only under `resources/`**: every resolved path is checked to be inside the task directory and to
  end in `.md`, after symlink resolution.
- Snapshots live in `.data/taskfile-backups/<track>.<iso>.md`, newest 20 per track
  (`study-planner:planner-markdown-sync`).

## Errors

Always `{"error":{"code","message","hint"}}` — show the `hint`.

| Code (HTTP) | Meaning | What to do |
|---|---|---|
| connection refused | The service is down. | Ask the user to run `npm start`. **Don't write the file yourself.** |
| `INVALID_INPUT` (400) | A bad `duration` (`40`, `0.5h`), an unknown `type`, a bad `track` name or a path-traversal attempt, a missing required field, `occurrences` without `repeat: daily`, `priority` on a non-prep plan, an unknown key. `message` names the field. | Fix the body. The file was not touched. |
| `TASK_FILE_ERRORS` (422) | The proposed text does not parse. `details` is `[{file,line,message}]`. | Show it, fix the body, retry. Nothing was written. |
| `UNKNOWN_TASK` (404) | The `after` uid or the `track` does not exist. | Use the hint, or `GET /plans` / `GET /tasks`. |
| `CONFLICT` (409) | A duplicate `id` in that track, or the track already exists (`POST /plans`), or the track is declared by two files, or the file is gone from disk. | Pick another id (or omit `id`), `PATCH` the existing plan, or `POST /reload` if the file vanished. |
| `FORBIDDEN_ORIGIN` / `FORBIDDEN_HOST` (403) | A browser `Origin`, or a `Host` other than `127.0.0.1:<port>`/`localhost:<port>`. | Call from the CLI on 127.0.0.1. |
| `CALENDAR_NOT_AUTHORIZED` (503) / `CALENDAR_ERROR` (502) | **The Markdown write and the local change did succeed.** | Say so, then → `study-planner:planner-calendar-sync`. |
| `INTERNAL` (500) | Unexpected failure. | Report it with the request; check the API console output. |

## Where to go next

- Change an existing task or plan → `study-planner:planner-update`
- Remove one → `study-planner:planner-delete`
- Mark it done / skipped, shift, regenerate, reload → `study-planner:planner-schedule`
- Diffs, backups and how the write-back works → `study-planner:planner-markdown-sync`
- Reads → `study-planner:planner-read`
