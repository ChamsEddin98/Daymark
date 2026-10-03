---
name: planner-read
description: Read the owner's study plan from the local planner service at http://127.0.0.1:4317 — what's on now and next, today's or any week's plan, a task's status, remaining minutes and links, progress per track, which plan files and tasks exist, and which desktop notifications fired. Use for any question about the study plan that changes nothing — "what's next", "what am I doing now", "what's my plan today/this week", "how far along is BCG", "when does applying start", "how much of X is left", "what tasks are in the Salesforce plan".
---

# Planner · reads

Every read of the schedule goes through the planner's HTTP API. **Never read `resources/*.md` or
`.data/planner.db` to answer a question** — the Markdown holds no status, and the plan you would be
describing is the one in SQLite.

## Calling the API

Base URL `http://127.0.0.1:4317` by default. Loopback only, no auth, JSON answers. Times are
ISO-8601 with the local offset; dates are `YYYY-MM-DD` in the planner's zone. Parse times as
instants (`Date.parse`), never by string comparison — after a resume they carry a fractional second.

**Finding the port.** It is `PLANNER_API_PORT`, default 4317:

1. `.data/runtime.json` in the repo, written at every `npm start` / `npm run dev`:
   `{ "apiUrl": "http://127.0.0.1:4417", "webUrl": …, "apiPort", "webPort", "startedAt" }`. It is the
   *last* start, so confirm with `GET <apiUrl>/health`.
2. `PLANNER_API_PORT` in the environment, or in the repo's `.env` (the environment wins).
3. The `[preflight] API: http://127.0.0.1:<port>` line `npm start` prints.
4. The default, 4317. 5. Otherwise, ask the user.

**Always start with `GET /health`.** Connection refused (curl exit 7) on every candidate port means
the service is down: ask the user to run `npm start` from the repo root. Don't fall back to reading
files. Don't set a short `-m`/`--max-time`.

**Use the Bash tool with `curl -s`**, on every OS including Windows (Git Bash). From Windows
PowerShell 5.1, `curl.exe` strips the inner quotes of a JSON body, so use `Invoke-RestMethod`
instead (`Invoke-RestMethod -Uri 'http://127.0.0.1:4317/today'`). Reads need no body, so the trap
only bites when you follow a read with a write.

**Identifiers.** Task uid `track/id` (`bcg/A1`, `lessons/DAILY`), URL-encoded as `bcg%2FA1`. Item
key `YYYY-MM-DD|<uid>|<part>` (`2026-09-28|bcg/A6|1`); rests are `YYYY-MM-DD|rest|<n>`. Tracks:
`bcg` (prep, priority 1), `salesforce` (2), `anthropic` (3), `lessons`, `portfolio`, `apply`.

## Endpoints

| Endpoint | When to call it | Returns |
|---|---|---|
| `GET /health` | First call, every time. | `{ ok, version, now, timeZone, tasksLoaded, taskFileErrors, anchor, horizon: { days, end }, clock, paused: { since, elapsedSec }\|null, calendar: { authorized, lastSyncAt, lastError, pending } }` |
| `GET /today` | "What's next", "what am I doing now", "what's today". | `{ date, now, day: PlanDay & { checked }, current, next, currentTask, nextTask, progress: { done, total, taskMinDone, taskMinTotal, checkedMin }, upcoming: { date, firstTitle }\|null, paused }` |
| `GET /plan?from=YYYY-MM-DD&days=7` | A week or a longer view; "when does applying start" (`days=60`). `days` is 1–120. | `{ days: PlanDay[] }` |
| `GET /tasks?track=&status=&type=` | Find a uid, list what is pending or skipped. Every filter optional. | `{ tasks: (Task & { status, scheduledOn: string[], progress })[] }` |
| `GET /tasks/:uid` | One task in full: fields, links, body, status, how much is left, every item it is scheduled as (history included). | task fields + `status`, `progress: { doneMin, partsDone, remainingMin }`, `scheduledOn`, `items` |
| `GET /tracks` | "How far along is BCG", which prep track is active. | `{ tracks: [{ track, kind, priority, title, total, done, skipped, remainingMin, active }] }` |
| `GET /plans` | Which plan files exist, how many tasks each holds. | `{ plans: [{ track, path, title, kind, priority, tasks, startsAfter, defaultDurationMin }] }` |
| `GET /plans/:track` | One plan file: its front matter, its tasks and its raw Markdown. Use it to quote the file without opening it. | front matter + tasks + raw Markdown |
| `GET /notifications?limit=50&type=` | "Did the notification fire?" `type` is `task_start`, `task_end`, `rest_start`, `rest_end` or `resume`. | `[{ at, type, itemKey, title }]` (a bare array) |
| `GET /events` | The web UI's SSE stream (`plan`, `status`, `sync`, `notification`, 15 s heartbeat). **Don't call it from the CLI — it never ends.** | SSE |

Examples:

```sh
curl -s http://127.0.0.1:4317/health
curl -s http://127.0.0.1:4317/today
curl -s "http://127.0.0.1:4317/plan?from=2026-10-01&days=7"
curl -s "http://127.0.0.1:4317/tasks?track=bcg&status=pending"
curl -s http://127.0.0.1:4317/tasks/bcg%2FA1
curl -s http://127.0.0.1:4317/tracks
curl -s http://127.0.0.1:4317/plans
```

## Reading the answers correctly

- **"What's next" comes from `currentTask` and `nextTask`**, never from `current`/`next`: those can
  be a rest or an item that is already done or skipped. `currentTask` is the **pending** task item in
  progress (`null` when idle, on a rest, or when the current item is checked); `nextTask` is the
  first pending task item starting after now. Add `progress` to the answer.
- **The day's shape is fixed.** The day starts at 08:00; tasks have a 10-minute rest between them;
  after 4 h of task time there is a 1-hour rest, then a second 4 h block (480 task minutes at most).
  The order is prep → lessons → portfolio → apply. Explain times in those terms and never promise a
  different shape.
- **`day.checked`.** A done or skipped item that lost its timeline slot is in `checked`, not in
  `items`, and shows its **original** slot (`plannedStart`/`plannedEnd`); `lastStart`/`lastEnd` is
  the last slot it had. Don't report a checked item as "done at 06:00". A pending item is never in
  `checked`. `progress` counts the timeline's task items *and* the day's checked items; `done` counts
  done **or** skipped.
- **How much is left is stored, not guessed.** `GET /tasks/:uid` →
  `progress: { doneMin, partsDone, remainingMin }`, `remainingMin = durationMin - doneMin`. A one-off
  task is scheduled exactly while its status is pending and `remainingMin > 0`. Marking one part of a
  split task done credits only that part's minutes. Use `remainingMin` for "how much of X is left".
  For a daily task, `progress.sessionsHeld` counts the sessions held and `remainingMin` is the session
  length.
- **Part labels follow the timeline**, numbered 1..n across the whole plan, so they can move between
  dates. Item keys never move.
- **`scheduledOn` only covers the stored horizon** (7 days by default; `horizon` in `/health`). For
  "when does X start", use `GET /plan?from=<today>&days=60` and find the first item — dates past the
  horizon are a projection, computed rather than stored.
- **Paused.** `paused` in `/health` and `/today` is `{ since, elapsedSec }` or `null`; `elapsedSec`
  grows while the pause runs. While paused, `/today` answers "where am I" from the **pause instant**:
  `current`, `next`, `currentTask` and `nextTask` come from `paused.since`, while `now`, `date` and
  the timeline stay live. Say the plan is paused rather than reading the times as if it were running.
  A pause left running over 24 h freezes nothing.
- **Days off** read as empty dates. A days shift leaves them empty on purpose, and `/today` can show
  no task items while `upcoming.date` is later. Don't describe that as a bug, and don't regenerate to
  "fix" it without asking (see `study-planner:planner-schedule`).
- `GET /tracks`: a daily task counts once, with today's status; `remainingMin` sums what is left;
  `active` means the track has a task item today.
- An unknown `track` or `type` on `GET /tasks` is `400 INVALID_INPUT`, and the hint names the closest
  one.

## Errors

Always `{"error":{"code","message","hint"}}` — show the `hint`.

| Code (HTTP) | Meaning | What to do |
|---|---|---|
| connection refused | The service is down. | Ask the user to run `npm start`. |
| `INVALID_INPUT` (400) | A query field is wrong (`days` out of 1–120, unknown `track`/`type`). | Fix it; the hint names the closest value. |
| `UNKNOWN_TASK` (404) | No such uid. | Use the hint, or `GET /tasks` to list them. |
| `UNKNOWN_ITEM` (404) | No such item key. The hint never names another task: it says the task is not scheduled on that date and where it is, or that the date is past the stored plan, or that the task is not in the horizon at all. | Follow the hint. |
| `FORBIDDEN_ORIGIN` / `FORBIDDEN_HOST` (403) | The request carried a browser `Origin`, or a `Host` other than `127.0.0.1:<port>`/`localhost:<port>`. | Call from the CLI on 127.0.0.1. |
| `NOT_FOUND` (404) | No such route. | Check the table above. |
| `INTERNAL` (500) | Unexpected failure. | Report it with the request and the API console output. |

`/health` and `GET /sync/status` never fail: if the Google client cannot even be constructed,
`calendar.authorized` is `false` and the reason is logged.

## Where to go next

- Mark something done or skipped, shift, regenerate, reload → `study-planner:planner-schedule`
- Add / change / remove a task or a plan file → `study-planner:planner-create`,
  `study-planner:planner-update`, `study-planner:planner-delete`
- Pause / resume → `study-planner:planner-pause-resume`
- Calendar state (`GET /sync/status`, `GET /calendar/events`, `POST /sync`) →
  `study-planner:planner-calendar-sync`
