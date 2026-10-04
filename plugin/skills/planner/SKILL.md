---
name: planner
description: Router for the owner's local study-planner service at http://127.0.0.1:4317 — reading today's plan, marking work done or skipped, shifting or pausing the plan, creating, updating and deleting tasks and whole plan files, the active hours (when the day starts and ends, how many hours a day), Google Calendar sync, and the Markdown write-back rules. Use whenever the user asks about their study plan, today's or this week's tasks, prep progress (BCG, Salesforce, Anthropic), lessons, portfolio, applying, calendar sync, their working hours, or wants to add, change, remove, postpone, pause or reload any of it. This skill identifies the operation and sends you to the focused skill that owns it.
---

# Study planner · router

The planner is a standalone local service. It owns the schedule, the `resources/*.md` task files,
the Google Calendar sync and the desktop notifications. **You are only an HTTP client.**

This skill does three things and nothing else:

1. work out which planner operation the user is asking for,
2. load the skill that owns it,
3. make sure the call goes to the planner API and nowhere else.

The endpoint detail lives in the child skills. Don't guess an endpoint from here — load the child.

## Two rules that hold for every operation

**1. Every change goes through the API, which writes the Markdown.** Any create, update or removal
of a **plan** (one `resources/*.md` file: a track, its front matter, its prose) or a **task** (one
heading plus its ` ```task ` block) is made by calling the API. The API writes the `.md` file
itself, in the same call that regenerates the affected days and queues the calendar sync, so the
file, the schedule and the calendar never drift apart.

- **Never** hand-edit a `resources/*.md` file with Edit or Write to change a task. A hand edit does
  nothing until someone remembers `POST /reload`, can leave text that parses as YAML and breaks the
  next reload days later, orphans the task's progress, held sessions and calendar events, and has
  no undo.
- **Never** call Google Calendar directly, with any tool. The service rewrites the calendar after
  every change on its own.
- **Never** touch `.data/` (the SQLite state).

**2. The dividing line** (docs/PLAN.md, P9) tells you which kind of change you are making:

> **If a change would survive `POST /reload`, it belongs in the Markdown. If `POST /reload` would
> wipe it, it belongs in SQLite.**

- **Markdown** — title, duration, type, links, `repeat`, `occurrences`, order, body, front matter:
  the write-back endpoints in `planner-create`, `planner-update`, `planner-delete`.
- **SQLite** — done, skipped, progress, days off, the pause: `planner-schedule` and
  `planner-pause-resume`, which write **no** Markdown.
- Nothing is ever written to both.

## Routing table

Load a child with the Skill tool (`daymark:<name>`); the user can type `/daymark:<name>`.
Each child is self-contained — it repeats the base URL, the port discovery, the health check and the
identifier formats — so you never need this skill loaded alongside it. Load more than one when a
request spans areas.

| The user wants to … | Load |
|---|---|
| Know what's now or next, today's or the week's plan, a task's details or remaining minutes, track progress, which plans exist, which notifications fired | `daymark:planner-read` |
| Mark something done or skipped, undo it, shift the plan by minutes/hours/days, pull the rest of today earlier, reload after hand-edited files | `daymark:planner-schedule` |
| Add a task, or start a new plan / track | `daymark:planner-create` |
| Change a task's title, duration, type, links, `repeat`, `occurrences`, body or section, or a plan's front matter | `daymark:planner-update` |
| Remove a task, or delete a whole plan file | `daymark:planner-delete` |
| Step away and come back — "pause", "hold on", "I'm back" | `daymark:planner-pause-resume` |
| Change the working hours — when the day starts or ends, how many hours a day, what happens to a task whose time passed | `daymark:planner-settings` |
| Check or force the Google Calendar sync, fix calendar auth, see what is actually in the calendar | `daymark:planner-calendar-sync` |
| Understand or verify how a change reached the `.md` file, preview a diff before committing, recover a file from a backup | `daymark:planner-markdown-sync` |

### Route on the verb, not the noun

The same task can be the subject of either kind of change, so route on *what is being changed*:

| The user says | It is | Load |
|---|---|---|
| "A1 should be 2 hours, not 40 minutes" | Markdown — survives a reload | `planner-update` |
| "my days should be 2 hours longer" | a setting — the day's budget, not any task | `planner-settings` |
| "I finished A1" / "I already know A1, skip it" | SQLite — a reload would wipe it | `planner-schedule` |
| "Drop A1" | Ambiguous. **Ask first**: *skipped* keeps the task in the file and in history; *deleted* removes it, its progress and its events for good | `planner-schedule` or `planner-delete` |
| "Add a LeetCode task to BCG" / "start an Anthropic plan" | Markdown | `planner-create` |
| "I edited bcg.md myself" | A reload, not a write-back | `planner-schedule` |
| "Rename A1 to A1b" | `id` is immutable: delete, then re-create | `planner-delete`, then `planner-create` |
| "Push everything an hour" / "move it all to tomorrow" | SQLite | `planner-schedule` |
| "Is my calendar up to date?" | — | `planner-calendar-sync` |
| "Show me what that edit did to the file" | — | `planner-markdown-sync` |

## The few things every operation needs

### Finding the port

The API listens on `PLANNER_API_PORT`, default 4317. Find it in this order:

1. `.data/runtime.json` in the repo, written at every `npm start` / `npm run dev`:
   `{ "apiUrl": "http://127.0.0.1:4417", "webUrl": …, "apiPort", "webPort", "startedAt" }`. It is the
   *last* start, so confirm with `GET <apiUrl>/health`.
2. `PLANNER_API_PORT` in your environment, or in the repo's `.env` (the environment wins).
3. The `[preflight] API: http://127.0.0.1:<port>` line `npm start` prints.
4. The default, 4317.
5. Otherwise, ask the user.

Use the port you found in every call.

### Always start with GET /health

```sh
curl -s http://127.0.0.1:4317/health
```

`/health` never fails while the service is up. Read `paused`, `tasksLoaded`, `taskFileErrors` and
`calendar.authorized` from it before you act.

- **Connection refused / "couldn't connect"** (curl exit 7) on every candidate port means the
  service is down. Ask the user to run `npm start` from the repo root (it starts the API, the
  daemon and the web UI). Don't start it yourself unless asked, and **don't fall back to reading
  files**.
- Don't pass a short `-m`/`--max-time`: a slow first answer, such as a sync, is not a dead service.

### Identifiers

- **Task uid**: `track/id` — `bcg/A1`, `salesforce/MOCK-3`, `lessons/DAILY`. URL-encode the slash in
  a path: `bcg%2FA1`.
- **Item key**: one scheduled occurrence, `YYYY-MM-DD|<uid>|<part>` (`2026-09-28|bcg/A6|1`). Rests
  are `YYYY-MM-DD|rest|<n>`. A split task has one item per part.
- **Tracks**: `bcg` (prep, priority 1), `salesforce` (2), `anthropic` (3), `lessons`, `portfolio`,
  `apply` (starts the day BCG finishes).

### How to call it, and the Windows quoting trap

Use the **Bash** tool with `curl -s`, on every OS including Windows (Git Bash). Do **not** pass a
JSON body to `curl.exe` from Windows PowerShell 5.1: it strips the inner quotes, so
`'{"status":"done"}'` arrives as `{status:done}` and fails with `INVALID_INPUT`. If only PowerShell
is available, use `Invoke-RestMethod` and build the body with `ConvertTo-Json`:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4317/tasks/bcg%2FA1/status' -ContentType 'application/json' -Body (@{ status = 'done' } | ConvertTo-Json)
Invoke-RestMethod -Uri 'http://127.0.0.1:4317/today'   # GET
```

An error answer makes `Invoke-RestMethod` throw; the JSON error body is in
`$_.ErrorDetails.Message`.

### The errors every child shares

Errors are always `{"error":{"code","message","hint"}}`. **Show the `hint` to the user.**

| Code (HTTP) | What to do |
|---|---|
| connection refused | Ask the user to run `npm start`. |
| `INVALID_INPUT` (400) | `message` names the field. Fix the request; don't retry blindly. |
| `UNKNOWN_TASK` / `UNKNOWN_ITEM` (404) | Use the `hint` (the closest match) or `GET /tasks` to find the right uid. Don't guess repeatedly. |
| `CONFLICT` (409) | Explain it, then act on a valid target instead. |
| `PAUSED` (409) | The plan is frozen → `planner-pause-resume`. |
| `FORBIDDEN_ORIGIN` / `FORBIDDEN_HOST` (403) | Call from the CLI with no `Origin` header, host `127.0.0.1:<port>` or `localhost:<port>`. |
| `NOT_FOUND` (404) | No such route — you guessed an endpoint. Load the child that owns it. |
| `INTERNAL` (500) | Report it with the request; check the API console output. |
| `TASK_FILE_ERRORS` (422) | Show `details` (`file:line: message`), fix the Markdown through the API. |
| `CALENDAR_NOT_AUTHORIZED` (503) / `CALENDAR_ERROR` (502) | **The local change succeeded.** → `planner-calendar-sync`. |

## Answering

The full read/write contract is `docs/API.md`; the Markdown write-back spec is `docs/PLAN.md`, P9.
After any change, confirm what actually changed from the response — the new end of the day, what is
next, the dates that regenerated, the diff that was written.
