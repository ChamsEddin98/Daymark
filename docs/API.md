# Planner HTTP API (contract v1)

Base URL `http://127.0.0.1:4317`. The API binds to loopback only and has no auth. All bodies
are JSON. Times are ISO-8601 with the local offset. Dates are `YYYY-MM-DD` in the planner's
time zone. Item shapes are the `PlanItem` and `PlanDay` types in
`packages/core/src/schedule/types.ts`.

A time carries a fractional second (`2026-09-28T11:00:45.317+01:00`) only when it has one, which
happens after a resume: a pause is applied to the millisecond (see "Pause and resume"). Every other
time is on a whole minute and keeps the plain `…:00+01:00` form. Parse times as instants
(`Date.parse`), never by string comparison.

Every error looks like this:

```json
{ "error": { "code": "UNKNOWN_TASK", "message": "No task bcg/A99", "hint": "Did you mean bcg/A9?" } }
```

| HTTP | code | When |
|---|---|---|
| 400 | `INVALID_INPUT` | Body or query failed validation. `message` names the field. |
| 404 | `UNKNOWN_TASK` / `UNKNOWN_ITEM` | The uid or key does not exist. `hint` gives the closest match. |
| 403 | `FORBIDDEN_ORIGIN` / `FORBIDDEN_HOST` | A browser request from another site, or a Host other than 127.0.0.1/localhost. |
| 409 | `CONFLICT` | For example, shifting an item that has already ended, or a status change on a rest item. Also `pause` while paused and `resume` while not paused; `details.paused` carries the current state. |
| 409 | `PAUSED` | The plan is paused, so it may not be moved. `hint` names `POST /plan/resume` and `details.paused` is `{ since, elapsedSec }`. |
| 422 | `TASK_FILE_ERRORS` | A reload found invalid task files, or a write-back produced text that will not parse. `details` holds `[{file,line,message}]` and the previous tasks stay loaded. |
| 503 | `CALENDAR_NOT_AUTHORIZED` | Sync was requested before `npm run auth`. Local state is still updated. |
| 502 | `CALENDAR_ERROR` | Google returned an error after retries. Local state is still updated. |

## Read

| Method and path | Returns |
|---|---|
| `GET /health` | `{ ok, version, now, timeZone, tasksLoaded, paused: { since, elapsedSec }\|null, calendar: { authorized, lastSyncAt, lastError, pending } }` |
| `GET /today` | `{ date, now, day: PlanDay & { checked }, current: PlanItem\|null, next: PlanItem\|null, currentTask: PlanItem\|null, nextTask: PlanItem\|null, progress: { done, total, taskMinDone, taskMinTotal, checkedMin }, upcoming: { date, firstTitle }\|null, paused: { since, elapsedSec }\|null }` |
| `GET /plan?from=YYYY-MM-DD&days=7` | `{ days: PlanDay[] }`. `days` can be 1 to 120. |
| `GET /tasks?track=bcg&status=pending&type=coding` | `{ tasks: (Task & { status, scheduledOn: string[], progress })[] }`. Every filter is optional. |
| `GET /tasks/:uid` | A single task with its status and the items it is scheduled as. The uid is URL-encoded, e.g. `bcg%2FA1`. |
| `GET /tracks` | `{ tracks: [{ track, kind, priority, title, total, done, skipped, remainingMin, active }] }` |
| `GET /plans` | `{ plans: [{ track, path, title, kind, priority, tasks, startsAfter, defaultDurationMin }] }`. One row per task file. |
| `GET /plans/:track` | One plan: its front matter, its `tasks` and its raw `markdown`. |
| `GET /backups?track=` | `{ backups: [{ name, track, at, bytes, path }] }`, newest first. The snapshots the write-back takes. |
| `GET /settings` | The owner's active hours and what they actually grant: `{ activeHours: { dayStart, dayEnd, dailyTaskMin }, defaults, timeZone, effective: { dailyTaskMin, boundBy, lastEnd } }` |
| `GET /calendar/events?from&to` | The events read back from Google: `[{ eventId, plannerKey, summary, start, end, sourceUrl }]` |
| `GET /sync/status` | `{ authorized, calendarId, lastSyncAt, lastResult: { inserted, patched, deleted, unchanged }, pending, lastError }` |
| `GET /notifications?limit=50` | The recent notifications the daemon fired: `[{ at, type, itemKey, title }]`. `type` is one of `task_start`, `task_end`, `rest_start`, `rest_end`, or `resume` (a one-off "Now: …" toast when the daemon starts mid-item). |
| `GET /events` | A Server-Sent Events stream. Event names are `plan` (with `{ dates: [...] }`), `status`, `sync` and `notification`. A heartbeat is sent every 15 s. |

## Write

| Method and path | Body | Effect |
|---|---|---|
| `POST /items/:key/status` | `{ status: "done"\|"pending"\|"skipped" }` | Sets the status of the item, and of the task it stands for once every minute of it is done. A daily task only changes for that date. Today is never reshuffled, and future days are regenerated. Returns `{ item: PlanItem, regenerated: string[] }`. |
| `POST /tasks/:uid/status` | `{ status, date? }` | The same, addressed by task uid. `date` is required for daily tasks. Use this to mark skip-test techniques as skipped. |
| `POST /plan/shift` | `{ amount: number>0, unit: "minutes"\|"hours"\|"days" }` | Applies the PLAN.md shift rules from now. Returns `{ moved, carried, dropped, regenerated, endOfDay, day }`. |
| `POST /plan/shift/preview` | same body | The same calculation without saving it, so the UI can show the new end of the day. |
| `POST /plan/pause` | — | Freezes the plan at this instant, recorded to the millisecond. Nothing moves. Returns `{ paused: { since } }`. |
| `POST /plan/resume` | — | Measures `now - since` in milliseconds and shifts the plan forward by exactly that, then clears the pause. Returns `{ pausedSec, moved, endOfDay, day }`. |
| `POST /plan/regenerate` | `{ from?: date }` | Rebuilds the plan from the given date (default: tomorrow) from task files, status and progress. `from` = today rebuilds the rest of today too. The only call that may clear days off; it reports them in `clearedDaysOff`. |
| `PATCH /settings` | any subset of `{ dayStart, dayEnd, dailyTaskMin }` | The owner's active hours: when the day may start, when it must stop, and how much task time it holds. Validates, stores, rebuilds **today and the future**, queues a sync. Takes `dryRun`. Returns `{ activeHours, regenerated, changed, sync }`. |
| `POST /reload` | — | Re-reads `resources/**/*.md`, then regenerates the future days. Returns `{ tasks, errors: [] }`, or a 422. |
| `POST /sync` | `{ from?, to? }` | Syncs the window now (default: today up to the end of the horizon). Returns the sync result. Every mutation above also queues a sync on its own, debounced by 2 s. |

Every mutation also publishes an SSE event.

## Write-back (the Markdown is rewritten too)

These change `resources/*.md` **and** the schedule in one call, so the file never falls behind the
plan it generated. The dividing line (docs/PLAN.md, P9):

> **If a change would survive `POST /reload`, it belongs in the Markdown. If `POST /reload` would wipe
> it, it belongs in SQLite.** Title, duration, type, links, `repeat`, `occurrences`, order and front
> matter are Markdown and live here. Done, skipped, progress, days off and the pause are SQLite and
> live in the table above. Nothing is written to both.

| Method and path | Body / query | Effect |
|---|---|---|
| `POST /plans` | `{ track, title, kind, priority?, defaultDuration?, startsAfter?, intro? }` | Creates `resources/<track>.md` with front matter and no tasks. |
| `PATCH /plans/:track` | any subset of `{ title, kind, priority, defaultDuration, startsAfter }` | Rewrites only those front-matter keys. `null` removes an optional one. |
| `DELETE /plans/:track` | **`?confirm=<track>`** | Deletes the file and every task, status, progress and calendar event it owns. |
| `POST /tasks` | `{ track, id?, title, duration, type, links?, repeat?, occurrences?, body?, section?, after? }` | Inserts a task. `after` is a uid to place it behind; the default is the end of its section. Without `id`, an unused one is derived and reported in `warnings`. |
| `PATCH /tasks/:uid` | any subset of `{ title, duration, type, links, repeat, occurrences, body, section }` | Rewrites only what changed, inside the task's own heading / block / body span. |
| `DELETE /tasks/:uid` | — | Removes the heading, the block and the body, and the task's stored state. |
| `POST /backups/:name/restore` | — | Restores one snapshot (the current file is snapshotted first), then reloads and regenerates. |

Every one accepts `dryRun: true` in the body **or** `?dryRun=true`, and every one answers with the
same envelope:

```json
{ "task|plan": {}, "diff": "", "file": "resources/bcg.md", "regenerated": ["2026-09-29"],
  "backup": ".data/taskfile-backups/bcg.2026-10-01T09-14-22-317Z.md", "sync": "queued" }
```

Every mutation also publishes one SSE `plan` event and queues one calendar sync.

## Response details (as implemented in `apps/api`, v1)

These pin down shapes the tables above leave open. Extra fields may be added; none are removed.

- **Errors.** Every error has `message` and `hint`. `details` is present for `TASK_FILE_ERRORS`
  (`[{file,line,message}]`) and `CALENDAR_ERROR` (Google status/reason, or the partial sync result
  when single event writes failed). An unknown route is `404 NOT_FOUND`; an unexpected failure is `500 INTERNAL`.
- **Paths.** `:uid` and `:key` should be URL-encoded (`bcg%2FA1`, `2026-09-28%7Cbcg%2FA1%7C1`), but
  the unencoded forms (`/tasks/bcg/A1`) also work. `:track` and `:name` are single segments.
- `GET /health` also returns `activeHours`, `taskFileErrors` (count), `anchor`, `horizon: { days, end }`, `clock`
  (`system`/`fixed`/`compressed`), `calendar.pending` and `paused` (see "Pause and resume").
  **`/health` never fails**: if the Google client cannot even be constructed (no token, a corrupt or
  unreadable one), `calendar.authorized` is `false` and the reason is logged. `GET /sync/status`
  behaves the same. The underlying error still surfaces from `POST /sync`.
- **Security.** A request with an `Origin` header that is not the web UI's (`http://127.0.0.1:3417`,
  `http://localhost:3417`, plus `PLANNER_WEB_ORIGINS`) gets `403 FORBIDDEN_ORIGIN`. A `Host` header other than
  `127.0.0.1:<port>` or `localhost:<port>` gets `403 FORBIDDEN_HOST` (DNS rebinding). curl and scripts send no
  Origin, so they are unaffected.
- **Timeline and `checked` list.** Every `PlanDay` returned by `/today` and `/plan` has
  `items` and `checked: PlanItem[]`:
  - `items` is the timeline only. Every item on it starts on its own date, between 08:00 and 24:00.
  - A done or skipped item that loses its timeline slot moves to `checked`. It loses its slot when its
    task is no longer planned on that date, when a minute/hour shift pushes it past midnight, or when
    `regenerate {from: today}` finds it had not started yet.
  - A checked item is never deleted. It stays addressable by its key and no longer uses any budget.
  - A pending item is never in `checked`.
  - An item in `checked` shows its **original** slot: `start`/`end` equal the **optional** fields
    `plannedStart`/`plannedEnd`. These are captured once, at the item's first status change, and never
    overwritten.
  - It also carries `lastStart`/`lastEnd`, the last slot it had on the timeline.
  - `current`, `next`, `currentTask` and `nextTask` never use `checked`.
- **Undo.** `{ "status": "pending" }` on an item that is still on the timeline flips its status and gives the
  task's minutes back. On a `checked` item, on any item dated before today, or on one dated inside a day off
  (a date the owner pushed past holds no work to do), it removes the item (a past item's status is never
  rewritten) and re-plans the task: the rest of today when the change touches today or
  the past, otherwise from tomorrow - the whole future is rebuilt, because the task's remaining minutes grew.
  The answer is `{ item, regenerated, replanned: true }`,
  where `item` is the task's new pending timeline item (on that date if there was room, otherwise the next one),
  or `null` if it no longer fits the horizon.
- **Calendar and checked items.** A checked item is never passed to reconcile as a new placement. If it already
  has an event, that event stays at `lastStart`/`lastEnd`: it is not patched and not deleted. If it has
  no event, none is created.
- **Rest keys** are `YYYY-MM-DD|rest|n`, numbered from 1 in chronological order on each date. The same
  timeline therefore always has the same keys.
- **Task progress** is durable, first-class state (`task_progress`), never inferred from the shape of the plan
  (docs/PLAN.md, P7). `GET /tasks` and `GET /tasks/:uid` return it:
  `progress: { doneMin, partsDone, remainingMin }`, where `doneMin` is the summed length of the parts marked
  **done** (skipped parts add nothing), `partsDone` sets the part numbering of what follows, and
  `remainingMin = durationMin - doneMin`. **A one-off task is scheduled if and only if its status is
  pending and `remainingMin > 0`** - so a task reported pending always has items, and one reported done or
  skipped never takes budget. For a daily task, `progress.sessionsHeld` counts the dates whose session was
  held and `remainingMin` is the session length.
  - `POST /items/:key/status` → `done` adds that item's minutes and one part; `pending` on a done item takes
    them back; `skipped` sets the task's status and changes no minutes. **The task becomes `done` only when
    `doneMin >= durationMin`** - never because the item carried the last part label. Marking the last part of a
    split task done therefore leaves the earlier parts still to do and still scheduled; part labels are
    recomputed from the timeline, so a label never decides stored state.
  - `POST /tasks/:uid/status` → `done` sets `doneMin = durationMin`, `skipped` leaves the minutes alone,
    `pending` clears the progress (`doneMin = 0`, `partsDone = 0`) and re-plans the task.
- **Lesson sessions (`occurrences`)** count **sessions**, never a window of dates (`sessions_held`). A session
  is held on a date that ran (it is in the past, whatever its status) or whose status is done or skipped. A
  daily task with `occurrences: N` is planned until sessions held plus sessions planned equal `N`, so a shift
  can neither lose one nor add one, and no counter has to be maintained. A session a shift takes off the plan
  is simply not held, and comes back at the end of the plan.
- **History is immutable.** Only done and skipped items stay on a past date. Every pending item before today -
  a task, a daily slot or a rest - never happened: it is deleted, a one-off task's remaining minutes are
  re-placed with fresh part numbers, and a daily slot's session is recorded first, so it is never handed out
  twice (this is the midnight rollover, and it is also what a regeneration does). An undo never writes
  `pending` onto a past item - it removes that item instead.
- **Part labels follow the timeline.** The pieces of a split task are numbered 1..n in the order they are
  planned, across the whole plan (a checked piece included). Marking a later piece done can pull the remainder
  to an earlier date; the labels then move with it, so `(part 2/2)` never sits above `(part 1/2)`. Item keys
  never move.
- **Days off.** A days shift leaves the dates it skipped empty. Every re-plan (a status change, an undo, a
  reload, the rollover) keeps them empty; only `POST /plan/regenerate` may fill them, and its answer names
  the dates it cleared. So `+1 day` then `+1 day` equals `+2 days`.
- **Item key resolution.** If a key's part number changed but the task has exactly one item on that date,
  the key still resolves to it.
- `GET /today`: `current` is the item with `start <= now < end` (any status), and `next` is the first item of today that starts
  after now (a rest counts). Either is `null` when there is none. `currentTask` is the **pending** task item in progress
  (`null` when idle, on a rest, or when the current item is checked), and `nextTask` is the first **pending** task item
  that starts after now. `progress` counts the timeline's task items **and** the day's `checked` items:
  `done` counts items that are done **or skipped**, and `total` counts all of them. `taskMinTotal` is the
  timeline's task minutes plus `checkedMin`, the minutes of the checked items at their original slots.
  The timeline alone never exceeds 480 task minutes.
  `upcoming` is the first later date that has a task item.
- `GET /plan`: dates past the materialized horizon are a projection (computed, not stored).
- `GET /tasks/:uid` returns the task fields, `status`, `progress`, `scheduledOn` (dates from today) and `items`
  (every stored item of the task, history included). For a daily task `status` is today's.
- `GET /tracks`: `total/done/skipped/remainingMin` count the track's tasks (a daily task counts once,
  with today's status). `remainingMin` sums what is left to do: `durationMin - progress.doneMin` for a
  one-off task. `active` means the track has a task item today.
- `GET /tasks`: an unknown `track` or `type` is `400 INVALID_INPUT`, and the hint names the closest one.
- `GET /calendar/events` and `GET /notifications` return bare arrays. `/notifications` also accepts `type`.
- Unknown item key (`404 UNKNOWN_ITEM`). The hint never names another task:
  - If the task exists but has no item on that date, the hint says
    "`<uid>` is not scheduled on `<date>`; it is on `<dates>` (GET /tasks/`<uid>`)".
  - If the date is past the stored plan, the hint says so instead ("`<date>` is past the stored plan, which
    ends on `<end>`; no item exists there yet"), and a date before today says it is in the past.
  - If it has no item at all: "`<uid>` is not in the stored horizon; use POST /tasks/`<uid>`/status".
  - Only a uid that does not exist gets a closest-uid suggestion.
- `POST /tasks/:uid/status` returns `{ task, items, regenerated }`. The status is applied to the
  task's stored items (for a daily task, the items of `date`); `pending` re-plans its checked items (see Undo).
  A `date` the task has no item on is `409 CONFLICT` (daily or one-off). The hint lists the dates it is scheduled on.
  For a one-off task, `date` may simply be omitted.
- `GET /tasks`, `GET /tasks/:uid`: `scheduledOn` lists the timeline dates from today. `items` includes checked items.
- `POST /plan/shift` and `/plan/shift/preview` return `{ moved, carried, dropped, regenerated, endOfDay, day }`.
  `day` is today after the shift. `carried` counts the tasks handed to the next day's prep slot in order:
  the ones under way (a part of them is already placed) and the ones a minute/hour shift pushed past
  midnight. `409 CONFLICT` when nothing of today starts at or after now (minutes/hours), or nothing in the
  plan does (days). A shift by N days leaves off **every date it emptied**, up to the day the work landed on:
  today (which keeps what already started) and the dates before the first regenerated one, which is more than
  N-1 dates when today had nothing left to move. Every later re-plan keeps them empty, and a shift never lands
  work on an existing day off. `amount` is limited to 1440 minutes, 24 hours or
  365 days (`400` otherwise). A non-finite `amount` gets `400` with the fixed hint
  `Send a whole number, e.g. { "amount": 30, "unit": "minutes" }.`. **The request itself is validated first**:
  a unit or an amount that is not a positive whole number within its bound is `400 INVALID_INPUT` whatever the
  plan holds, and `409 CONFLICT` is only ever the answer to a valid shift. `dropped` counts pending daily items that a
  minute/hour shift pushed past midnight. A checked item the shift takes off the timeline goes to `checked`.
  After a minute/hour shift, a later `regenerate {from: today}` never starts new work before the shifted
  start of the first pending task, so the shift is kept.
- **Pause and resume** (docs/PLAN.md, P8). A pause freezes the plan while you step away; the resume
  pushes everything still to come forward by exactly how long you were gone.
  - `POST /plan/pause` records the instant and returns `{ paused: { since } }`. **Nothing on the plan
    moves.** `since` is an ISO instant with millisecond precision.
  - `POST /plan/resume` returns `{ pausedSec, moved, endOfDay, day }`. `pausedSec` is the elapsed time
    in **seconds with a fractional part** (`45.317`). `moved` counts the items whose times changed,
    `endOfDay` is the end of today's last timeline item (`null` when today is empty) and `day` is today
    after the shift, in the same shape as `POST /plan/shift`'s `day`.
  - **Exact, not rounded.** The elapsed time is measured in **milliseconds** and applied as given. A
    45 s pause moves the plan by 45 s, never by a rounded minute; a 3 ms pause moves it by 3 ms, and the
    stored times show it (`11:00:00.003+01:00`). Internally this is the same code path as a minute
    shift, with the delta in milliseconds, so the gap-to-rest rule, midnight overflow, days off,
    dropped daily items and every day invariant behave identically.
  - **Durations and order never change.** The cut point is the **pause** instant, not the resume
    instant: every item whose start is at or after the moment you paused moves, and they all move by
    the same amount, so every duration, the order and every gap between the moved items are
    byte-identical. **Nothing that had not begun when you paused is allowed to run while you are
    away** - a task due to start during the pause moves by the full pause rather than being treated as
    already under way, so you never silently lose minutes of a task you were not there for. Only the
    one item that was **under way at the pause instant** keeps its times: you lose the paused seconds
    from that one task, which is the only way to honour this rule. The widened gap before the next item
    becomes rest time under the existing gap-to-rest rule, so the rest right after it keeps its start
    and ends later instead of moving. Because every moved item lands at `start + elapsed`, no moved
    item ever ends up before the resume instant.
  - **A pause that crosses local midnight** is cut at midnight instead. The midnight rollover still
    runs while paused (the plan for the new day is built as usual), and the cut has to be inside the
    current day, so a pause from 23:30 to 01:30 moves the **whole new day** forward by those two hours:
    nothing on it had begun when you paused. A pause longer than 24 h is refused anyway (see "Limits"),
    so the cut is never more than one midnight away.
  - `GET /health` and `GET /today` carry `paused: { since, elapsedSec } | null`. `elapsedSec` is
    measured when the field is read, so it grows while the pause runs.
  - **`/today` answers "where am I" from the pause instant while paused.** `current`, `next`,
    `currentTask` and `nextTask` are derived from `paused.since`, not from the wall clock, because by
    rule 2 nothing that had not begun by then has begun and everything still to come is about to move
    by the whole pause. Reading them live would claim you are 35 minutes into a task you never
    started. `now`, `paused.elapsedSec`, `date` and the timeline itself stay live. A stale pause
    (> 24 h) freezes nothing, here as everywhere.
  - **The pause is durable.** It lives in the store (`meta.paused_since`), so it survives a restart of
    the API or the daemon, and a resume after a restart still measures from the original instant.
  - **While paused the plan is frozen.** `POST /plan/shift`, `POST /plan/shift/preview` and
    `POST /plan/regenerate` answer `409 PAUSED` with `details: { paused }` and a hint naming
    `POST /plan/resume`. The request itself is still validated first, so a bad `amount`, `unit` or
    `from` is `400 INVALID_INPUT` whatever the pause state is. **Status changes keep working**: `POST
    /items/:key/status` and `POST /tasks/:uid/status`, undo included, still apply and still re-plan the
    later days - ticking something off is not moving the schedule - and they leave the pause alone.
  - **No notifications while paused.** The daemon reads the pause from the store on every scan, so it
    follows a pause and a resume within its normal tick (~1 s; pause and resume bump `plan_rev` like
    any other write). It fires no task or rest boundary for an instant inside the pause and **records
    nothing** for those instants, so the resume does not replay them; after the resume the boundaries
    fire at their new times. A resume raises no toast of its own, with **one exception**: the
    `task_end` of the task that was under way when you paused. That task keeps its times, so if the
    pause outlasted it its end fell inside the pause window and would never fire at all - you would
    never be told that task was over. It is fired once, at the resume instant, coalesced with the rest
    that starts there ("End: … · Rest until …", with the rest's new end). A rest that was already
    announced before the pause and then silently stretched is **not** corrected: its `rest_end` still
    fires at the new time, you asked for the pause yourself, and a toast on every resume would be
    noise.
  - **Google Calendar follows.** A resume queues the usual debounced sync, so the events are rewritten.
    A pause changes nothing, so it queues nothing. Calendar events are written with **whole seconds**
    (floored in `toEvent`, so `plannerHash` covers the floored times too), because Google stores no
    finer, while the plan keeps the exact millisecond. This matters after a resume, when every upcoming
    item sits mid-minute: the times sent are already the times Google will read back, so the next sync
    of an unchanged plan reports `unchanged`, never a patch, and two resumes inside the same second
    write nothing at all. Drift detection compares the two with a 1 s tolerance, so a server that
    normalizes sub-second values differently can never start a patch loop either.
  - **Limits.** `pause` while already paused and `resume` while not paused are `409 CONFLICT`, carrying
    the current state in `details.paused` (`null` for the second). A pause longer than **24 h** resumes
    with `400 INVALID_INPUT` and a hint to shift whole days instead, and **the pause is kept**, so
    nothing is lost. Such a pause is still reported by `/health` and `/today` but no longer freezes the
    plan - otherwise neither the resume nor the shift the hint names would be allowed - and the next
    successful shift or regenerate clears it.
  - **SSE.** `POST /plan/pause` publishes `plan` with `{ dates: [], reason: "pause", paused: { since,
    elapsedSec } }` and queues no sync. `POST /plan/resume` publishes `plan` with
    `{ dates: [...], reason: "resume", paused: null }`, so a UI never has to poll for the state.
- `POST /plan/regenerate` returns `{ regenerated: string[], clearedDaysOff: string[] }`. `from` must be between
  today and the plan's last date. It is the only call that clears days off from that date on, and
  `clearedDaysOff` lists the dates that were empty before it and hold work after it.
  **`from` = today rebuilds the rest of today from now**, which is how you pull work earlier after skips:
  - Past and in-progress items keep their times. A checked item still in progress ends now.
  - Checked items that had not started move to `checked`.
  - The remaining pending work is laid out from the end of the task in progress plus its rest.
    If a rest is in progress, it starts when that rest ends; if nothing is in progress, it starts now.
    It never starts before 08:00, nor before the resume point of an earlier minute/hour shift.
  - The rest between the last kept task and the new work always exists and spans the whole gap, however
    late the call is made: the time between two tasks is rest time, never an unlabelled hole. Such a rest keeps
    its kind and its place after 240 task minutes, and its title says it was stretched
    (`Rest (extended)` / `Long rest (extended)`), so hours of idle time never read as the 10-minute rest.
  - The day's order still never goes backwards (hard rule 6): once a fixed slot has run, only slots at or
    after it may follow, so prep is never added after the lessons or portfolio block. Capacity left over that
    way stays unused - the rule is "<= 480", not "= 480".
  - The **core scheduler** lays out the remainder, through the additive `GenerateInput.firstDay`
    (`{ startAt, taskMinSpent, maxTaskMin }`). It uses the same fill, look-ahead and no-fragment rules
    (`minPartMin`) as any day.
  - Task minutes already on today count toward the 240-minute mark and the 480-minute day, so the long rest
    never comes earlier than 240 task minutes.
  - The fixed blocks (lessons, portfolio, recurring) still fit; prep is what shrinks.
  - Anything that does not fit before midnight moves to the following days, which are regenerated.
- **Active hours** (`GET`/`PATCH /settings`; docs/PLAN.md, "Active hours"). Three settings, one
  pair of them a fence and the third a budget, applied to every day alike:
  - `dayStart` (default `08:00`), `dayEnd` (default `24:00`, meaning no fence beyond the calendar
    day) and `dailyTaskMin` (default `480`, minutes of task time with rests excluded). The defaults
    reproduce the original hard rules exactly.
  - **The rest rules never change.** A long rest still comes after every 4 h of task time, so a
    budget of 600 makes a third block rather than a longer one.
  - **Whichever binds first wins**, and the clock cost of work is **stepped**: crossing 8 h of task
    time buys a second hour-long rest, so 8 h → 8.5 h of work costs 1 h 40 of clock. A budget of 600
    inside an 08:00–20:00 window therefore grants 480. `effective.dailyTaskMin` is what the window
    actually yields on the coming full days and `effective.boundBy` is `"window"` or `"budget"`, so a
    client never shows only the request.
  - Work that does not fit before `dayEnd` **moves to the next day**; it is never dropped.
  - A window must lie inside one calendar day (`dayStart` < `dayEnd` <= `24:00`). One that wraps
    midnight is `400 INVALID_INPUT`, because every key in the plan carries the calendar date.
  - **The fence governs new work, not history.** Narrowing the window cannot unschedule a morning
    that has already run: past and in-progress items keep their times, as they do for any rebuild of
    today. From tomorrow on the fence is absolute.
  - A `PATCH` rebuilds **today** as well as the future, unlike a task edit, because a setting about
    when the day runs would look broken if it waited until tomorrow. `changed: false` with an empty
    `regenerated` means the patch asked for what was already set, and nothing was re-planned.
  - An unknown key, a clock time that is not `HH:MM`, an end at or before the start, a window too
    short for one task (`minPartMin`, 15 min) and a budget that is not a whole number of minutes from
    15 to 1440 are all `400 INVALID_INPUT` with nothing stored. A `dailyTaskMin` arriving as a
    numeric string is accepted, for forms and query strings.
  - The setting lives in SQLite (`meta.active_hours`) and is read live on every use, so the API and
    the daemon cannot disagree. A stored value that no longer parses or validates falls back to the
    defaults rather than failing every read.
- `POST /reload` returns `{ tasks: number, files: number, skipped: string[], errors: [], regenerated }`.
- **Write-back** (`POST`/`PATCH`/`DELETE` on `/plans` and `/tasks`, and `POST /backups/:name/restore`).
  All of it is implemented in `apps/api/src/taskfiles.ts` over the surgical editor in
  `packages/core/src/taskfile/edit.ts`; docs/PLAN.md "P9" holds the rules and the invariants.
  - **The envelope.** `task` or `plan`, `diff`, `file`, `regenerated`, `backup`, `sync`. `diff` is a
    unified diff against the file as it was, returned on **real** calls too, so the answer always
    says exactly what was done to the document. `task` is the task as the **new text parses**; on a
    delete it is the task as it was. `plan` is the `GET /plans` row. Three fields are present only
    when they apply: `warnings` (e.g. a derived `id`, or a `section` that had to be created),
    `forgot` (rows a delete removed, per table) and `restyled` (see below).
  - **Surgical, not re-rendered.** Only the lines inside the task's span - its heading, its
    ` ```task ` fence and its body - or the named front-matter keys are rewritten. Every other byte,
    including trailing whitespace, the hand-written contents list, tables and `python` fences, is
    left alone. A plan file is a document, not a data dump.
  - **The pipeline, in this order** (P9 rule 1): validate the request → build the new text in memory
    → **re-parse that text** → confirm it yields the intended task → snapshot the old file → write
    atomically (a temp file in the same directory, then a rename) → reload → regenerate → queue the
    sync. The re-parse is what makes the next point true.
  - **No partial writes.** If anything up to the rename fails, the file on disk is byte-identical to
    before and no snapshot is taken. If the **reload after** the rename fails - text that parses alone
    but breaks the set, such as a `starts_after` naming no loaded track or a duplicate uid across
    files - the snapshot is restored, the previously loaded tasks stay loaded, and the call is
    `422 TASK_FILE_ERRORS` with `details: [{file,line,message}]`.
  - **A write that changes no byte** answers `{ diff: "", backup: null, sync: "skipped", regenerated: [] }`
    rather than taking a pointless snapshot.
  - **Errors.** A bad field value, an unknown field, an empty patch, `id` or `track` in a `PATCH`
    (both immutable) and a `track` that is not `[a-z0-9][a-z0-9-]*` are `400 INVALID_INPUT`, and the
    message names the field and suggests the closest real one. An unknown uid, track or snapshot name
    is `404 UNKNOWN_TASK`. A duplicate `id`, an existing `track`, or a track declared by two files is
    `409 CONFLICT`: `:track` then names no single file, so the **plan** endpoints cannot act, while
    the **task** endpoints still work, because a task knows which file it came from. Text that will
    not parse is `422 TASK_FILE_ERRORS`, and so is a task whose file has been broken on disk since it
    was loaded - the message is the parser's own `file:line:`, not "no such task". A file deleted or
    renamed outside the API is `409 CONFLICT` naming `POST /reload`, never a `500`.
  - **`id` is immutable.** The uid `track/id` is what stored progress, plan-item keys and the
    calendar's `plannerKey` all key on, so a rename would have to migrate three stores and every
    existing Google event. A rename is `DELETE` then `POST`; the `title` changes freely - it is the
    event summary, not the identity.
  - **Unknown query parameters are refused**, so `?dryrun=true` is a `400` and never a real delete.
    `?dryRun` takes `true`/`false`/`1`/`0`/empty; anything else is a `400`.
  - **What regenerates.** A create or an update rebuilds the days **after today**, exactly as
    `POST /reload` does: today keeps the shape it already had. A **delete** and a **restore** rebuild
    today as well, because the work is gone from today too and a hole in the timeline is not an
    answer. To pull an update into today, follow it with `POST /plan/regenerate {"from":"<today>"}` -
    after checking `GET /today`, because that call also clears days off.
  - **`restyled`.** A change to what an item *shows* rather than when it runs - the title, the links,
    the type - is applied to today's already-placed items **in place**, keeping their times, keys,
    parts and status. So a rename reaches today's calendar event without re-timing a day that is
    already under way. `restyled` lists the dates that happened on (in practice today); dates in
    `regenerated` are not repeated there, their items being new already.
  - **A delete is a delete everywhere** (P9 rule 4). In one transaction: the Markdown section, then
    the task's rows in `task_status` (the bare uid and every `uid@date`), `plan_items`,
    `task_progress`, `sessions_held` and the `notifications` fired for its items. The next reconcile
    deletes its calendar events, because its items no longer exist. Nothing is left that a later
    `POST /reload` could resurrect. `forgot` reports the row counts.
  - **Snapshots.** Every write that replaces or removes an existing file snapshots it first, to
    `.data/taskfile-backups/<track>.<iso>Z.md` - the instant with `:` and `.` written as `-`, because
    a colon is not legal in a Windows file name, and the millisecond field always present so the
    names of a track sort in exactly time order. The newest 20 per track are kept. A name is never
    reused, even under a frozen clock. `GET /backups` lists them and
    `POST /backups/:name/restore` puts one back; the name is one path segment and is matched against
    that pattern, so it can name nothing outside the directory. A restore replaces the **file**: it
    does not bring back status or progress a delete dropped, and it forgets nothing for tasks the
    snapshot happens not to contain.
  - **Only under `resources/`.** Every resolved path must end in `.md` and be inside the task
    directory after symlink resolution.
  - **Atomic for the second reader.** Writes are a temp file plus a rename, and the temp name starts
    with a dot, which the loader skips - so the daemon never reads a half-written file and a crash
    between the two steps cannot leave something that loads.
  - **The contents list is not maintained** (P9 rule 7). `bcg.md`'s hand-written table of contents
    points at `##` sections; tasks are `###` and are not in it, so editing a task cannot touch it.
    Deleting a plan removes the whole file, so no dangling entry survives. **The one exception**: a
    `section` that does not exist is created as a new heading at the end of the file, which the
    contents list will not mention. That is reported in `warnings`, so the answer always says it
    happened; preview with `dryRun` if the file has a contents list worth keeping consistent.
  - **A pause does not block a write-back.** The file is the source of truth, and leaving it out of
    step with the plan for the length of a pause would defeat the point; the regeneration is the one
    `POST /reload` does, and today - the frozen part - is untouched by a create or an update.
- `POST /sync` returns `{ inserted, patched, deleted, unchanged, errors, calendarId, window: { from, to } }`.
  If single event writes failed after retries, the answer is `502 CALENDAR_ERROR` with that result in `details`.
- `GET /sync/status` also returns `lastAttemptAt`. `lastError` is `{ code, message, at }`.
  `pending` stays `true` after a failed sync until one succeeds.
- **Which Google credential, and whose calendar.** `GET /health` (under `calendar`) and
  `GET /sync/status` both report:
  - `credential`: `service-account` (a key in `.data/google-service-account.json`, which never
    expires), `oauth` (the refresh token in `.data/google-token.json`), `none`, `invalid` (a key is
    there but unusable - the API log says why), or `injected` (a client supplied in-process, in tests).
    A key present wins over a token, because installing one is a deliberate act. It is re-read on
    every call, so dropping a key in while the service runs needs no restart.
  - `calendarId`: the calendar in use, and `owned`: whether the planner created it.
    `owned: false` means `CALENDAR_ID` named a calendar the owner made and shared, and the planner
    **never creates or replaces it** - a 404 is answered with `502 CALENDAR_ERROR` naming the
    calendar and its sharing settings, not by making a new one. See CLAUDE.md for why that asymmetry
    exists.
- **SSE payloads.** `status`: `{ key, taskUid, date, status }` (by item) or `{ taskUid, date, status, keys }`
  (by uid). `plan`: `{ dates, reason }` with reason `status`, `shift`, `pause`, `resume`, `regenerate`,
  `reload`, `rollover`, `settings` (the active hours changed) or `external` (a write by another
  process, such as the daemon, seen by polling the store once a second). `pause` and `resume` also carry `paused` (the new state, `null` after a resume).
  `sync`: `{ ok, lastSyncAt, lastResult, lastError, pending, lastAttemptAt }`. `notification`:
  `{ at, type, itemKey, title }`, relayed from the store. The heartbeat is an SSE comment line.
- **Clock and zone.** `PLANNER_NOW` (fixed instant) or `PLANNER_CLOCK=start=...,speed=N`, and `PLANNER_TZ`.
  `PLANNER_HORIZON_DAYS` (default 7), `PLANNER_DATA_DIR`, `PLANNER_RESOURCES_DIR`, `PLANNER_API_PORT` (the
  host is always 127.0.0.1), `PLANNER_WEB_ORIGINS` (extra CORS origins) and `PLANNER_SYNC_DEBOUNCE_MS`.
