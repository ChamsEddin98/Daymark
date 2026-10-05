# Daymark — Claude Code plugin

Drive [Daymark](https://github.com/ChamsEddin98/Daymark), a **local study planner**, from Claude Code:
ask what's next, tick work off, reshape the week, change your working hours, or push the plan to
Google Calendar — in plain language.

Daymark turns Markdown task files into a daily study schedule with fixed rest rules, syncs it to a
dedicated Google Calendar, shows it in a local web UI, and fires desktop notifications at every task
and rest boundary.

**The plugin is only an HTTP client.** The planner runs as its own service and works without Claude
Code; this plugin talks to it over `http://127.0.0.1:4317`. So the service has to be running:

```sh
npm start        # in your Daymark checkout: API + notification daemon + web UI
```

## Install

```sh
claude plugin marketplace add ChamsEddin98/Daymark
claude plugin install daymark@daymark-local
```

Or load it for a single session, from a checkout:

```sh
claude --plugin-dir ./plugin
```

## What you can ask for

| You say | What happens |
|---|---|
| "what's next?" | reads today's plan, names the current task and the next boundary |
| "mark bcg A1 done" / "skip it, I know this already" | sets the status; skipping is permanent, done is undoable |
| "shift today by an hour" / "move everything to tomorrow" | re-times the plan, keeping what already ran |
| "make A1 two hours" / "add a LeetCode task after A6" | rewrites the Markdown task file **and** re-plans |
| "my day starts at 10" / "I want 10 hours a day" | changes the active hours |
| "remind me 10 minutes before each task" | turns on Google Calendar reminders |
| "is my calendar up to date?" | checks or forces the sync |
| "am I behind?" | explains that unfinished work already carried itself forward |
| "pause" / "I'm back" | freezes the plan and shifts it by however long you were away |

## How it is organised

A parent skill, `planner`, is a **router**: it identifies which operation is wanted and loads the one
child skill that owns the endpoints for it. That keeps context small — routing costs about 1.5k
tokens, a real operation loads about 5–7k, where one monolithic skill would be ~32k.

| Skill | Owns |
|---|---|
| `planner` | The routing table and the rules every operation shares. No endpoint detail but `GET /health`. |
| `planner-read` | `/today`, `/plan`, `/tasks`, `/tracks`, `/plans`, `/notifications`, `/events` |
| `planner-schedule` | Status, undo, shift, regenerate, reload, and how unfinished work carries forward |
| `planner-create` | `POST /plans`, `POST /tasks` |
| `planner-update` | `PATCH /plans/:track`, `PATCH /tasks/:uid` |
| `planner-delete` | `DELETE /plans/:track`, `DELETE /tasks/:uid`, and the backups that undo them |
| `planner-pause-resume` | `POST /plan/pause`, `POST /plan/resume` |
| `planner-settings` | `GET`/`PATCH /settings` — active hours, calendar reminders, calendar name |
| `planner-calendar-sync` | `POST /sync`, `/sync/status`, `/calendar/events`, and the Google setup |
| `planner-markdown-sync` | How the `.md` write-back works: diffs, `dryRun`, snapshots, restores |

## Two rules the skills follow

- **Never hand-edit a task file to change a task.** The create, update and delete endpoints rewrite
  the Markdown themselves, in the same call that re-parses it, regenerates the affected days and
  queues the calendar sync. Those writes are surgical and atomic.
- **Never call Google Calendar directly.** Every calendar read and write goes through the planner's
  API, which owns the event bodies and keeps the sync idempotent.

## Finding the API

The skills look for the port in `.data/runtime.json` (written by `npm start`), then
`PLANNER_API_PORT`, then `.env`, then the default `4317`. A non-default port needs no extra setup.

## Docs

[README](https://github.com/ChamsEddin98/Daymark#readme) ·
[HTTP API](https://github.com/ChamsEddin98/Daymark/blob/dev/docs/API.md) ·
[Scheduling rules](https://github.com/ChamsEddin98/Daymark/blob/dev/docs/PLAN.md) ·
[Google Calendar setup](https://github.com/ChamsEddin98/Daymark/blob/dev/docs/GOOGLE_SETUP.md)

MIT licensed.
