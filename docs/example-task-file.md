---
schema: planner/task-file@1
track: example
title: Example Track — how a task file is put together
kind: prep
priority: 1
default_duration: 40m
---

# Example Track — how a task file is put together

This is a complete, valid `planner/task-file@1` document. It exists so the structure is in the
repo without anyone's actual plans being in the repo: the real files under `resources/` are
personal, so they are gitignored. The full reference is in the README, "Task files"; this file is
the worked example you can copy.

Validate any file, including this one:

```sh
npm run tasks:check -- docs/example-task-file.md
npm run tasks:check                              # everything under resources/
```

To start your own plan, copy this to `resources/<track>.md`, change the front matter, replace the
tasks, then `POST /reload` (or restart). **Do not leave a copy of it under `resources/`**: anything
there with a `schema:` line is loaded as a real plan and its tasks get scheduled.

Prose like this paragraph is kept and never becomes a task. Only a heading **directly followed by a
fenced ` ```task ` block** is a task.

## Block A — the shape of a task

### A1 · A task with one link

```task
id: A1
duration: 40m
type: coding
link: "[595. Big Countries](https://leetcode.com/problems/big-countries/)"
```

The heading text — `A1 · A task with one link` — is what you see as the **calendar event title**, so
write it for someone glancing at their phone. This body runs until the next heading of the same or a
higher level, which means `####` sub-headings below stay part of it.

#### A note that belongs to A1

Still inside A1's body, because `####` is deeper than `###`.

### A2 · Several links, as a list

```task
id: A2
duration: 1h
type: concept
link:
  - "[The paper](https://example.com/paper.pdf)"
  - "[The follow-up](https://example.com/notes)"
  - https://example.com/a-bare-url-works-too
```

Three link forms are accepted: a `"[label](url)"` string, a list of them, and a bare URL. The first
link becomes the event's `source`, and all of them are listed in the event description.

### A3 · A task long enough to be split

```task
id: A3
duration: 2h30m
type: build
```

Durations are `40m`, `2h` or `2h30m`. A task longer than the rest rules allow in one sitting is
**split across parts** by the scheduler — you do not split it here. Each part keeps this id and gets
its own part number, so the plan item key is `date|example/A3|1`, `…|2`, and so on.

### A4 · Leaning on default_duration

```task
id: A4
type: drill
```

`duration` is omitted, so the `default_duration: 40m` from the front matter applies.

## Block B — the remaining task types

### B1 · A timed mock

```task
id: B1
duration: 1h
type: mock
```

### B2 · Reading

```task
id: B2
duration: 30m
type: reading
```

### B3 · Admin

```task
id: B3
duration: 20m
type: admin
```

The seven types are `coding`, `concept`, `build`, `mock`, `drill`, `reading` and `admin`. They are
shown in the daily view and in the event description; they do not change the scheduling.

## What goes in the task block

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Unique within the file. The task's full uid is `track/id`, e.g. `example/A1`. |
| `duration` | unless `default_duration` is set | `40m`, `2h`, `2h30m`. |
| `type` | yes | `coding` `concept` `build` `mock` `drill` `reading` `admin`. |
| `link` | no | A `"[label](url)"` string, a list of them, or a bare URL. |
| `repeat` | no | `daily` — one session a day instead of a one-off block. |
| `occurrences` | no | With `repeat: daily`, how many sessions in total. Omit for "every day, forever". |

Unknown keys are an **error**, not ignored, so a typo like `duraton` is reported rather than
silently dropped.

## Front matter for the other kinds

`kind` decides which slot of the day a file's tasks go into, and this file is `prep`. The other
three look like this — one `kind` per file, so these are separate files, not extra sections here:

A daily lesson, capped at a number of sessions:

```yaml
---
schema: planner/task-file@1
track: lessons
title: Course — one session a day
kind: lessons
---
```

with a task block carrying the repeat:

```yaml
id: SESSION
duration: 2h
type: concept
repeat: daily
occurrences: 28
```

A smaller daily block that never ends — omit `occurrences`:

```yaml
---
schema: planner/task-file@1
track: portfolio
title: Portfolio — a steady hour
kind: portfolio
---
```

Work that only starts once another track is finished:

```yaml
---
schema: planner/task-file@1
track: apply
title: Apply for positions
kind: recurring
starts_after: bcg
---
```

`starts_after: bcg` holds these tasks back until every task in the `bcg` track is done or skipped.

## Two things that are not in Markdown

**Status is never stored here.** Done, skipped, progress, days off and the pause live in SQLite, so
`POST /reload` re-reads this file without losing any of it. The dividing line: if a change should
survive a reload it belongs in Markdown (title, duration, type, links, repeat, order, front matter);
if a reload would wipe it, it belongs in the database.

**The planner writes this file back.** The create, update and delete endpoints edit the Markdown in
the same call that re-parses it. Those writes are surgical — they change the lines they were asked to
and leave every other byte alone — because these are hand-written documents, not data dumps. So your
own formatting, prose and comments survive being edited through the API.
