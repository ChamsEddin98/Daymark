# Changelog

All notable changes to Daymark. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the versioning is [semantic](https://semver.org/): the public surface is the HTTP API in
[docs/API.md](docs/API.md) and the task-file schema `planner/task-file@1`.

## [1.0.0] — 2026-10-05

First release. Every part is built and the HTTP API is a documented, tested contract.

### Scheduling

- Markdown task files (`planner/task-file@1`) become a timed daily plan: a 10-minute rest between
  tasks and an hour off after every 4 hours of task time. The rest rules are fixed and not settable.
- **Active hours** — `dayStart`, `dayEnd` and `dailyTaskMin` set when a day may begin, when it must
  stop and how much work it holds. The fence is enforced by bisecting for the largest budget the
  window holds, so there is one definition of where a day has to end. A bigger budget makes more
  blocks, never longer ones.
- **Carry-forward** — unfinished work re-places itself at the front of the next day. A day that is
  ignored costs days, not work; a capped daily series spends a session only when it is acted on, so
  it slides rather than losing sessions.
- **Missed work** — `onMissed` decides what happens when a task's slot goes by untouched: `reflow`
  (the default) reclaims it and lays the rest of the day out again from now, `notify` changes
  nothing and says so. Both notify; neither loses work.
- **Pause and resume** — freezes the plan and shifts everything still to come by exactly how long
  the pause ran.
- Shift by minutes, hours or days; regenerate; undo. An undo always re-plans from today, because the
  minutes it frees may belong to a higher-priority track.
- Splitting, priorities across prep tracks, `starts_after` gating, daily repeats with `occurrences`.
- DST-safe throughout: times are ISO-8601 with offsets and there is no `Date` arithmetic on
  wall-clock times.

### Google Calendar

- Idempotent two-way sync keyed on `extendedProperties.private.plannerKey`, with a content hash so
  an unchanged plan is not a write.
- Two credentials, same interface: a **service-account** key (scope `calendar.events`, never
  expires) writing into a calendar you own, or **OAuth** installed-app (scope
  `calendar.app.created`) with a calendar the planner creates and owns.
- A calendar you supplied via `CALENDAR_ID` is never created or replaced, even on a 404 — a service
  account that created one would own it, and an owned calendar is invisible in your Google Calendar.
- **`calendarReminders`** — `off`, `inherit`, or minutes before each task. A number is what reaches a
  phone; the policy is part of the event body, so turning it on patches the events that already
  exist.
- **`calendarName`** — what the planner's calendar is called. Renames in place, keeping every event.
  Reported with `calendarNameApplies`, because it can only reach a calendar the planner owns.

### Interfaces

- **HTTP API** on `127.0.0.1:4317` (Fastify), owning every write, with SSE at `/events` and a
  documented error envelope. Full contract in [docs/API.md](docs/API.md).
- **Markdown write-back** — the create, update and delete endpoints rewrite the `.md` files in the
  same call that re-parses them. Writes are surgical (only the lines asked for) and atomic, with
  snapshots and restore, because these are hand-written documents.
- **Web UI** on `127.0.0.1:3417` (Next.js, shadcn/ui, Tailwind, motion) — a daily view built for one
  question: what now, and what next. Keyboard-complete, accessible, tested at 390×844 and 1440×900.
- **Notification daemon** — native desktop notifications at every task and rest boundary, midnight
  rollover, missed-work handling and sync retries.
- **Claude Code plugin** — a router skill plus nine focused children, so routing costs ~1.5k tokens
  and an operation ~5–7k instead of ~32k.

### Storage

- SQLite via `node:sqlite` in WAL mode, with versioned migrations (schema v4).
- The dividing line: anything that survives `POST /reload` lives in Markdown; anything a reload would
  wipe (done, skipped, progress, days off, the pause) lives in SQLite. Nothing is written to both.

### Notes

- `resources/` is gitignored: plan files are personal documents and stay on the machine that runs the
  planner. [docs/example-task-file.md](docs/example-task-file.md) carries the structure.
- Clocks are injectable (`PLANNER_NOW`, `PLANNER_CLOCK`) so a day can be replayed or compressed.

[1.0.0]: https://github.com/ChamsEddin98/Daymark/releases/tag/v1.0.0
