# Daymark

A study-schedule service. It turns Markdown task files into a weekly day plan, syncs the plan
to a dedicated Google Calendar, serves a local web UI for today, and fires desktop
notifications at every task and rest boundary. It runs as its own processes. Claude Code is
only a client of its HTTP API.

*A daymark is an unlit navigational beacon you fix your position by in daylight — which is what the
daily view is for.*

> Status: every part is built: task files and parser, scheduler, SQLite store, HTTP API, Google
> Calendar sync, notification daemon, web UI and the Claude Code plugin. `npm start` runs all of it.
> Calendar sync is optional. There are two ways to connect it, and you need one:
> a **service account** writing into a calendar you own (nothing to expire, no `npm run auth`), or
> **OAuth** with a calendar the planner owns (one consent screen, then a re-auth every 7 days while
> the Cloud app is in Testing mode). See [docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md); the service
> account is the recommended one.

Docs: [docs/GOOGLE_SETUP.md](docs/GOOGLE_SETUP.md) (connecting Google Calendar, about 10 min) ·
[docs/API.md](docs/API.md) (HTTP API contract) · [docs/PLAN.md](docs/PLAN.md) (scheduling rules and
acceptance criteria) · [CLAUDE.md](CLAUDE.md) (architecture and conventions).

## Quick start (cold clone)

Needs Node.js 22.13 or newer (the store uses `node:sqlite`) and npm 10+.

```sh
git clone <repo-url> planner
cd planner
npm install                      # every workspace; `npm ci` also works (the lockfile is committed)

# Optional, for Google Calendar sync (the planner works without it):
cp .env.example .env             # PowerShell: Copy-Item .env.example .env
#   then set CALENDAR_ID (service account) or GOOGLE_CLIENT_ID/SECRET (OAuth) - docs/GOOGLE_SETUP.md
npm run auth                     # OAuth only; opens the browser once, token to .data/google-token.json

npm start                        # API + daemon + web UI
```

Then open:

- Web UI: <http://127.0.0.1:3417>
- API: <http://127.0.0.1:4317/health> and <http://127.0.0.1:4317/today>

`npm start` first runs a preflight (`scripts/preflight.mjs`):

- It checks the Node version and loads `.env`. It creates `.data/`, then creates and migrates the SQLite
  store once, so the API and the daemon never race to create it. It writes the ports to
  `.data/runtime.json`, which the Claude Code skill reads.
- It says whether Google is authorised, and which credential it found. If neither is usable it prints the hint and carries on.
- It runs `next build` for the web UI when the production build is missing or older than its
  sources. This takes about a minute, on the first run only.
- It prints the URLs.

It then runs the three processes with [concurrently](https://www.npmjs.com/package/concurrently),
prefixed `[api]`, `[daemon]` and `[web]`. If one of them exits with an error, the others are stopped
(kill-others-on-fail). Ctrl+C stops all three.

The web UI runs as a **production build** (`next start`). It starts at once and uses much less memory
than the dev server. It reads the API address per request, so one build works with any API port.
`npm run dev` uses the Next.js dev server and an auto-restarting API instead.

Ports come from `PLANNER_API_PORT` (default 4317) and `PLANNER_WEB_PORT` (default 3417). The start
script passes the API address to the web UI (`PLANNER_API`) and adds the web origin to the API's
allowed origins (`PLANNER_WEB_ORIGINS`), so the two always agree:

```sh
PLANNER_API_PORT=4417 PLANNER_WEB_PORT=3517 npm start              # bash
$env:PLANNER_API_PORT=4417; $env:PLANNER_WEB_PORT=3517; npm start  # PowerShell
```

`npm start` also reads `PLANNER_API_PORT` and `PLANNER_WEB_PORT` from `.env`. Values already set in
the environment win. It writes the ports it used to `.data/runtime.json`. The Claude Code skill reads
that file (then `PLANNER_API_PORT` / `.env`, then the default 4317) to find the API, so a non-default
port works without extra setup.

## Pause

Stepping away? **Pause** in the web UI (or `POST /plan/pause`) freezes the plan and records the
instant. Nothing moves while it is paused, and no notifications fire. **Resume** shifts everything
still to come forward by exactly how long you were gone — to the millisecond, so a 45-second pause
moves the day 45 seconds, not a rounded minute — and rewrites the Google Calendar events to match.

Durations, gaps and the order never change. The task you were in the middle of keeps its times, so
that one task loses the paused time; everything that had not started yet moves by the full pause. A
pause survives a restart, and one left running over 24 hours stops freezing the plan so you are never
locked out.

## Commands

Run these at the repo root.

| Command | What it does |
|---|---|
| `npm install` | Installs every workspace (`packages/*`, `apps/*`). |
| `npm start` | Preflight, then the API (`:4317`), the daemon and the web UI (`:3417`, production build). |
| `npm run dev` | The same with `next dev` and `tsx watch` for the API. No web build needed. |
| `npm run auth` | One-time Google OAuth for calendar sync, for the OAuth route only. Needs `.env` (see docs/GOOGLE_SETUP.md). `npm run auth -- --no-browser` prints the URL without opening a browser. A service account needs no such step. |
| `npm test` | Every workspace's tests. The API, daemon and packages use vitest. The web UI's Playwright suite builds the app and needs `npx playwright install chromium` once. |
| `npm run tasks:check [-- <path>]` | Validates task files (default `resources/`). |
| `npm run preflight` | Only the preflight checks, including the web build. |
| `npm run build:web` | `next build` for the web UI. |
| `npm run api` / `npm run daemon` / `npm run web` | One process on its own. `web` needs a build first and always uses port 3417 with the API at 4317 (set `PLANNER_API` to point it elsewhere). `api` honours `PLANNER_API_PORT` but only allows the web origin on 3417 unless you set `PLANNER_WEB_ORIGINS`. For other ports use `npm start`, which wires all of this up. |
| `npm run dev:mock -w @planner/web` | The web UI against the fixture API, with no backend. |

Useful env vars:

- `PLANNER_DATA_DIR`: state dir, default `.data/`.
- `PLANNER_TZ`: time zone, default the system's.
- `PLANNER_NOW` / `PLANNER_CLOCK`: a fixed or compressed clock, for testing.
- `PLANNER_NOTIFY`: the daemon's notification sinks.

## Active hours

Your working window — when a day may begin, when it must stop, and how much work it holds. One
setting for every day, changed from the gear in the daily view or over HTTP:

```sh
curl -s http://127.0.0.1:4317/settings
curl -s -X PATCH http://127.0.0.1:4317/settings   -H "content-type: application/json" -d '{"dayStart":"09:00","dayEnd":"20:00","dailyTaskMin":540}'
```

| Setting | Default | Meaning |
|---|---|---|
| `dayStart` | `08:00` | the earliest a day may begin |
| `dayEnd` | `24:00` | hard stop; nothing is placed past it (`24:00` = no fence) |
| `dailyTaskMin` | `480` | minutes of **task time** a day holds, rests excluded |

The defaults are the original rules, so an unconfigured planner behaves exactly as before. The rest
rules never change: a 10-minute rest between tasks and a 1-hour rest after every 4 hours of work, so
a bigger budget makes more blocks rather than longer ones. Work that does not fit before `dayEnd`
moves to the next day.

**One thing to know:** the clock cost of work is *stepped*, because every 4 hours of task time buys an
hour of long rest. Going from 8 h to 8.5 h of work costs 1 h 40 of clock, so asking for 10 h inside an
08:00–20:00 window grants 8. `GET /settings` reports what your window actually gives you
(`effective.dailyTaskMin`) and which setting is the limit (`effective.boundBy`), and the UI shows the
same thing rather than echoing the request. Details in [docs/PLAN.md](docs/PLAN.md), "Active hours".

## Calendar reminders

Daymark notifies you twice over, and the two reach different places:

- **The daemon** fires native desktop notifications at every task and rest boundary. They are
  immediate and detailed, but they only reach the machine running the planner.
- **Google Calendar** can notify on its own, which is what reaches your phone. This is off by
  default, so a fresh install is silent on the phone *by design* — the daemon is already covering the
  desk, and a Google reminder on top would double every toast.

`calendarReminders` is what turns the second one on:

```sh
curl -s -X PATCH http://127.0.0.1:4317/settings \
  -H "content-type: application/json" -d '{"calendarReminders":10}'
```

| Value | What the events carry | Use it when |
|---|---|---|
| `"off"` *(default)* | `useDefault: false`, no overrides — Google never notifies | you only work at the machine running the planner |
| *a number* | a popup that many minutes before the start (`0`–`40320`) | **you want the plan on your phone.** `10` is a good start; `0` means "at the start" |
| `"inherit"` | `useDefault: true` — the event obeys that calendar's own *Event notifications* | you would rather manage it in Google Calendar |

A few things that are easy to get wrong:

- **`"inherit"` is usually silent.** A secondary calendar — which is what the planner syncs into —
  has *no* default event notifications until you add one in Google Calendar's settings for that
  calendar. Pick a number instead unless you have set those up.
- **Don't set reminders by hand in the Google UI.** The sync owns the event body, so a manual
  per-event reminder is overwritten the next time that event is patched. This setting is the only
  durable way.
- **Changing it rewrites every event, once.** The policy is part of the event body, so the stored
  hash moves and the next sync patches the whole window; the sync after that has nothing to do. The
  plan itself does not move — unlike the active hours, this changes only how the day is *announced*,
  so nothing is re-timed and no work you are in the middle of is disturbed.
- **For the phone you still need the Google Calendar app** signed in to the account the calendar
  belongs to, with notifications allowed by the OS.

## Use from Claude Code

The repo ships a Claude Code plugin in `plugin/`. Claude Code is only a client, so the service must
be running (`npm start`).

The plugin is a parent skill, `planner`, that routes to eight focused children. The parent identifies
which operation is wanted and sends Claude Code to the one child that owns the endpoints for it:

| Skill | Owns |
|---|---|
| `planner` | The routing logic and the overall workflow. It carries no endpoint detail but `GET /health`. |
| `planner-read` | `/today`, `/plan`, `/tasks`, `/tracks`, `/plans`, `/notifications`, `/events` |
| `planner-schedule` | Status, undo, shift, regenerate, reload |
| `planner-create` | `POST /plans`, `POST /tasks` |
| `planner-update` | `PATCH /plans/:track`, `PATCH /tasks/:uid` |
| `planner-delete` | `DELETE /plans/:track`, `DELETE /tasks/:uid`, and the backups that undo them |
| `planner-pause-resume` | `POST /plan/pause`, `POST /plan/resume` |
| `planner-settings` | `GET`/`PATCH /settings` — the active hours and the calendar reminders |
| `planner-calendar-sync` | `POST /sync`, `/sync/status`, `/calendar/events`, and the Google setup |
| `planner-markdown-sync` | How the `.md` write-back works: diffs, `dryRun`, snapshots, restores |

The create, update and delete endpoints **rewrite the `resources/*.md` file themselves**, in the same
call that re-parses it, regenerates the affected days and queues the calendar sync. That is the rule
the skills state and Claude Code follows: **never hand-edit a task file to change a task.** The
dividing line is that anything surviving a `POST /reload` lives in the Markdown and anything a reload
would wipe (done, skipped, progress, days off, the pause) lives in SQLite. See
[docs/API.md](docs/API.md), "Write-back".

Install it from the local marketplace in `.claude-plugin/marketplace.json`. Run this at the repo root:

```sh
claude plugin marketplace add ./
claude plugin install daymark@daymark-local
```

Or load it for a single session without installing it:

```sh
claude --plugin-dir ./plugin
```

Then ask things like "what's next?", "mark bcg A1 done", "shift today by 1 hour", "make A1 two
hours", "add a task after A6", "delete that task" or "my day starts at 10". After pulling
plugin changes, run `claude plugin marketplace update daymark-local`. To check the manifests, run
`claude plugin validate plugin` and `claude plugin validate .`.

## Task files

Every task the planner can schedule comes from a Markdown file under `resources/`. The
Markdown is the source of truth. To add work, edit a file or drop in a new one. Nothing else
needs to change.

| File | Track | Kind | Tasks |
|---|---|---|---|
| `resources/bcg.md` | `bcg` | prep, priority 1 | 57 |
| `resources/salesforce.md` | `salesforce` | prep, priority 2 | 39 |
| `resources/anthropic.md` | `anthropic` | prep, priority 3 | 31 |
| `resources/lessons.md` | `lessons` | lessons | 1 daily task (2h, 28 days) |
| `resources/portfolio.md` | `portfolio` | portfolio | 1 daily task (1h) |
| `resources/apply.md` | `apply` | recurring, `starts_after: bcg` | 1 daily task (30m) |

These three files were converted from the original HTML plans. The HTML files stay next to
them for reference only. `tools/convert_html.py` is the one-shot converter, kept so the
conversion can be audited. Do not re-run it: it overwrites hand edits.

Validate every task file:

```sh
npm run tasks:check            # all of resources/
npm run tasks:check -- path/   # another folder
```

### Task-file schema (`planner/task-file@1`)

A task file is a Markdown file with YAML front matter. Inside the file, **a task is any
heading that is directly followed by a fenced ` ```task ` block.** Everything else in the file
is ordinary prose. The planner keeps it, but it never becomes a task.

````markdown
---
schema: planner/task-file@1
track: bcg
title: BCG X AI Engineer — Assessment Prep Plan
kind: prep
priority: 1
---

# BCG X AI Engineer — Assessment Prep Plan

Any prose, tables or notes. Links here are kept as file references.

## Block A — Pandas

### A1 · Boolean filtering

```task
id: A1
duration: 40m
type: coding
link: "[595. Big Countries](https://leetcode.com/problems/big-countries/)"
```

Task body: snippets, notes and extra links. The body runs until the next heading of the
same or a higher level, so `####` sub-headings stay inside it.
````

#### Front matter

| Key | Required | Meaning |
|---|---|---|
| `schema` | yes | Always `planner/task-file@1`. Markdown files without it are skipped, so a README in the folder is fine. |
| `track` | yes | Slug for the source this file feeds (`bcg`, `lessons`, `portfolio`). Several files can share a track. |
| `title` | yes | Human name of the source. |
| `kind` | yes | `prep`, `lessons`, `portfolio`, or `recurring`. Decides which slot of the day the tasks go into (see below). |
| `priority` | prep only | Integer, lower runs first. When one prep track is done, the next one takes its slot. |
| `default_duration` | no | Duration used when a task block leaves out `duration`. |
| `source_html` | no | Where the file was converted from, if it was. |
| `starts_after` | no | A track slug. The file's tasks are only scheduled from the day that track is finished (every task done or skipped). |

Unknown keys are an error. That way a typo like `priorty` gets reported instead of silently
ignored.

#### Task block

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Unique within the track. Letters, digits, `.`, `_`, `-`. The global id is `track/id` (for example `bcg/A1`). Task status, calendar events and the API all key on it, so **do not rename an id once it has been scheduled.** |
| `duration` | yes* | Estimated time: `40m`, `2h`, `2h30m`, or a bare number of minutes. *Can be left out if the file sets `default_duration`. |
| `type` | yes | `coding` (a problem on a platform), `concept` (a card to understand), `build` (make something), `mock` (a timed rehearsal), `drill` (recall or repair), `reading`, or `admin`. |
| `link` | no | The platform link, as `"[label](https://…)"` or a bare `https://…` URL. It can also be a YAML list, in which case the first entry is the primary link. The primary link goes into the calendar event. Quote it, because YAML treats `[` specially. |
| `repeat` | no | `daily`: book this task on every plan day instead of once. Status is then tracked per day. |
| `occurrences` | no | With `repeat`: stop after this many days. Omit for no end. |

The **heading text is the task title**, and it is used word for word as the calendar event
title. So it should name the actual work, like `A13 · shift, lag and diff` or
`Read: Chapter 3 — Attention` or `Build: login form validation`. A generic label like
`Study` does not work as a title.

Task **order** is the order in the file. Task **status** (done, skipped) is not stored in
Markdown. It lives in the service's state, keyed by `track/id`, so editing a file never
resets progress.

#### Kinds and how the day uses them

| Kind | Slot in the day |
|---|---|
| `prep` | The first slot. It takes the lowest-`priority` prep track that still has tasks left. |
| `lessons` | After prep. |
| `portfolio` | A smaller block at the end of the day. |
| `recurring` | Every task in the file is added to every day, once it is active. For example, *apply for positions* starts once BCG prep is finished. |

#### Errors

The parser never crashes on a bad file. It reports `file:line: message` for each problem:
a missing or invalid duration, an unknown key or type, a duplicate id, a `task` block that
does not directly follow a heading, a malformed link, or an unclosed fence. The other files
still load.

#### Parsed shape

`parseTaskFile(text, path)` in `packages/core` returns
`{ file: { meta, tasks, references }, errors }`, where each task is:

```ts
{ uid: "bcg/A1", track: "bcg", id: "A1", title: "A1 · Boolean filtering",
  durationMin: 40, type: "coding",
  links: [{ label: "595. Big Countries", url: "https://leetcode.com/problems/big-countries/" }],
  body: "…markdown…", bodyLinks: [...], section: "4. Block A — Pandas, 20 techniques",
  order: 1, file: "resources/bcg.md", line: 97 }
```

`references` holds links from prose that belongs to no task, such as sources and tables.
Together, `links`, `bodyLinks` and `references` account for every link in the file.

### How the HTML plans were mapped

- **Technique cards became tasks.** The card number is the `id`, the problem link is the
  `link`, and the snippet, transfer notes and traps are the body.
- **Work rows from each plan's own day-by-day schedule became tasks too**, under
  *Practice sessions*. These are mocks, level-chaining builds, recall drills, weak-spot
  repair and next-round prep, and their hours come from the plan. Rest, buffer and
  technique-day rows did not become tasks, because the technique days already exist as
  cards. The original schedule tables are still kept as prose.
- **The skip tests became one task per plan**, with the checklist in the body. Ticking a
  check does not delete anything. Mark the retired techniques as skipped through the API
  instead.
- Durations come from each plan's own arithmetic. Anthropic techniques are 2h. BCG durations
  are set per block from its schedule rows:
  - pandas (A): 40m, which is the plan's hard cap
  - NumPy (B): 25m
  - the C1 template: 1h30m
  - concept cards (D): 20m
  - DSA (E): 40m
  - the Titanic run: 40m, so days 12–13 add up to their 4h Salesforce techniques are 2h30m, except H1 and H2, which are
  1h each so its day 15 fits in 4h. Salesforce mock-only days are 4h, and days 7 and 14 are a
  3h mock plus a 1h recall. Change any of these in the Markdown whenever you like.
- Where a plan's per-technique budget and its per-day rows disagree, the per-technique budget
  wins. For example, Salesforce budgets 2.5h per technique, but day 1 lists the skip test plus
  two techniques in a 4h row. Practice tasks, which have no technique budget, match their
  day's Hours cell exactly, and a test checks that.
- A card paragraph that holds nothing but its problem link(s) becomes the task's `link`
  field, and the link labels are kept. If the paragraph says more than the links (a scope such
  as "exercises 21–30", or a variant problem), the whole paragraph is also kept in the body.
- Anthropic builds #1–#3 and the mocks link to the LibreSignal or PaulLockett repos. This
  comes from the plan's "Mock material" paragraph, which names those repos as the source for
  those sessions. The schedule rows themselves have no links.
- `packages/core/test/html-preservation.test.ts` checks the conversion. It asserts that
  every external link in each HTML file is present in the `.md` and in the parsed objects.
  It also checks that each card's problem link sits on that card's task, and that every
  checkbox item and table cell survived.
