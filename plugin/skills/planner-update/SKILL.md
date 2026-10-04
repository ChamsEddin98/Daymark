---
name: planner-update
description: Change an existing task or plan in the owner's study planner through the local service at http://127.0.0.1:4317 — PATCH /tasks/:uid for a task's title, duration, type, links, repeat, occurrences, body or section, and PATCH /plans/:track for a plan's front matter (title, kind, priority, defaultDuration, startsAfter). The API rewrites the resources/*.md file itself and regenerates the schedule, so never hand-edit a task file. Use for "make A1 two hours", "rename that task", "add the LeetCode link to A6", "change the type to build", "make BCG priority 2", "make this a daily task". The task id cannot be changed.
---

# Planner · update a task or a plan

Two nouns:

- A **plan** is one task file in `resources/` — one track, its front matter, its prose.
- A **task** is one heading plus its ` ```task ` block inside a plan.

## The Markdown rule — read this before you write anything

**Every update goes through this API, which rewrites the `resources/*.md` file for you**, in the same
call that re-parses it, regenerates the affected days and queues the calendar sync. That is what
keeps the file, the schedule and Google Calendar in step.

- **Never** edit a task file with Edit or Write to change a task. A hand edit does nothing until
  someone remembers `POST /reload`; `duration: 40` instead of `40m` parses as YAML and breaks the
  next reload days later; and there is no undo once the editor is closed. The API re-parses the
  *proposed* text before writing and rejects it with the parser's own `file:line: message`, having
  written nothing.
- **Never** call Google Calendar directly. The service patches the events on its own.
- **Never** touch `.data/` (the SQLite state).

**The dividing line** (docs/PLAN.md, P9):

> **If a change would survive `POST /reload`, it belongs in the Markdown. If `POST /reload` would
> wipe it, it belongs in SQLite.**

Title, duration, type, links, `repeat`, `occurrences`, order, body and front matter are Markdown —
this skill. Done, skipped, progress, days off and the pause are SQLite:
`daymark:planner-schedule` and `daymark:planner-pause-resume`. Nothing is written to
both. So "make A1 two hours" is a PATCH here; "I finished A1" is **not**.

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
editing the Markdown yourself.** Don't set a short `-m`/`--max-time`.

**Use the Bash tool with `curl -s`**, on every OS including Windows (Git Bash). Do **not** pass a
JSON body to `curl.exe` from Windows PowerShell 5.1: it strips the inner quotes, so
`'{"duration":"2h"}'` arrives as `{duration:2h}` and fails with `INVALID_INPUT`. PowerShell
fallback:

```powershell
Invoke-RestMethod -Method Patch -Uri 'http://127.0.0.1:4317/tasks/bcg%2FA1' -ContentType 'application/json' -Body (@{ duration = '2h' } | ConvertTo-Json)
```

An error answer makes `Invoke-RestMethod` throw; the JSON body is in `$_.ErrorDetails.Message`.
For a long `body` field, prefer `-d @patch.json` over a quoted one-liner.

**Identifiers.** Task uid `track/id` (`bcg/A1`, `lessons/DAILY`), URL-encoded as `bcg%2FA1` in the
path (the unencoded `/tasks/bcg/A1` also works). Item key `YYYY-MM-DD|<uid>|<part>`. Tracks: `bcg`
(prep, priority 1), `salesforce` (2), `anthropic` (3), `lessons`, `portfolio`, `apply`.

## Endpoints

| Endpoint | Body | Effect |
|---|---|---|
| `PATCH /tasks/:uid` | any subset of `{ title, duration, type, links, repeat, occurrences, body, section }` | Rewrites **only what changed**, inside the task's own heading / block / body span. |
| `PATCH /plans/:track` | any subset of `{ title, kind, priority, defaultDuration, startsAfter }` | Rewrites **only those front-matter keys**. |

Both accept `dryRun: true` in the body or `?dryRun=true`, and both answer with the same envelope:

```
{ task|plan, diff, file, regenerated: string[], backup, sync: "queued"|"skipped" }
```

`diff` is a unified diff against the file as it was, returned on **real** calls too, so the answer
always says exactly what was done to the document. `file` is the path written, `backup` the snapshot
taken first, `regenerated` the dates rebuilt. Two more fields appear when they apply: `warnings` (a
`section` that had to be created, for instance) and **`restyled`** — see below.

```sh
# preview, then commit
curl -s -X PATCH "http://127.0.0.1:4317/tasks/bcg%2FA1?dryRun=true" \
  -H "content-type: application/json" -d '{"duration":"2h"}'
curl -s -X PATCH http://127.0.0.1:4317/tasks/bcg%2FA1 \
  -H "content-type: application/json" -d '{"duration":"2h"}'

# title, type and links at once
curl -s -X PATCH http://127.0.0.1:4317/tasks/bcg%2FA6 -H "content-type: application/json" -d '{
  "title":"A6 · Window functions, deeper",
  "type":"drill",
  "links":["[Rank Scores](https://leetcode.com/problems/rank-scores/)","https://sqlbolt.com"]
}'

# a plan's front matter
curl -s -X PATCH http://127.0.0.1:4317/plans/bcg \
  -H "content-type: application/json" -d '{"priority":2,"defaultDuration":"1h"}'
```

## Field rules

### A task

| Field | Rule |
|---|---|
| `title` | The heading text, and the Google Calendar event summary. Free to change — it is not the identity. |
| `duration` | `40m`, `2h`, `2h30m`. **Not** `40`, not `0.5h`. Changing it re-plans the task: parts are re-split and the days regenerate. |
| `type` | One of `coding` `concept` `build` `mock` `drill` `reading` `admin`. |
| `links` | Replaces the links: `"[label](url)"`, a bare URL, or a list of either. |
| `repeat` | `daily`, or removed to make the task one-off again. |
| `occurrences` | With `repeat: daily`: the number of **sessions**, never a window of dates. Sessions already held still count. |
| `body` | Replaces the prose under the heading, up to the next heading of the same or higher level. Send the whole body, not a fragment, and quote the user rather than inventing text. |
| `section` | Moves the task to another `##` section. |
| `id` | **Rejected.** See below. |

A PATCH is a subset: keys you don't send are left exactly as they are in the file.

### A plan

| Field | Rule |
|---|---|
| `title` | Front-matter `title`. |
| `kind` | `prep` \| `lessons` \| `portfolio` \| `recurring`. |
| `priority` | **prep only**; lower runs first. Changing it reorders the prep tracks. |
| `defaultDuration` | e.g. `1h`, used by tasks that omit `duration`. |
| `startsAfter` | A track whose completion gates this one (`apply` starts the day BCG finishes). |

`track` is the file name, so it is not patchable either — a new track means a new plan.

## `id` is immutable, and why

The uid `track/id` is what stored progress (`task_progress`), plan-item keys (`date|uid|part`) and
the calendar's `plannerKey` (`extendedProperties.private.plannerKey`) **all** key on. Renaming one
would have to migrate three stores and every existing Google event, so `PATCH` **rejects `id`** with
a hint to delete and re-create.

**To rename**: `DELETE /tasks/<old uid>` then `POST /tasks` with the new id
(`daymark:planner-delete`, then `daymark:planner-create`). Tell the user what that costs
before you do it: the delete removes the task's status, progress, held sessions and calendar events,
so a half-finished task comes back as new work. If what they actually want is a better **name**,
patch `title` instead — that is the event summary and it changes freely.

## How to work

1. **Find the task first.** `GET /tasks?track=<track>` or `GET /tasks/:uid`; `GET /plans` for the
   tracks and `GET /plans/:track` for the file's sections. Task ids repeat across tracks (`A1` is in
   `bcg` *and* `salesforce`; `anthropic` uses `T1`–`T8`), so resolve the track before you patch —
   the prep track that is `active` in `GET /tracks`, or the one scheduled today in `GET /today`. Ask
   if it is still ambiguous.
2. **Preview destructive or wide-reaching edits with `dryRun`, and show the user the returned
   `diff` before committing.** Always dry-run a `body` replacement, a `section` move, a duration
   change on a task that is partly done, a `repeat`/`occurrences` change, and anything you inferred
   rather than quoted. A dry run writes nothing: bytes and mtime unchanged, and the diff it returns is
   exactly the diff the real call then produces.
3. **Then commit** with the same body and no `dryRun`.
4. **Report from the response**: the fields that changed, the dates in `regenerated`, and whether the
   sync was `queued` or `skipped`. If the diff touched more than you expected, say so — `backup` names
   the snapshot it can be restored from.
5. **Never follow a successful PATCH with `POST /reload`.** The call already reloaded; `/reload` is
   only for files changed outside the API.
6. **A rename already reaches today; a re-timing does not.** A PATCH rebuilds the days **after
   today** — today keeps the shape it already had, exactly as `POST /reload` leaves it. But what an
   item *shows* is refreshed in place on today's existing items, keeping their times, keys, parts and
   status: a new `title`, `links` or `type` is live in today's view and in today's Google event
   straight away, and the answer lists today under **`restyled`**. What is *not* live today is a
   change to **when** work runs — `duration`, `repeat`, `occurrences`, `section`, or a plan's
   `priority` or `defaultDuration`. For those, if the user wants today to follow too, check
   `GET /today` and then `POST /plan/regenerate {"from":"<today>"}`
   (`daymark:planner-schedule`) — that call also clears a day off, which is why it is theirs
   to ask for and not something to do by reflex.
7. **A paused plan does not block a PATCH.** The file is the source of truth, so the write lands and
   the future days are rebuilt as a reload would. Today — the frozen part — is untouched.

## What the service guarantees

- **Surgical, not re-rendered.** The editor changes only the lines inside the task's span (its
  heading, its ` ```task ` fence and its body) or the named front-matter keys, and leaves every other
  byte alone — `bcg.md` is 1087 lines of hand-written contents list, prose, tables and `python`
  fences, and none of it is re-rendered.
- **No partial writes, ever.** Validate → build the new text in memory → **re-parse it** → confirm it
  yields the intended task → snapshot the old file → write atomically (temp file, then rename) →
  reload → regenerate → queue sync. If anything before the rename fails, the file is byte-identical
  to before; if the reload after it fails, the snapshot is restored and the call fails.
- **Rejected means untouched**: bytes and mtime unchanged, and the error carries the parser's own
  `file:line: message` where one applies.
- **Round-trip**: after an accepted PATCH, re-parsing the file yields a task equal to the one the API
  returned, field for field.
- **Blank lines are normalised, never multiplied**, so a sequence of edits never makes the file drift.
- **Only under `resources/`**: every resolved path is checked to be inside the task directory and to
  end in `.md`, after symlink resolution; a `track` that is not `[a-z0-9][a-z0-9-]*` is rejected.
- **The hand-written contents list is not maintained.** It points at `##` sections; tasks are `###`
  and are not in it, so editing a task cannot touch it.
- Snapshots live in `.data/taskfile-backups/<track>.<iso>.md`, newest 20 per track, listed by
  `GET /backups` and restored by `POST /backups/:name/restore`
  (`daymark:planner-markdown-sync`).

## Errors

Always `{"error":{"code","message","hint"}}` — show the `hint`.

| Code (HTTP) | Meaning | What to do |
|---|---|---|
| connection refused | The service is down. | Ask the user to run `npm start`. **Don't edit the file yourself.** |
| `INVALID_INPUT` (400) | A bad `duration` (`40`, `0.5h`), an unknown `type`, **`id` in the body** (immutable), `priority` on a non-prep plan, an unknown key, a bad `track`. `message` names the field. | Fix the body, or delete + re-create for an id change. The file was not touched. |
| `UNKNOWN_TASK` (404) | No such uid. | Use the hint (the closest uid), or `GET /tasks`. Don't guess repeatedly. |
| `TASK_FILE_ERRORS` (422) | The proposed text does not parse, or the reload after the write broke the set (e.g. a duplicate uid across files) — the snapshot was restored. `details` is `[{file,line,message}]`. | Show it, fix the body, retry. |
| `CONFLICT` (409) | The patch would collide with something that already exists. | Explain, then choose another value. |
| `FORBIDDEN_ORIGIN` / `FORBIDDEN_HOST` (403) | A browser `Origin`, or a `Host` other than `127.0.0.1:<port>`/`localhost:<port>`. | Call from the CLI on 127.0.0.1. |
| `CALENDAR_NOT_AUTHORIZED` (503) / `CALENDAR_ERROR` (502) | **The Markdown write and the local change did succeed.** | Say so, then → `daymark:planner-calendar-sync`. |
| `INTERNAL` (500) | Unexpected failure. | Report it with the request; check the API console output. |

## Where to go next

- Add a task or a plan → `daymark:planner-create`
- Remove one (and renaming an id) → `daymark:planner-delete`
- Mark it done / skipped, shift, regenerate, reload → `daymark:planner-schedule`
- Diffs, backups and how the write-back works → `daymark:planner-markdown-sync`
- Reads → `daymark:planner-read`
