---
name: planner-schedule
description: Change the state of the owner's study schedule through the local planner service at http://127.0.0.1:4317 without touching the Markdown — mark an item or a task done, skipped or pending (undo), shift the plan by minutes, hours or days, preview a shift, regenerate from a date to pull the rest of today earlier, and reload the task files after they were edited. Use for "I finished X", "mark X done", "I already know X, skip it", "undo that", "push everything an hour", "I'm running 20 minutes late", "move it all to tomorrow", "pull the rest of today earlier", "I edited a task file".
---

# Planner · schedule operations

These are the **SQLite-side** changes: status, progress, days off and the plan layout. They write
**no** Markdown, and that is the dividing line (docs/PLAN.md, P9):

> **If a change would survive `POST /reload`, it belongs in the Markdown. If `POST /reload` would
> wipe it, it belongs in SQLite.**

Done, skipped, progress, days off and the pause are SQLite — this skill. Title, duration, type,
links, `repeat`, order and front matter are Markdown, and they are **only** ever changed through the
write-back API: load `daymark:planner-create`, `daymark:planner-update` or
`daymark:planner-delete`. **Never hand-edit a `resources/*.md` file to change a task, and
never call Google Calendar directly** — the service rewrites the calendar after every change here on
its own (debounced by 2 s).

## Calling the API

Base URL `http://127.0.0.1:4317` by default. Loopback only, no auth, JSON. Send
`content-type: application/json` with every body.

**Finding the port.** It is `PLANNER_API_PORT`, default 4317:

1. `.data/runtime.json` in the repo, written at every `npm start` / `npm run dev`:
   `{ "apiUrl": "http://127.0.0.1:4417", … }` — the *last* start, so confirm with `GET <apiUrl>/health`.
2. `PLANNER_API_PORT` in the environment or the repo's `.env` (the environment wins).
3. The `[preflight] API: http://127.0.0.1:<port>` line `npm start` prints.
4. The default, 4317. 5. Otherwise, ask the user.

**Always start with `GET /health`**: it carries `paused`, `tasksLoaded` and `taskFileErrors`.
Connection refused (curl exit 7) on every candidate port means the service is down — ask the user to
run `npm start`. Don't fall back to editing files. Don't set a short `-m`/`--max-time`.

**Use the Bash tool with `curl -s`**, on every OS including Windows (Git Bash). Do **not** pass a
JSON body to `curl.exe` from Windows PowerShell 5.1: it strips the inner quotes, so
`'{"status":"done"}'` arrives as `{status:done}` and fails with `INVALID_INPUT`. PowerShell
fallback:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4317/tasks/bcg%2FA1/status' -ContentType 'application/json' -Body (@{ status = 'done' } | ConvertTo-Json)
```

An error answer makes `Invoke-RestMethod` throw; the JSON body is in `$_.ErrorDetails.Message`.

**Identifiers.** Task uid `track/id` (`bcg/A1`, `lessons/DAILY`), URL-encoded as `bcg%2FA1`. Item key
`YYYY-MM-DD|<uid>|<part>` (`2026-09-28|bcg/A6|1`), URL-encoded as `2026-09-28%7Cbcg%2FA6%7C1`; rests
are `YYYY-MM-DD|rest|<n>` and have no status. Tracks: `bcg` (prep, priority 1), `salesforce` (2),
`anthropic` (3), `lessons`, `portfolio`, `apply`.

## Endpoints

| Endpoint | Body | When to call it | Returns |
|---|---|---|---|
| `POST /items/:key/status` | `{ "status": "done"\|"pending"\|"skipped" }` | Check off, skip or undo **one scheduled occurrence** — the current item, one part of a split task. | `{ item, regenerated }`, or `{ item, regenerated, replanned: true }` for an undo that re-plans |
| `POST /tasks/:uid/status` | `{ "status", "date"? }` | The same addressed by task uid: "I finished A1", retiring a technique after a skip-test. `date` is required for a daily task (lessons, portfolio, apply); for a one-off task it may be omitted. | `{ task, items, regenerated }` |
| `POST /plan/shift/preview` | `{ "amount": >0, "unit": "minutes"\|"hours"\|"days" }` | Show the new end of the day **before** shifting. Saves nothing. | `{ moved, carried, dropped, regenerated, endOfDay, day }` |
| `POST /plan/shift` | same body | "I'm running 20 minutes late", "push everything an hour", "move the whole plan to tomorrow". | the same, saved |
| `POST /plan/regenerate` | `{ "from"? : "YYYY-MM-DD" }` | Rebuild from a date (default tomorrow). `from` = today rebuilds the rest of today, which is how you pull work earlier after skips. **The only call that clears a day off.** | `{ regenerated: string[], clearedDaysOff: string[] }` |
| `POST /reload` | — | The user hand-edited `resources/*.md` (or a file changed outside the API). Re-reads `resources/**/*.md`, then regenerates the future days. | `{ tasks, files, skipped, errors: [], regenerated }`, or `422 TASK_FILE_ERRORS` |

`status` is `"done"`, `"pending"` or `"skipped"`. `unit` is `"minutes"`, `"hours"` or `"days"`.
Every mutation also publishes an SSE event and queues a calendar sync, debounced by 2 s.

```sh
# check off the current task
curl -s http://127.0.0.1:4317/today            # take currentTask.key, never current.key
curl -s -X POST http://127.0.0.1:4317/items/2026-09-28%7Cbcg%2FA6%7C1/status \
  -H "content-type: application/json" -d '{"status":"done"}'

# by uid, and for a daily task
curl -s -X POST http://127.0.0.1:4317/tasks/bcg%2FA1/status \
  -H "content-type: application/json" -d '{"status":"done"}'
curl -s -X POST http://127.0.0.1:4317/tasks/lessons%2FDAILY/status \
  -H "content-type: application/json" -d '{"status":"done","date":"2026-09-28"}'

# shift, preview first
curl -s -X POST http://127.0.0.1:4317/plan/shift/preview \
  -H "content-type: application/json" -d '{"amount":1,"unit":"hours"}'
curl -s -X POST http://127.0.0.1:4317/plan/shift \
  -H "content-type: application/json" -d '{"amount":20,"unit":"minutes"}'

# pull the rest of today earlier, and reload after a hand edit
curl -s -X POST http://127.0.0.1:4317/plan/regenerate \
  -H "content-type: application/json" -d '{"from":"2026-09-28"}'
curl -s -X POST http://127.0.0.1:4317/reload
```

## How to choose, and what to tell the user

### Marking work done, skipped or undone

- **Resolve the track first.** Task ids repeat across tracks (`A1` exists in `bcg` *and*
  `salesforce`; `anthropic` uses `T1`–`T8`). Use the prep track that is `active` in `GET /tracks`, or
  the one scheduled today in `GET /today`. Ask if it is still ambiguous — don't guess.
- **"Check off the current task"**: `GET /today`, take `currentTask.key` (never `current.key`, which
  can be a rest or an already-checked item), then `POST /items/<key>/status`.
- A **rest** has no status: `POST` on a rest key is `409 CONFLICT`.
- **A task becomes done only when `doneMin >= durationMin`**, never because an item carried the last
  part label. Marking the last part of a split task done leaves the earlier parts still to do and
  still scheduled.
- `POST /tasks/:uid/status`: `done` sets `doneMin = durationMin`; `skipped` sets the status and
  changes no minutes; `pending` clears the progress and re-plans the task.
- **Undo** is `{"status":"pending"}` on the same key. On an item still on the timeline it flips the
  status and gives the minutes back. On a `checked` item, on a date before today, or inside a day
  off, it **removes** that item instead (a past item's status is never rewritten) and re-plans the
  task — the answer carries `replanned: true`, and `item` is the task's new pending item, or `null`
  if it no longer fits the horizon. An undo re-plans **from today**, whatever date the undone item sat
  on, because the minutes it frees may belong to a higher-priority prep track than what is still
  scheduled for the rest of the day. So the rest of today can be re-timed by an undo — today's past
  and in-progress items never move.
- **Checking or skipping never reshuffles today on its own.** A skipped slot stays empty time; future
  days are regenerated. To reclaim today's freed time, call `POST /plan/regenerate {"from":"<today>"}`
  — and read "Days off" below first.
- Status changes **keep working while the plan is paused**, and leave the pause alone.

### Shifting

- **Minutes/hours** move today's not-yet-started items and keep the rests. Items pushed past midnight
  go to the front of tomorrow; **pending daily items** pushed past midnight are dropped (tomorrow has
  its own) and counted in `dropped`. `carried` counts the tasks handed to the next day's prep slot.
- **Days** rebuilds from `today + N` at 08:00 and leaves **every date it emptied** off, up to the day
  the work landed on. So `+1 day` then `+1 day` equals `+2 days`.
- Amounts are **positive whole numbers**: minutes ≤ 1440, hours ≤ 24, days ≤ 365. For half an hour
  use `{"amount":30,"unit":"minutes"}`. There is **no negative shift** — to pull work earlier, use
  regenerate-from-today.
- **Validation order** (the first failing check wins): missing `amount`/`unit` → 400; a `unit` other
  than minutes/hours/days → 400; a non-number `amount` → 400; an `amount` over its maximum → 400;
  **nothing left to shift → 409 `CONFLICT`** (for minutes/hours, nothing of today starts at or after
  now; for days, nothing in the plan does); only then a non-whole positive `amount` → 400. So late in
  the day `{"amount":1.5,"unit":"hours"}` answers **409, not 400**: explain that today is finished
  rather than silently "fixing" the amount.
- A non-finite `amount` gets 400 with the fixed hint
  `Send a whole number, e.g. { "amount": 30, "unit": "minutes" }.`
- `occurrences` counts **sessions, not dates**, so neither a shift nor an ignored day can lose a
  lesson: the total stays 28. A session is spent only when it is **acted on** — done, or skipped.
- Report `endOfDay` in plain words after a shift.

### Regenerating

- `from` must be between today and the plan's last date. `from` = **today** rebuilds the rest of
  today from now: past and in-progress items keep their times, a checked item still in progress ends
  now, checked items that had not started move to `checked`, and the remaining work is laid out from
  the end of the task in progress plus its rest (or from now if nothing is in progress), never before
  08:00 and never before the resume point of an earlier minute/hour shift.
- The gap between the last kept task and the new work is always rest, however late the call:
  its title says it was stretched (`Rest (extended)` / `Long rest (extended)`), so hours of idle time
  never read as the 10-minute rest.
- The day's order never goes backwards: once a fixed slot has run, only slots at or after it may
  follow, so prep is never added after the lessons or portfolio block. Leftover capacity stays unused
  — the rule is "≤ 480", not "= 480".
- **Days off.** Only `POST /plan/regenerate` clears them, and `clearedDaysOff` says which. Status
  changes, undo, reload and the midnight rollover re-plan without ever clearing one, so undoing a
  skip cannot resurrect a day the owner moved away from. **Before regenerating from today, call
  `GET /today`**: if today has no task items because of a days shift and `upcoming.date` is later,
  **don't** regenerate from today — use `{"from":"<upcoming.date>"}`, or ask whether the user wants
  today back. `POST /plan/regenerate {"from":"<today>"}` right after "move everything to tomorrow"
  would put the work back on today.
- Regenerate is refused with `409 PAUSED` while the plan is paused, as are both shift calls.

### Reloading

- `POST /reload` is for files that changed **outside** the API — the user edited `bcg.md` by hand, or
  pulled from git. Every API write-back (create / update / delete of a task or plan) already reloads
  and regenerates in the same call, so you never follow one with `/reload`.
- On `422 TASK_FILE_ERRORS` the previous tasks stay loaded; show `details` as `file:line: message`.
  Fix the file through `daymark:planner-update` (or `planner-create` / `planner-delete`) rather
  than by hand, so the fix is validated before it reaches disk.
- Reload regenerates **only future days**. To fit newly added work into **today**, follow it with
  `POST /plan/regenerate {"from":"<today>"}`.
- **History is immutable, and unfinished work carries itself forward**: every pending item before
  today — a task, a daily slot or a rest — never happened, so it is deleted and the work comes back at
  the front of the next day's queue. A one-off task's remaining minutes are re-placed with fresh part
  numbers; a daily slot's session returns to the pool, because a date going by never held it. This is
  also what the midnight rollover does.

  **So a day the owner ignored costs the plan a day, not the owner the work**, and the horizon is a
  rolling window rather than a programme end date — the plan simply reaches further out. Never tell
  them unfinished work was lost or that they have "fallen behind" by some amount of work; what they
  have lost is time, and the plan already absorbed it. If they want work gone rather than deferred,
  that is what `skipped` is for, and it is the only thing that removes it.

## Unfinished work: what already happens on its own

Asked "what happens to the tasks I didn't finish?", the answer is **nothing is lost** — and no
endpoint needs calling to make that true. Say so plainly rather than offering to rescue the work.

**During the day.** A task whose slot goes by while still pending is *missed*, and the `onMissed`
setting decides what follows: `reflow` (the default) takes the work off the past and lays the rest of
the day out again from now; `notify` touches nothing and says so. Both notify. The setting itself
lives in `daymark:planner-settings` — route there to read or change it.

**At midnight.** Whatever is still pending carries to the next day, at the **front** of the queue:

- Neglect costs **days, not work**. Four ignored days cost 0 minutes of work owed; the plan just
  reaches further out. The horizon is a rolling window, so there is no programme end to overrun.
- A capped daily series (`occurrences`) spends a session only when it is **acted on**. A day that
  merely went by consumes nothing, so the series finishes later instead of losing sessions.
- The order holds: the task that led the abandoned day leads the next one.

**So do not** "catch up" by shifting, regenerating or re-creating anything. `POST /plan/regenerate`
is not a recovery tool, and re-creating a task that already carried forward duplicates it.

**Skip is the deliberate exception.** `skipped` is the only way to spend a task without doing it: it
does not return the next day and it does spend a session of a capped series. When the user means
"I'm behind", that is carry-forward and needs nothing. When they mean "this one does not matter",
that is a skip. If which one they mean is unclear, **ask** — the two are not reversible in the same
way.

## Errors

Always `{"error":{"code","message","hint"}}` — show the `hint`.

| Code (HTTP) | Meaning | What to do |
|---|---|---|
| connection refused | The service is down. | Ask the user to run `npm start`. |
| `INVALID_INPUT` (400) | An unknown status, a bad `unit`/`amount`, a `from` outside the allowed range. | Fix the request; convert fractional hours to minutes. |
| `UNKNOWN_TASK` (404) | No such uid. | Use the hint, or `GET /tasks`. Don't guess repeatedly. |
| `UNKNOWN_ITEM` (404) | No such item key. The hint says whether the task exists but isn't scheduled on that date, whether the date is past the stored plan, or that you should use `POST /tasks/:uid/status` instead. | Follow the hint. If a key's part number changed but the task has exactly one item on that date, the key still resolves. |
| `CONFLICT` (409) | A status change on a rest, a `date` the task has no item on (the hint lists the dates it is scheduled on), or nothing left to shift. | Explain, then act on a valid target. |
| `PAUSED` (409) | The plan is paused, so it refuses to move. `details.paused` says since when. | `POST /plan/resume` first → `daymark:planner-pause-resume`. Status changes still work. |
| `TASK_FILE_ERRORS` (422) | `/reload` found invalid files; the old tasks are kept. | Show `details`, fix through the write-back API, reload again. |
| `FORBIDDEN_ORIGIN` / `FORBIDDEN_HOST` (403) | A browser `Origin`, or a `Host` other than `127.0.0.1:<port>`/`localhost:<port>`. | Call from the CLI on 127.0.0.1. |
| `CALENDAR_NOT_AUTHORIZED` (503) / `CALENDAR_ERROR` (502) | Only `POST /sync` raises these. **The local change did succeed.** | → `daymark:planner-calendar-sync`. |
| `INTERNAL` (500) | Unexpected failure. | Report it with the request. |

After any change, confirm what happened from the response: what is next, the new end of the day, the
dates in `regenerated`, the dates in `clearedDaysOff`.

## Where to go next

- Reads and how to interpret them → `daymark:planner-read`
- Add / change / remove a task or a plan **file** → `daymark:planner-create`,
  `daymark:planner-update`, `daymark:planner-delete`
- Pause / resume → `daymark:planner-pause-resume`
- Calendar → `daymark:planner-calendar-sync`
