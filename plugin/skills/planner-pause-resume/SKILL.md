---
name: planner-pause-resume
description: Pause and resume the owner's study plan through the local planner service at http://127.0.0.1:4317 — POST /plan/pause freezes the plan at this instant without moving anything, POST /plan/resume pushes everything still to come forward by exactly how long the pause ran, and GET /health or GET /today report the live pause state. Use for "pause", "hold on", "I need to step away", "take a break", "I'm back", "resume", "unpause", "how long have I been paused", and whenever a call answers 409 PAUSED.
---

# Planner · pause and resume

A pause freezes the plan while the owner steps away; the resume pushes everything still to come
forward by exactly how long they were gone. It is SQLite state (`meta.paused_since`) — **no Markdown
is written**, and `POST /reload` would wipe it, which is why it lives here and not in a task file.

## Calling the API

Base URL `http://127.0.0.1:4317` by default. Loopback only, no auth, JSON. Neither call takes a body.

**Finding the port.** It is `PLANNER_API_PORT`, default 4317:

1. `.data/runtime.json` in the repo, written at every `npm start` / `npm run dev`:
   `{ "apiUrl": "http://127.0.0.1:4417", … }` — the *last* start, so confirm with `GET <apiUrl>/health`.
2. `PLANNER_API_PORT` in the environment or the repo's `.env` (the environment wins).
3. The `[preflight] API: http://127.0.0.1:<port>` line `npm start` prints.
4. The default, 4317. 5. Otherwise, ask the user.

**Always start with `GET /health`** — it carries `paused: { since, elapsedSec } | null`, so it tells
you whether to pause or resume. Connection refused (curl exit 7) on every candidate port means the
service is down: ask the user to run `npm start`. Don't set a short `-m`/`--max-time`.

**Use the Bash tool with `curl -s`**, on every OS including Windows (Git Bash). From Windows
PowerShell 5.1, `curl.exe` strips the inner quotes of a JSON body; these two calls need no body, so
`Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4317/plan/pause'` is a safe fallback. An error
answer makes it throw; the JSON body is in `$_.ErrorDetails.Message`.

**Identifiers** (for the items a resume moves): task uid `track/id` (`bcg/A1`), URL-encoded as
`bcg%2FA1`; item key `YYYY-MM-DD|<uid>|<part>`, rests `YYYY-MM-DD|rest|<n>`.

## Endpoints

| Endpoint | Body | When to call it | Returns |
|---|---|---|---|
| `POST /plan/pause` | — | "Pause", "hold on", "I need to step away". Records the instant to the millisecond. **Nothing on the plan moves.** | `{ paused: { since } }` |
| `POST /plan/resume` | — | "I'm back", "resume". Measures `now - since` in milliseconds and shifts the plan forward by exactly that, then clears the pause. | `{ pausedSec, moved, endOfDay, day }` |
| `GET /health` | — | Is it paused, and for how long. | `… paused: { since, elapsedSec } \| null …` |
| `GET /today` | — | The same, plus where the user is in the day. | `… paused: { since, elapsedSec } \| null …` |

```sh
curl -s http://127.0.0.1:4317/health | grep -o '"paused":[^}]*}'
curl -s -X POST http://127.0.0.1:4317/plan/pause
curl -s -X POST http://127.0.0.1:4317/plan/resume
```

`since` is an ISO instant with millisecond precision. `elapsedSec` is measured when the field is
read, so it grows while the pause runs. `pausedSec` comes back as seconds **with a fractional part**
(`45.317`); `moved` counts the items whose times changed; `endOfDay` is the end of today's last
timeline item (`null` when today is empty); `day` is today after the shift.

## What to tell the user

- **On pause**: the plan is frozen, nothing has moved yet, and resuming will push everything still to
  come forward by however long they are gone.
- **On resume**: report `pausedSec` in plain words ("moved everything 45 seconds later", "you were
  away 1 h 12 m, so the day now ends at …") and give `endOfDay`.
- **Exact, not rounded.** The elapsed time is measured in milliseconds and applied as given: a 45 s
  pause moves the plan by 45 s, never by a rounded minute; a 3 ms pause moves it by 3 ms, and the
  stored times show it (`11:00:00.003+01:00`). Parse times as instants (`Date.parse`), never by
  string comparison.
- **Durations and order never change.** The cut point is the **pause** instant, not the resume
  instant: every item whose start is at or after the moment of the pause moves, and all by the same
  amount, so every duration, the order and every gap between the moved items are identical. Nothing
  that had not begun when they paused is allowed to run while they were away — a task due to start
  during the pause moves by the **whole** pause rather than being treated as already under way.
- **The one exception**: the item that was **under way** at the pause instant keeps its times, so the
  paused minutes are lost from that one task. That is the only way to honour the rule above. The
  widened gap before the next item becomes rest under the normal gap-to-rest rule, so the following
  rest keeps its start and ends later instead of moving.
- **A pause across local midnight** is cut at midnight. The midnight rollover still runs while
  paused, so the new day is built as usual, and a pause from 23:30 to 01:30 moves the **whole new
  day** forward by two hours — nothing on it had begun.
- **The pause is durable.** It lives in the store, so it survives a restart of the API or the daemon,
  and a resume after a restart still measures from the original instant.

## While paused

- **`GET /today` answers "where am I" from the pause instant.** `current`, `next`, `currentTask` and
  `nextTask` are derived from `paused.since`, not from the wall clock — reading them live would claim
  the user is 35 minutes into a task they never started. `now`, `date`, `paused.elapsedSec` and the
  timeline itself stay live.
- **Frozen**: `POST /plan/shift`, `POST /plan/shift/preview` and `POST /plan/regenerate` answer
  `409 PAUSED` with `details: { paused }` and a hint naming `POST /plan/resume`. The request is still
  validated first, so a bad `amount`, `unit` or `from` is `400 INVALID_INPUT` whatever the pause
  state. The Markdown write-back endpoints regenerate too, so they are refused the same way.
- **Still working**: `POST /items/:key/status` and `POST /tasks/:uid/status`, undo included. Ticking
  something off is not moving the schedule, so these apply, still re-plan the later days, and leave
  the pause alone (`study-planner:planner-schedule`).
- **No notifications.** The daemon reads the pause from the store on every scan (~1 s), fires no task
  or rest boundary for an instant inside the pause and **records nothing** for those instants, so the
  resume does not replay them. After the resume the boundaries fire at their new times.
- **One toast on resume**: the `task_end` of the task that was under way when the pause started. That
  task kept its times, so if the pause outlasted it its end fell inside the pause window and would
  never fire — it is fired once, at the resume instant, coalesced with the rest that starts there
  ("End: … · Rest until …"). A rest that was silently stretched is **not** corrected.
- **Google Calendar follows.** A resume queues the usual debounced sync, so the events are rewritten;
  a pause changes nothing and queues nothing. Events are written with whole seconds, so after a
  resume the next sync of an unchanged plan still reports `unchanged`
  (`study-planner:planner-calendar-sync`).

## Limits

- `pause` while already paused, and `resume` while not paused, are **`409 CONFLICT`**, carrying the
  current state in `details.paused` (`null` for the second). Read `/health` first and say which it
  is rather than retrying.
- **A pause longer than 24 h** resumes with `400 INVALID_INPUT` and a hint to shift whole days
  instead, **and the pause is kept**, so nothing is lost. Such a stale pause is still reported by
  `/health` and `/today` but **no longer freezes the plan** — otherwise neither the resume nor the
  shift the hint names would be allowed — and the next successful shift or regenerate clears it. So
  for a pause left running overnight, tell the user what happened and offer
  `POST /plan/shift {"amount":N,"unit":"days"}` (`study-planner:planner-schedule`).

## Errors

Always `{"error":{"code","message","hint"}}` — show the `hint`.

| Code (HTTP) | Meaning | What to do |
|---|---|---|
| connection refused | The service is down. | Ask the user to run `npm start`. |
| `CONFLICT` (409) | `pause` while paused, or `resume` while not paused. `details.paused` holds the current state. | Read `/health`, then say which it is. Don't retry the same call. |
| `INVALID_INPUT` (400) | A resume after a pause longer than 24 h. **The pause is kept.** | Explain, and offer a whole-day shift instead. |
| `PAUSED` (409) | You tried to move the plan while paused. | Resume first, then retry. |
| `FORBIDDEN_ORIGIN` / `FORBIDDEN_HOST` (403) | A browser `Origin`, or a `Host` other than `127.0.0.1:<port>`/`localhost:<port>`. | Call from the CLI on 127.0.0.1. |
| `INTERNAL` (500) | Unexpected failure. | Report it with the request. |

## Where to go next

- Shift, regenerate, mark done / skipped, reload → `study-planner:planner-schedule`
- Reads and how to interpret a paused `/today` → `study-planner:planner-read`
- Calendar sync after a resume → `study-planner:planner-calendar-sync`
- Changing a task's duration or any other file state → `study-planner:planner-update`
