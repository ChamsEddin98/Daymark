---
name: planner-settings
description: Read and change the planner's settings through the local service at http://127.0.0.1:4317 - GET /settings and PATCH /settings. Covers the active hours (dayStart, dayEnd, dailyTaskMin, and onMissed - whether a task whose time passed re-times the day or only notifies) and the calendar settings (calendarReminders - whether Google Calendar notifies and how long before a task; calendarName - what the calendar is called). Use for "my day starts at 10", "nothing after 6pm", "I want to study 10 hours a day", "I only have evenings", "what are my active hours", "stop re-timing my day", "I don't get notifications on my phone", "remind me 10 minutes before each task", "rename my calendar". These are limits applied to every day; the rest rules (10 min between tasks, 1 h after every 4 h) are not settable.
---

# Planner · active hours

The owner's working window: when a day may begin, when it must stop, and how much work it holds.
One setting for every day — there are no per-weekday hours.

| Setting | Default | Meaning |
|---|---|---|
| `dayStart` | `08:00` | the earliest a day may begin |
| `dayEnd` | `24:00` | hard stop; nothing is placed past it (`24:00` = no fence) |
| `dailyTaskMin` | `480` | minutes of **task time** a day holds, rests excluded |
| `onMissed` | `reflow` | what happens when a task's time passes and it is not done |

The defaults are the owner's original rules, so a planner nobody has configured behaves exactly as it
always did.

## What these do NOT change

**The rest rules are not settable and never change**: a 10-minute rest between consecutive tasks, and
a 1-hour long rest after every 4 hours of task time. So raising `dailyTaskMin` to 600 does **not**
make a 10-hour block — it makes a third block, with long rests at 4 h and 8 h.

Do not offer to change the rest lengths or the 4-hour block; they are not exposed, by design.

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
the service is down: ask the user to run `npm start` from the repo root. Don't set a short `-m`.

**Use the Bash tool with `curl -s`**, on every OS including Windows (Git Bash). Do **not** pass a JSON
body to `curl.exe` from Windows PowerShell 5.1: it strips the inner quotes. PowerShell fallback:

```powershell
Invoke-RestMethod -Method Patch -Uri 'http://127.0.0.1:4317/settings' -ContentType 'application/json' -Body (@{ dayEnd = '20:00' } | ConvertTo-Json)
```

## Endpoints

| Endpoint | Body | Effect |
|---|---|---|
| `GET /settings` | — | The hours, the defaults, **what the window actually grants**, `calendarReminders`, and `calendarName` (+ `calendarNameApplies`). |
| `PATCH /settings` | any subset of `{ dayStart, dayEnd, dailyTaskMin, onMissed, calendarReminders, calendarName }` | Validates, stores, rebuilds today and the future, queues the calendar sync. `calendarReminders` and `calendarName` rebuild nothing. |

`PATCH` accepts `dryRun: true` in the body or `?dryRun=true`, which validates and writes nothing.
`GET /health` carries `activeHours` as well, so one call tells you how the day is shaped.

```sh
curl -s http://127.0.0.1:4317/settings

# "my day starts at 10"
curl -s -X PATCH http://127.0.0.1:4317/settings \
  -H "content-type: application/json" -d '{"dayStart":"10:00"}'

# "nothing after 8pm"
curl -s -X PATCH http://127.0.0.1:4317/settings \
  -H "content-type: application/json" -d '{"dayEnd":"20:00"}'

# "I want 10 hours a day" - needs the window open late enough, see below
curl -s -X PATCH http://127.0.0.1:4317/settings \
  -H "content-type: application/json" -d '{"dailyTaskMin":600,"dayEnd":"22:30"}'

# "I only have evenings"
curl -s -X PATCH http://127.0.0.1:4317/settings \
  -H "content-type: application/json" -d '{"dayStart":"18:00","dayEnd":"23:00","dailyTaskMin":240}'

# "remind me on my phone 10 minutes before each task"
curl -s -X PATCH http://127.0.0.1:4317/settings \
  -H "content-type: application/json" -d '{"calendarReminders":10}'
```

## Calendar reminders

`calendarReminders` lives on this endpoint but it is **not** an active hour: it changes how the plan
announces itself, never when it runs, so `regenerated` is always `[]` for it. A sync is still queued,
because every event has to be rewritten.

| Value | Effect |
|---|---|
| `"off"` *(default)* | Google never notifies. The daemon's desktop toasts are the only alerts. |
| a number `0`–`40320` | a popup that many minutes before each task starts — **this is what reaches a phone** |
| `"inherit"` | defers to that calendar's own event notifications, which a secondary calendar has **none** of until the owner adds one |

Use it when the owner says any of: "I don't get notifications on my phone", "remind me before each
task", "notify me 15 minutes early", "the calendar is silent", "turn off the calendar alerts".

What to tell them:

- The silence on the phone is deliberate, not a bug — the daemon already notifies at the desk, and a
  Google reminder on top would double every toast there.
- Setting it patches **every event in the window, once**; the sync after that reports no changes.
  Report the first sync's `patched` count so a large number does not look alarming.
- A reminder they added by hand in the Google UI is wiped by the next patch of that event. This
  setting is the only durable way.
- They still need the Google Calendar app signed in on the phone with OS notifications allowed. If it
  stays silent after a sync, that is the thing to check — not this setting.
- Prefer a number over `"inherit"` unless they say they have set up event notifications on that
  calendar themselves.

## Calendar name

`calendarName` is what the planner's calendar is called. Default `Daymark`; send `null` to restore
it. Like the reminders it rebuilds nothing - `regenerated` is `[]` - and only queues a sync, which
renames the **same** calendar in place and keeps every event.

```sh
curl -s -X PATCH http://127.0.0.1:4317/settings   -H "content-type: application/json" -d '{"calendarName":"My Study Plan"}'
```

Use it for "rename my calendar", "call the calendar X", "my calendar is called Daymark, change it".

**Check `calendarNameApplies` before promising it worked.** When it is `false` the owner supplied
the calendar through `CALENDAR_ID`: it is theirs, they name it in Google Calendar, and the
`calendar.events` scope cannot rename it. The value is still stored - their credential may change
later - but tell them plainly that the rename will not reach Google and that they should rename it in
Google Calendar instead. Do not report it as done.

## The one thing to get right: the clock cost of work is stepped

**Read this before telling the owner a window will give them what they asked for.**

Every 4 hours of task time buys an hour of long rest. So the clock a day needs does not grow smoothly
with the work:

| `dailyTaskMin` | long rests | a day from 08:00 ends about |
|---|---|---|
| 480 (8 h) | 1 | 18:40 |
| 510 (8.5 h) | 2 | 20:20 |
| 600 (10 h) | 2 | 22:20 |

Thirty more minutes of work costs **1 h 40** of clock. The consequence: **asking for 10 hours inside
an 08:00–20:00 window silently grants 8**, because the window cannot hold the second long rest.

So whenever the owner raises `dailyTaskMin`, **read `effective` back and tell them the real number**:

```json
{ "activeHours": { "dayStart": "08:00", "dayEnd": "20:00", "dailyTaskMin": 600 },
  "effective": { "dailyTaskMin": 480, "boundBy": "window", "lastEnd": "…T18:40:00+01:00" } }
```

- `effective.dailyTaskMin` — what the coming full days actually hold.
- `effective.boundBy` — `"window"` means the fence is the limit (widen `dayEnd` to get more work),
  `"budget"` means `dailyTaskMin` is, and the window has room to spare.

If `boundBy` is `"window"` and the owner wanted more work, say so plainly and offer the `dayEnd` that
would deliver it, rather than reporting the request as if it had been granted.

Beyond roughly 11 hours of task time no day can hold the result at all. The setting is still accepted
— it is a budget, not a promise — but say that it will not be reached.

## Field rules

| Field | Rule |
|---|---|
| `dayStart` | `"HH:MM"`. Must be before `dayEnd`. |
| `dayEnd` | `"HH:MM"`, up to `"24:00"` (midnight, meaning no fence). Must be after `dayStart`. |
| `dailyTaskMin` | A whole number of **minutes**, 15 to 1440. Hours × 60 — `"10 hours"` is `600`. A numeric string is accepted. |
| `onMissed` | `"reflow"` or `"notify"`. See below. |

A window must lie inside one calendar day. **`22:00`–`02:00` is refused**: every key in the plan
carries the calendar date, so a day spanning two dates would break all of them. If the owner studies
through midnight, the honest answer is that the planner cannot express it, not a workaround.

A PATCH is a subset: keys you don't send keep their current value.

## `onMissed` — a task's time passed and it is not done

| Value | What happens |
|---|---|
| `"reflow"` (default) | The work comes off the past, the rest of the day is laid out again from now, and a notification says where it went. A late start slides the day. |
| `"notify"` | Nothing moves. A notification says it is still pending, and the owner decides: do it, skip it, or leave it to roll over tonight. |

Neither is "off" — one re-times the day, the other leaves it alone *and says so*. **Work is never
lost either way**: whatever is still pending at midnight carries to the next day.

```sh
# "stop moving my day around, just tell me"
curl -s -X PATCH http://127.0.0.1:4317/settings   -H "content-type: application/json" -d '{"onMissed":"notify"}'
```

Things worth saying to the owner when this comes up:

- It needs the service running (`npm start`), because the daemon is what notices. Without it, the
  work still carries over at midnight — it just does not slide during the day.
- Nothing counts as missed while the plan is **paused**; a slot going by is what a pause is for.
- One notice per task per day, so a day that re-times itself several times does not nag repeatedly.
- `GET /notifications?type=missed` lists what has been missed, which is how you answer "what did I
  not get to today".
- In `notify` mode the two follow-up actions are `POST /tasks/:uid/status {"status":"skipped"}` to
  drop it (`daymark:planner-schedule`), or nothing at all — the rollover carries it.

## What happens to the plan

- **Today is rebuilt too**, not just the future — unlike a task edit. A setting about *when the day
  runs* would look broken if it waited until tomorrow. `regenerated` includes today.
- **Work that no longer fits moves to the next day.** It is never dropped. A narrower window means the
  same tasks reach further out, so say that rather than implying work was lost.
- **The fence cannot un-run this morning.** Narrowing `dayEnd` to 09:00 at 3pm leaves today's morning
  items where they are — past and in-progress items always keep their times. From tomorrow on the
  fence is absolute. Don't report this as a bug.
- **A calendar sync is queued** automatically, so Google Calendar follows.
- `changed: false` with an empty `regenerated` means the patch asked for what was already set.

## How to work

1. **`GET /settings` first**, so you can tell the owner what is currently set and report the change as
   a before/after rather than an assertion.
2. **Convert hours to minutes yourself** and confirm the number back: "10 hours a day — that's
   `dailyTaskMin: 600`".
3. **Dry-run anything you inferred rather than were told**, and any change that both narrows the
   window and raises the budget.
4. **Commit, then read `effective` and report the real outcome** — the dates in `regenerated`, the
   task time a day will actually hold, and whether the window or the budget is the limit.
5. If the owner's intent needs per-weekday hours ("weekends are different"), say plainly that the
   planner has one window for all days, and offer the nearest thing: a window that suits the days
   that matter most, or skipping tasks / a days shift for specific days
   (`daymark:planner-schedule`).
6. **Never edit `.data/` or a task file to change the hours.** This setting is not in the Markdown.

## Errors

Always `{"error":{"code","message","hint"}}` — show the `hint`.

| Code (HTTP) | Meaning | What to do |
|---|---|---|
| connection refused | The service is down. | Ask the user to run `npm start`. |
| `INVALID_INPUT` (400) | An end at or before the start, a window that wraps midnight, a window too short for one task (15 min), a `dailyTaskMin` that is not a whole number from 15 to 1440, a clock time that is not `HH:MM`, or an unknown key. | Fix the value. **Nothing was stored** — the previous hours are still in force. |
| `FORBIDDEN_ORIGIN` / `FORBIDDEN_HOST` (403) | A browser `Origin`, or a `Host` other than `127.0.0.1:<port>`. | Call from the CLI on 127.0.0.1. |
| `CALENDAR_NOT_AUTHORIZED` (503) / `CALENDAR_ERROR` (502) | **The setting and the re-plan did succeed.** | Say so, then → `daymark:planner-calendar-sync`. |
| `INTERNAL` (500) | Unexpected failure. | Report it with the request. |

## Where to go next

- Mark things done, shift the plan, pull today earlier → `daymark:planner-schedule`
- Change a task's own duration (not the day's budget) → `daymark:planner-update`
- Step away for a while → `daymark:planner-pause-resume`
- See what the plan looks like now → `daymark:planner-read`
