# Build plan: parts, contracts, and "better than Todoist" per part

This is the working spec every builder and critic receives. The hard scheduling rules come
from the owner and must not be reinterpreted.

## Architecture

```
resources/*.md ──parse──▶ packages/core (parser, scheduler, shift)   pure TS, no I/O
                                   │
                    packages/store (SQLite via node:sqlite, .data/planner.db, WAL)
                      ▲            ▲                 ▲
   apps/api  (Fastify, 127.0.0.1:4317) ── owns all writes; Claude Code + web UI are clients
   apps/daemon (scheduler: OS notifications, midnight rollover, calendar sync retries)
   packages/calendar (Google Calendar reconcile, OAuth installed-app flow)
   apps/web  (Next.js + shadcn/ui + Tailwind + motion, 127.0.0.1:3417, talks only to the API)
   plugin/   (Claude Code plugin: skill documenting the API)
```

- `npm start` at the root launches the API, the daemon and the web UI. None of them needs Claude Code.
- The API and the daemon are separate processes. They share state through SQLite in WAL mode. The daemon
  never calls the API for its own work, but it does read the same store.
- Stack: Node ≥ 22.13 and TypeScript run with `tsx`, npm workspaces, and vitest.

## Hard scheduling rules (owner's words, restated precisely)

> **Amended by "Active hours"** (last section of this file). Rules 1 and 4 are now the *defaults* of
> three settings the owner can change: `dayStart` (08:00), `dayEnd` (24:00, i.e. no fence) and
> `dailyTaskMin` (480). The rest rules — 2, 3 and the long rest after every 4 h — are not settable
> and never change. With the defaults, every rule below reads exactly as it always did.

1. The day starts at 08:00 local time.
2. There is a 10-minute rest between consecutive tasks.
3. After 4 hours of *task time* (rests excluded) comes a 1-hour rest. The long rest replaces the 10-minute rest at that point.
4. Then a second 4-hour block under the same 10-minute rule. The day holds 8 h of task time: 4 h, 1 h rest, 4 h.
   *(Active hours: 8 h is `dailyTaskMin`'s default. A larger budget makes more blocks of the same
   4 h shape — 10 h is 4 h, rest, 4 h, rest, 2 h — never a longer block.)*
5. The horizon is 7 days, and `days` is a parameter, so 28 or 60 days works with no code change.
6. The day's order is the prep slot, then AI engineering lessons, then the portfolio project (the smaller
   block), then recurring tasks once they are active.
7. The prep slot takes the lowest-`priority` prep track that still has pending tasks: BCG, then Salesforce,
   then Anthropic. When a track runs out partway through a day, the next track continues in the same slot
   that same day.
8. "Apply for positions" (`resources/apply.md`, `starts_after: bcg`) is added on every day from the day
   BCG prep finishes. Resolve the circularity this way: plan the day without apply. If BCG's last task
   lands that day, re-plan the day with apply included, which shrinks the prep budget. If BCG then no
   longer finishes that day, apply starts the next day.
9. Calendar event titles are the task's heading text, word for word, plus ` (part i/n)` when the task
   is split. The primary platform link goes in the event (`source.url` and the first line of the
   description).

### Derived rules (the builder's decisions, now binding)

> **Superseded in part by P7** (last section of this file). Anything below describing progress as
> `carryIn` minutes, `partsBefore`, `extraOccurrences` or `extraOccurrencesDelta` is history: progress
> is now durable state in the store, and `occurrences` counts sessions rather than a window of dates.
> The timing rules here (08:00, rests, block marks, fragments, splits, shift semantics) still hold.

- **Prep budget** per day = 480 min − (the lessons, portfolio and active recurring durations that day).
- **Splitting.** A task that crosses the 4-hour mark is split. Part 1 ends exactly at 4 h of task
  time, then comes the long rest, then part 2. A prep task that goes past the day's prep budget is
  split and continues first thing in the next day's prep slot. Parts are labelled `(part i/n)`.
- **Status.** Done and skipped tasks are excluded. A `repeat: daily` task has its status tracked per
  date (`taskUid@date`). `occurrences: N` means it appears on the first N plan days from the plan
  anchor date, which is stored and does not move.
- **Materialization.** The plan is stored as items. Checking an item never reshuffles today. When a
  task's status changes, days after today are regenerated, assuming today's still-pending items will be
  done. At the midnight rollover (daemon), the new day is regenerated from actual status, so anything
  left unfinished comes back first.
- **Shift by minutes or hours** (positive only). Every item of *today* whose start is ≥ now moves
  later by the amount. That includes rests, which keeps the 10-minute gaps and the 4h/1h/4h shape.
  An item already in progress keeps its times; the gap after it grows. An item whose shifted start is
  at or after 24:00 leaves today, and its task goes to the front of tomorrow's queue. Tomorrow is then
  regenerated from 08:00 under the normal rules. An item that starts before midnight but ends after
  it keeps its times.
  *(P1 round 3.)* A shift never leaves a hole in today's timeline. The gap it opens is rest time:
  the rest right after the gap starts earlier (for example, the 10-min rest after an in-progress
  task becomes 40 min for a +30 min shift), or else the rest right before it ends later (an
  in-progress rest). Two tasks with a gap between them get a new short rest. So a rest of today
  can be longer than 10 or 60 min after a shift; its kind and its place after 240 task minutes
  do not change. If tomorrow is a day off (after a days shift), carried tasks go to the next day
  that has work.
- **Shift by days.** *(Revised after P1 critique, rounds 1 and 3.)* Today keeps its past and in-progress
  items. A rest that is in progress also stays. All remaining work moves N days later than where it
  is now. This is done by regenerating from (the first date that still has work: today if work
  remains today, otherwise the first future day with work) + N, from 08:00, with today's remaining
  tasks as carry-in, in their original order. Days off that already exist stay off, so +1 day then
  +1 day equals +2 days. Every day then satisfies the 4h/1h/4h invariants again. Because generation
  is deterministic, the future plan is the old plan moved by N days.
- **Sessions lost to a shift.** A session is one date of a daily task, even if it is split at
  the 4h mark. A shift loses a session when the session's date keeps no part of it (it overflowed
  today, or its date became a day off). Each lost session of a task with `occurrences` is added
  back once, through `extraOccurrencesDelta`, so the task keeps all N sessions.
- **No fragments.** *(Added after P1 critique, round 1.)* `minPartMin` defaults to 15. No
  generated part is shorter than that.
  - At the 4h mark, part 1 would sometimes be shorter than the minimum. When it would, the
    generator looks ahead up to 3 pending tasks in the same prep track and places the first
    one that fits the remaining block time whole, or leaves both parts at the minimum or longer.
    Order inside a track is only a default, so this is allowed. If nothing fits, it splits
    anyway, but only at a length of at least the minimum.
  - At the end of a day's prep budget, a task is not split across days if it would fit whole
    in one day's prep budget. The generator fills the leftover budget with a look-ahead task
    from the same track that fits whole. If none fits, that prep time stays unused, which
    moves the lessons earlier; the rule is "≤ 480", not "= 480". Only tasks longer than a
    whole day's prep budget are split across days, and each piece is at least the minimum.
  - **Sections are ordering barriers.** Look-ahead may reorder only tasks that share the same
    section (nearest parent heading). A task is never placed before a pending task from an
    earlier section. Example: the skip test must come before the techniques it retires. If no
    legal arrangement avoids a short part, the fallback may split below `minPartMin`.
  - *(Revised after the P1 round-2 build.)* The strict version left about 60 h of prep time
    unused over the plan, which goes against "finish BCG as fast as possible". Change:
    a task of **≥ 90 min may be split across days when each piece is ≥ 45 min**
    (`minCarryPieceMin`, default 45). The look-ahead fill is tried first; the split is the
    fallback before leaving time unused. Tasks under 90 min are never split across days.
- **Daily items that overflow a minute or hour shift** are not carried, because tomorrow already
  has its own instance. Instead they are returned in `ShiftResult.dropped`. For a task with
  `occurrences`, a dropped instance is added back at the end, so it still gets all N sessions.
  The store keeps a per-task `extraOccurrences` count, which the generator takes as an input.
- Every shift and regeneration rewrites Google Calendar events: create, patch or delete, never
  duplicate.

## Parts

Every part has a builder and an independent critic. The critic gets only the running artifact,
this file's criteria for that part, and the reference. It returns PASS or FAIL with actionable
notes. **Matching the reference counts as a FAIL.** A part gets at most 3 rounds.

### P0 · Task sources and parser (done in step zero, critic pending)
*Better than Todoist means:* adding work is a text edit. Todoist needs per-task UI entry and has no
concept of a platform link, a duration and a type on each task at once.
- 100% of the HTML's links and cards survive into the `.md` and into the parsed objects (tests exist).
- A malformed drop-in file produces `file:line: message` and never stops the other files from loading.
- A new `.md` file with the schema shows up in `npm run tasks:check` with no code change.

### P1 · Scheduler engine (`packages/core/src/schedule`)
*Better than Todoist means:* Todoist Today is an unordered list with no times. Here, the question "what
do I do at 14:20, and until when" has exactly one computed answer that follows the rest rules.
- Unit tests prove all of these: the 08:00 start, every gap between consecutive tasks inside a block
  is exactly 10 min, the long rest is exactly 60 min and comes after exactly 240 min of task time,
  each day holds ≤ 480 min of task time, and the day order is prep, lessons, portfolio, recurring.
- The BCG→Salesforce→Anthropic handover happens mid-day. Apply appears from the day BCG finishes.
  The lessons task stops after 28 days.
- Shift tests cover minutes, hours and days, a shift that crosses the long rest, a shift that crosses
  midnight, an in-progress item, and repeated shifts. After every shift the rest-rule invariants still hold.
- A horizon of 7, 28 and 90 days all work with the same API. 90 days is generated in < 200 ms.
- Determinism: the same inputs always produce identical output, keys included.

### P2 · Store and API service (`packages/store`, `apps/api`)
*Better than Todoist means:* every change the UI can make is also a documented HTTP call that Claude
Code or a script can make, with the same result. Errors are typed and explain how to recover.
- Endpoints are listed in `docs/API.md` (the builder writes it). At minimum: health, today, plan
  (range), tasks (filters), task status (done/skipped/pending, per date for daily tasks), shift,
  regenerate, reload task files, sync trigger and status, calendar read-back, notifications log, and
  an SSE stream of changes.
- Status changes persist: they survive an API restart, and the next `GET /today` reflects them.
- Every mutation publishes an SSE event within 100 ms and queues a calendar sync.
- Errors are `{ error: { code, message, hint } }` with correct HTTP codes. An unknown uid gives 404 plus
  the closest uid in `hint`.
- The API binds to 127.0.0.1 only.

### P3 · Google Calendar sync (`packages/calendar`)
*Better than Todoist means:* Todoist's calendar integration shows tasks with no times or links. Here,
every study block shows up in Google Calendar at its real time, under its real task name, with a
one-click platform link, and follows every shift automatically.
- OAuth installed-app loopback flow. Scope `https://www.googleapis.com/auth/calendar.app.created`:
  the app can only see and edit calendars it created, which is narrower than `calendar.events` on the
  whole account. `.env` holds only `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The refresh token is
  stored in `.data/google-token.json` (gitignored).
- A dedicated calendar ("Study plan") is created once and its id is stored.
- Reconcile works on a window: insert what is missing, patch what changed, delete what has a
  plannerKey but is no longer planned. Events without a plannerKey are never touched.
- Verification: sync against a real throwaway calendar, read the events back through the API, and
  assert titles, links and times. Run sync twice more and assert zero inserts and zero duplicates.
  Shift by 1 h and assert the times moved and the event ids stayed the same. An in-process fake
  Google server covers CI.

### P4 · Notifier daemon (`apps/daemon`)
*Better than Todoist means:* Todoist sends one reminder per task, only if you set it. Here, every
boundary (task start, task end, rest start, rest end) fires a native OS toast with no setup, even
with no browser open.
- Native Windows toasts (node-notifier / SnoreToast), plus a JSONL log in `.data/notifications.log`.
- The clock can be injected. `PLANNER_CLOCK=start=2026-09-28T07:59:00,speed=600` runs a compressed day.
- Test: with the compressed clock over a whole generated day, every boundary fires exactly one
  notification of the right type, within 1 simulated minute of its time. Restarting the daemon does
  not fire duplicates.
- It follows plan changes (shift, check) within 2 s without a restart. It does not notify for items
  that are done or skipped.

### P5 · Daily view web UI (`apps/web`)
*Better than Todoist Today, observably, for this use case:*
1. **Now and next at a glance.** The current item is visually distinct, with time remaining and a
   live progress indicator. The next boundary is named ("Rest in 12 min"). Todoist has neither.
2. **The timeline is visible.** Start–end times, the 10-min and 1-h rests, and the long-rest band
   are shown with no clutter. Density is at least 9 task rows visible at 1440×900 at once. Todoist
   shows about 10 rows but no time structure.
3. **The round checkbox is at least as good as Todoist's.** It gives hover feedback. On click the
   circle fills with the track colour and a check appears within 100 ms (optimistic update). There is
   a completion sound-free micro-animation of 150–300 ms and an undo toast for 5 s. The change is
   persisted through the API and survives a reload.
4. **The platform link is one click** from the row (Todoist hides links inside task descriptions).
5. **Shift is 2 interactions or fewer** (+15m, +30m, +1h, +1 day, or custom), with a preview of the
   new end of day before you confirm.
6. **Keyboard-only flow:** j/k or arrows to move, x or space to complete, o to open the link, s to
   shift, u to undo, ? for help. Focus is always visible.
7. **Motion:** 150–300 ms, ease-out, no layout jank (CLS < 0.02), and it respects `prefers-reduced-motion`.
8. **Empty states** that name what comes next: before 08:00 ("Day starts at 08:00 with …"),
   everything done ("Done for today, tomorrow starts with …"), and API down (a clear message plus the
   command to start it).
9. **Contrast:** WCAG AA for all text in light and dark modes. At 390 px there is no horizontal
   scroll and tap targets are ≥ 40 px.
- Verification: Playwright screenshots at 1440×900 and 390×844 next to Todoist Today screenshots at
  the same sizes, a recorded checkbox interaction with timings measured, axe contrast checks, and a
  keyboard-only run.

### P6 · Plugin packaging, one command, docs (`plugin/`, root)
*Better than Todoist means:* Todoist's integrations need an account and token setup. Here, one
command starts everything, and Claude Code can drive the whole thing from the skill alone.
- `npm install && npm start` from a cold clone runs the API, the daemon and the UI. `npm run auth`
  does the Google OAuth.
- `plugin/.claude-plugin/plugin.json` and `plugin/skills/planner/SKILL.md` cover every endpoint,
  when to call it, and its failure modes (API down, not authorised, calendar sync failing, unknown
  uid, invalid shift).
- `CLAUDE.md` at the root covers the architecture, commands, conventions and task-file schema.
- Critic: a fresh Claude session with only the plugin loaded completes the scenarios "mark A1 done",
  "shift today 1 h" and "what's next" through the API with no other docs.

## Contract changes

- **P1, round 2:** `ScheduleConfig.minPartMin?: number` (optional, `DEFAULT_CONFIG.minPartMin = 15`) in
  `packages/core/src/schedule/types.ts`. No generated part is shorter than this (see "No fragments").
  No existing field changed.
- **P1, round 3:** `ScheduleConfig.minCarryPieceMin?: number` (optional, `DEFAULT_CONFIG.minCarryPieceMin = 45`).
  A task of at least twice this length may be split across days when nothing fits whole; each day's
  piece is at least this long.
- **P7:** `GenerateInput` gains `progress` and `sessionsHeld`; `carryIn` becomes `readonly string[]`
  (ordering only). Removed: `CarryIn` (and its `remainingMin` / `partsBefore`), `extraOccurrences`,
  `ExtraOccurrences`, `ShiftResult.extraOccurrencesDelta`. `ShiftInput` gains `heldDates` and
  `offUntil`. Store schema v4 adds `task_progress` and `sessions_held` and drops `extra_occurrences`.
  `PlanService.contextFor` is deleted; `regenerate` returns `clearedDaysOff`; `TaskView` gains
  `progress`. API: `GET /tasks*` returns `progress`, `POST /plan/regenerate` returns `clearedDaysOff`.

---

# P7 · Explicit task progress (replaces the inferred model)

P1 and P2 each failed three review rounds. Every surviving bug in both parts has the same root
cause, so they are fixed together here. **This section overrides anything above it that conflicts.**

## The defect

Nothing stores how much of a task is finished. It is re-derived on every call:

- `generate.ts` starts every task at its full duration (`rem.set(uid, durationMin)`). The only way
  to say "40 of this task's 150 minutes are done" is `carryIn[].remainingMin`, which the caller
  rebuilds each time.
- `planner.ts#contextFor` rebuilds it by scanning items before the regeneration date and summing the
  minutes of those whose **item** status is done or skipped — even when the **task** was later set
  back to pending. It then guesses completion with `remaining <= 0 || (inWindow && finalPart)`.

Consequences observed by the critics: a task reported pending but scheduled nowhere; a cross-day
split duplicated after a shift; Anthropic starting before Salesforce finished; lessons totalling 27
or 29 instead of 28.

## The model

Progress is first-class, durable state owned by the store.

```
task_progress(uid TEXT PRIMARY KEY, done_min INTEGER NOT NULL, parts_done INTEGER NOT NULL)
```

- **`done_min`** — the summed minutes of this task's parts that are currently marked `done`.
  Skipped parts contribute no minutes.
- **`parts_done`** — how many parts are marked `done`. It sets the part numbering of what follows.
- **Task status** (`pending` / `done` / `skipped`) stays separate and is what closes a task.
- **Remaining** = `durationMin − done_min`. A one-off task is scheduled **iff** its task status is
  pending **and** remaining > 0. These two facts alone decide it — never the shape of the plan.

Daily tasks do not use `done_min`. They use `sessions_held(uid, date)`, one row per date on which a
session was held (placed and now in the past, or done). That replaces `extra_occurrences`.

### Transitions (the store owns all of them)

| Action | Effect |
|---|---|
| item → `done` | `done_min += item minutes`, `parts_done += 1`. Task status becomes `done` **only** when `done_min >= durationMin`. Never close a task because the item carried the last part label: `part` is recomputed from the timeline, so letting it close a task lets a label override stored state — the exact disease P7 cures. Marking the last part of a split task done must leave the earlier minutes still to do. |
| item → `skipped` | Task status `skipped`. `done_min` unchanged. |
| item → `pending` (undo) | `done_min -= item minutes` (floor 0), `parts_done -= 1` (floor 0), task status `pending`. Then re-plan. |
| task uid → `done` | status `done`, `done_min = durationMin`, `parts_done` = its placed part count. |
| task uid → `skipped` | status `skipped`; `done_min` unchanged. |
| task uid → `pending` (undo) | status `pending`, `done_min = 0`, `parts_done = 0`. Then re-plan. |

Because remaining > 0 always implies "queued", **a pending task scheduled nowhere is unreachable**.

## Generator contract

`GenerateInput` gains, and the old inference inputs go:

```ts
/** Per one-off task uid. Absent = untouched. Drives remaining minutes and part numbering. */
progress?: ReadonlyMap<string, { doneMin: number; partsDone: number }>;
/** Per daily task uid: sessions already held before `from`. Counts toward `occurrences`. */
sessionsHeld?: ReadonlyMap<string, number>;
/** Uids to place first, in order. Ordering ONLY — it never carries minutes or part counts. */
carryIn?: readonly string[];
```

- `rem = durationMin − (progress.doneMin ?? 0)`; `partsBefore = progress.partsDone ?? 0`.
- `CarryIn.remainingMin` / `CarryIn.partsBefore` and `extraOccurrences` are **removed**.
- `assumeDone` stays: it is a projection ("treat today's still-pending items as done when
  regenerating later days"), not progress.
- A daily task with `occurrences: N` is placed until `sessionsHeld + placed == N`, skipping days off.
  The count is of **sessions**, never of a date window, so a shift can neither lose nor add one.

### Track order (hard rule 7, restated so it cannot be bent)

Compute the open prep track once per day fill: the lowest-`priority` prep file that has any task with
remaining > 0. **Only that track's tasks are eligible for the prep slot**, whatever the look-ahead or
split bookkeeping says. A task being mid-split never makes its track look finished.

## Store and API rules

- **`replan(from)`** — used by every status change and undo. Regenerates from `from` and
  **preserves days off**.
- **`POST /plan/regenerate`** — the explicit user action. It alone may clear days off, and the
  response says which dates it cleared.
- Regenerating from date `D` deletes **pending** items before `D` that belong to tasks still having
  remaining work (they were never done, and are being re-placed with fresh part numbers). Done and
  skipped items before `D` are immutable history.
- `contextFor` is deleted. The store reads `task_progress` and `sessions_held` and passes them
  straight through.

## Invariants (must be tests, not prose)

1. Every pending task with remaining > 0 appears on the plan within the horizon.
2. Across all its items, a task's done minutes never exceed its duration, and no task is placed twice
   for the same minutes.
3. A daily task with `occurrences: N` has exactly `N` sessions held-plus-planned, after **any**
   sequence of status changes, shifts, undos and regenerations.
4. A prep track never starts while a lower-`priority` prep track has remaining work.
5. Any status change followed by its undo returns the plan to a state where the task is pending and
   scheduled — never pending and absent.
6. `replan` never clears a day off; only `POST /plan/regenerate` does.

---

# P8 · Pause and Resume

A pause freezes the plan while you step away, then pushes everything still to come forward by
exactly how long you were gone.

## Behaviour

- **`POST /plan/pause`** records the instant, to the millisecond. Nothing on the plan moves.
- **`POST /plan/resume`** measures the elapsed time and shifts the plan forward by exactly that
  much, then clears the pause.
- The pause survives a restart: it is stored, not held in memory.

## Rules

1. **Exact, not rounded.** The elapsed time is measured in milliseconds and the shift applies that
   exact amount. Responses report `pausedSec` as seconds with a fractional part (45.317). A pause of
   45 s moves everything by 45 s, never by a rounded minute.
2. **Durations and order never change.** The cut point is the **pause** instant, not the resume
   instant: every item whose start is at or after the moment you paused moves, and they all move by
   the same amount — so every duration, every gap and the order are
   preserved exactly. An item already under way keeps its times: you lose the paused seconds from
   that one task, which is the only way to honour rule 2. Nothing that had not begun when you paused
   is allowed to run while you are away: a task due to start during the pause moves by the full
   pause, rather than being treated as already started. The widened gap before the next item
   becomes rest time, under the existing gap-to-rest rule.
3. **The rest rules still hold afterwards.** Because every remaining item moves by one amount, the
   10-minute gaps and the 240 → 60-minute long rest survive unchanged. An item pushed past midnight
   follows the normal overflow rule.
4. **While paused the plan is frozen.** `POST /plan/shift` and `POST /plan/regenerate` answer
   `409 PAUSED`. Status changes (done, skipped, undo) still work and still re-plan later days —
   ticking something off is not moving the schedule.
5. **No notifications while paused.** The daemon fires no task or rest boundary while the plan is
   paused; it records nothing for those instants, so resuming does not replay them.
6. **A resume moves the rest of today.** Later days already start at 08:00 (hard rule 1), so there
   is nothing to push them by; the horizon after today is regenerated as usual. Say so in the README
   and the skill, because "all upcoming events" invites the other reading.
7. **Google Calendar follows.** Resume queues the usual sync, so the events are rewritten to the new
   times. A pause alone changes nothing, so it syncs nothing.
8. **Limits.** `pause` while already paused, and `resume` while not paused, are `409 CONFLICT` and
   include the current state. A pause longer than 24 h resumes with `400 INVALID_INPUT` and a hint to
   use a day shift instead, and the failed resume leaves the pause in place so nothing is lost.
   *(Corrected after the build: as first written, rules 4 and 7 deadlocked — a pause past 24 h could
   neither be resumed nor escaped, because the day shift the hint names was itself frozen. So a pause
   past 24 h is still reported and still blocks a second `pause`, but stops freezing the plan, and the
   next successful shift or regenerate clears it.)*
9. **One definition of "paused right now."** The API and the daemon must never disagree about it, so
   the freshness rule lives in the store (`PlannerStore.freshPausedSince`) and both processes read it
   there. Re-deriving it anywhere else is a bug: a second copy is how a pause someone forgot about
   came to silence every notification indefinitely while shifts were already being allowed again.

## Surface

- `GET /health` and `GET /today` carry `paused: { since, elapsedSec } | null`.
- `POST /plan/pause` → `{ paused: { since } }`.
- `POST /plan/resume` → `{ pausedSec, moved, endOfDay, day }`.
- The web UI's Pause button becomes **Resume** while paused, shows how long the pause has run, and
  the timeline reads as frozen. It returns to **Pause** on resume.

## Invariants (tests, not prose)

1. Pause then resume after *d* ms moves every item starting at or after the **pause** instant (the
   cut, per rule 2) by exactly *d* ms, and moves nothing else. The one exception is the rest directly
   after the item under way, which keeps its start and absorbs the pause in its end (gap-to-rest).
2. Durations, the order of items, and every gap between remaining items are byte-identical before
   and after.
3. All day rules still hold after a resume, including a pause that spans a rest, the long rest and
   midnight.
4. The pause state survives a restart, and a resume after a restart still uses the original instant.
5. No boundary notification fires for an instant inside a pause.

---

# P9 · Write-back: plan and task mutation APIs

Until now the Markdown was read-only: the service parsed it and never wrote it, and `CLAUDE.md` could
say "status is never stored in Markdown". P9 keeps that rule and adds the other direction — Claude Code
can create, update and delete **tasks** and **plans**, and every such change is written back into the
`.md` file, so the file never falls behind the schedule it generated.

Two nouns, deliberately separated, because the owner's request uses both:

- A **plan** is one task file in `resources/` — one track, its front matter, its prose. `bcg.md` is a plan.
- A **task** is one heading plus its ` ```task ` block inside a plan.

Everything else that already mutates the schedule (status, shift, pause, regenerate) is unchanged and
still writes **no** Markdown, because none of it is file state. The dividing line is exactly this:

> **If a change would survive `POST /reload`, it belongs in the Markdown. If `POST /reload` would wipe
> it, it belongs in SQLite.** Duration, title, type, links, repeat, order, front matter: Markdown.
> Done, skipped, progress, days off, the pause: SQLite. Nothing is written to both.

## Why a writer and not a serializer

The obvious implementation — parse to `Task[]`, mutate, re-render the file — is forbidden. These files
are not data dumps. `bcg.md` is 1087 lines of which the tasks are a small part: a hand-written contents
list, prose explaining what the assessment is, tables, `python` code fences, "Transfers to:" notes. A
round-trip through the parser keeps `Task.body` but loses layout, and keeps nothing that belongs to no
task. Re-rendering would silently destroy the document the owner spent the effort writing.

So P9 is a **surgical editor**: it changes the lines it was asked to change and leaves every other byte
of the file alone. "Every other byte" is the acceptance criterion, not a goal — see invariant 1.

## Spans

The editor cannot guess where a task lives, so the parser stops throwing that information away.
`Task` gains, all 1-based and inclusive:

```ts
span: {
  heading: number;      // the `### A1 · Boolean filtering` line
  blockOpen: number;    // the ```task fence
  blockClose: number;   // its closing fence
  end: number;          // last line of the body = the line before the next heading of <= level
}
```

The parser already computes all four to find `body`; it just discards them. Exposing them is the whole
change in `parse.ts`, and it means the editor never re-derives a position the parser already knew —
the P7 lesson, applied to file offsets.

## What is better than editing the file by hand

The reference is the owner opening `bcg.md` in an editor, because that is the alternative. Observable,
and all of these are things the hand cannot do:

1. **A bad edit cannot reach disk.** Hand-editing `duration: 40` instead of `40m` leaves a broken file
   that parses fine as YAML and fails at the next reload, possibly days later. P9 re-parses the
   *proposed* text before writing and rejects with the same `file:line: message` the parser would have
   produced, having written nothing.
2. **The schedule follows immediately.** A hand edit does nothing until someone remembers `POST /reload`.
   A P9 edit regenerates the affected days and queues the calendar sync in the same call, and reports
   which dates moved.
3. **The state follows too.** Deleting a task by hand orphans its progress, its held sessions and its
   calendar events. P9 removes them in the same transaction.
4. **It is reversible.** Every write snapshots the previous file first, so a wrong delete is recoverable
   without git. Hand-editing has no undo once the editor is closed.
5. **It can be previewed.** `dryRun` returns the exact unified diff and the dates that would regenerate,
   with nothing written. There is no hand equivalent short of a scratch copy.

## Endpoints

Plans:

| Method and path | Body | Effect |
|---|---|---|
| `GET /plans` | — | `{ plans: [{ track, path, title, kind, priority, tasks, startsAfter, defaultDurationMin }] }` |
| `GET /plans/:track` | — | The plan's front matter, its tasks and its raw Markdown. |
| `POST /plans` | `{ track, title, kind, priority?, defaultDuration?, startsAfter?, intro? }` | Creates `resources/<track>.md` with front matter and no tasks. |
| `PATCH /plans/:track` | any subset of `{ title, kind, priority, defaultDuration, startsAfter }` | Rewrites only those front-matter keys. |
| `DELETE /plans/:track` | — | Deletes the file and every task, status, progress and calendar event it owns. Requires `?confirm=<track>`. |

Tasks:

| Method and path | Body | Effect |
|---|---|---|
| `POST /tasks` | `{ track, id?, title, duration, type, links?, repeat?, occurrences?, body?, section?, after? }` | Inserts a task. `after` is a task uid to place it behind; default is the end of its section. |
| `PATCH /tasks/:uid` | any subset of `{ title, duration, type, links, repeat, occurrences, body, section }` | Rewrites only what changed. |
| `DELETE /tasks/:uid` | — | Removes heading, block and body, and the task's stored state. |

Every mutating call accepts `dryRun: true` and `?dryRun=true`, and every one returns the same envelope:

```
{ plan|task, diff, file, regenerated: string[], backup, sync: "queued"|"skipped" }
```

`diff` is a unified diff against the file as it was. It is returned on real calls too, not just dry
runs, so the answer always says exactly what was done to the document.

## Rules

1. **Markdown first, and only once it is known to be good.** Every mutation is: validate the request →
   build the new text in memory → **re-parse that text** → confirm it yields the intended task →
   snapshot the old file → write atomically (temp file in the same directory, then rename) → reload →
   regenerate → queue sync. The re-parse is not a formality: it is what makes rule 2 true.
2. **No partial writes, ever.** If any step before the rename fails, the file on disk is byte-identical
   to before. If the reload after the rename fails — which would mean the editor produced text that
   parses in isolation but breaks the set, e.g. a duplicate uid across files — the snapshot is restored
   and the call fails. A mutation either happens completely or not at all.
3. **`id` is immutable.** The uid `track/id` is what stored progress, plan-item keys and the calendar's
   `plannerKey` all key on, so renaming one would have to migrate three stores and every existing
   Google event. `PATCH` rejects `id` with a hint to delete and re-create. The title is free to change;
   it is the event summary, not the identity.
4. **A delete is a delete everywhere.** `DELETE /tasks/:uid` removes the Markdown section, then
   `task_status`, `plan_items`, `task_progress`, `sessions_held` and `extra_occurrences` for that uid,
   in one transaction.
   > **As built.** `extra_occurrences` no longer exists: schema v4 dropped it when progress became
   > first-class (P7). The five tables the delete actually clears are `task_status` (the bare uid
   > **and** every `uid@date`), `plan_items`, `task_progress`, `sessions_held` and `notifications` -
   > the last because a notification keys on an item key, and a task's rows there would otherwise
   > outlive it in `GET /notifications`. They are matched on the key's shape (`%|uid|%`), not by
   > joining on `plan_items`, because an item key that stopped existing earlier - a re-split after a
   > duration change, a purged past-pending item, a rollover - leaves no row to find it from. The next reconcile deletes its calendar events because its items no longer exist.
   A deleted task leaves nothing behind that a later `POST /reload` could resurrect.
5. **Deletes are confirmed and recoverable.** `DELETE /plans/:track` requires `?confirm=<track>` so a
   mistyped path cannot destroy a 1000-line file. Both deletes snapshot first. Snapshots live in
   `.data/taskfile-backups/<track>.<iso>.md`, newest 20 per track kept, listed by `GET /backups` and
   restored by `POST /backups/:name/restore`.
6. **Blank lines are normalised, never multiplied.** Removing a section leaves exactly one blank line
   between its neighbours; inserting one surrounds it with exactly one. A sequence of edits must not
   make the file drift.
7. **The contents list is not maintained.** `bcg.md` has a hand-written table of contents pointing at
   `##` sections; tasks are `###` and are not in it. Deleting a *plan* removes the whole file, so no
   dangling entry survives. Editing a task cannot touch it. If a future edit ever moves `##` headings,
   this rule has to be revisited — it is recorded here so the omission is a decision, not an oversight.
   > **As built**, one edit does add a `##` heading: a `section` that does not exist is created at the
   > end of the file (`POST /tasks` with an unknown `section`, and a `section` move). The premise above
   > therefore holds for every edit *except* that one, where the new section is absent from the
   > contents list. It is reported in `warnings` rather than fixed, because guessing where a
   > hand-written list wants its new entry is worse than saying plainly that one is missing.
8. **Only under `resources/`.** Every resolved path is checked to be inside the task directory and to
   end in `.md`, after symlink resolution. A `track` that is not `[a-z0-9][a-z0-9-]*` is rejected, so
   no request can name `../../.env`.
9. **The daemon never sees a half-written file.** Writes are atomic renames, which is what makes the
   second reader safe without a lock.

## Invariants (tests, not prose)

1. **Byte fidelity.** For every file in `resources/` and every supported edit, the diff between before
   and after touches only lines inside the intended span. A test asserts this by reconstructing the
   file from the diff hunks: all unchanged lines are identical, including trailing whitespace.
2. **Rejected means untouched.** For a set of invalid requests (bad duration, unknown type, duplicate
   id, unknown uid, bad track name, path traversal), the file's bytes and mtime are unchanged and the
   error carries the parser's own `file:line: message` where one applies.
3. **Round-trip.** After any accepted mutation, re-parsing the file yields a task equal to the one the
   API returned, field for field.
4. **State follows.** After `DELETE /tasks/:uid`, no row in any of the five tables mentions the uid, and
   `GET /plan` over the whole horizon contains no item for it.
5. **Calendar follows.** After a mutation and its sync, a second sync reports `inserted: 0, patched: 0,
   deleted: 0` — the P8 idempotency property, re-asserted because P9 is a new way to reach it.
6. **Drift.** Applying 200 random mutations (create, update, delete, interleaved with shifts and status
   changes) and then reloading leaves the store exactly as the files describe: every task in the files
   is scheduled, no scheduled task is missing from the files.
   > **As built** in `apps/api/test/p9.test.ts`, "200 random mutations…": a seeded xorshift32 picks
   > the operation, the track, the uid and the patch, so a failure is reproducible; the files and the
   > store are compared every ten operations and at the end; the reload afterwards must change
   > nothing; and the test asserts that every kind of operation actually ran at least once, so the
   > mix cannot silently stop exercising one.
7. **Dry run writes nothing.** Byte and mtime equality after `dryRun`, and the diff it returned equals
   the diff the real call then produces.


# Active hours

The owner's working window. Three settings, one pair of them a fence and the third a budget:

| Setting | Default | Meaning |
|---|---|---|
| `dayStart` | `08:00` | the earliest a day may begin |
| `dayEnd` | `24:00` | hard stop; nothing is placed past it |
| `dailyTaskMin` | `480` | minutes of **task time** a day holds, rests excluded |

One setting for every day — no per-weekday variants. The defaults reproduce the original rules
exactly, so a planner that never touches this behaves as it always did.

## What they do and do not change

- **The rest rules are untouched.** A 10-minute rest between consecutive tasks, and a 1-hour long
  rest after every 240 minutes of task time. Raising `dailyTaskMin` to 600 therefore produces three
  blocks with long rests at 240 and 480, not one longer block.
- **Whichever binds first wins.** A budget of 600 inside an 08:00–20:00 window yields 480, because
  the window cannot hold the extra long rest the 481st minute requires.
- **Work that does not fit before `dayEnd` moves to the next day.** It is never dropped: the minutes
  stay in the generator's remaining-work map, so the following days place them.
- **A window must lie inside one calendar day**: `dayStart` < `dayEnd` ≤ `24:00`. A window that wraps
  midnight (`22:00`–`02:00`) is refused, because every key in the system — plan items, statuses,
  rests, calendar events — carries the calendar date, and a day spanning two dates would break all
  of them.
- **The fence governs new work, not history.** Narrowing the window cannot retroactively unschedule
  this morning: past and in-progress items keep their times, exactly as they do for a shift or a
  regenerate. The fence is absolute from tomorrow on.

## The clock cost of work is stepped

The one genuinely surprising property, and the reason `GET /settings` reports an `effective` figure:

| `dailyTaskMin` | long rests | a day from 08:00 ends |
|---|---|---|
| 480 (8 h) | 1 | ~18:40 |
| 510 (8.5 h) | 2 | ~20:20 |
| 600 (10 h) | 2 | ~22:20 |

Thirty more minutes of work costs **1 h 40** of clock, because crossing the 480-minute mark buys a
second hour-long rest. A window has to clear a step to be worth widening, which is why asking for
10 h inside a 12-hour window silently grants 8 h. `GET /settings` reports what the window actually
grants (`effective.dailyTaskMin`) and which of the two constraints is binding (`effective.boundBy`),
so a UI never shows only the request.

Beyond roughly 11 h of task time no calendar day can hold the result at all; the setting is still
accepted, because it is a budget rather than a promise, and the fence decides the outcome.

## Where it lives, and how it is enforced

- **One definition.** `PlanService.config()` is the only place a `ScheduleConfig` is built, and it
  reads the hours from the store on every call — never cached, because the API and the daemon hold
  separate `PlanService` instances and a cache would let one keep planning with hours the other had
  already changed.
- **Stored in SQLite** (`meta.active_hours`, JSON), so it survives a restart of either process and a
  change bumps `plan_rev`, which is how the daemon notices within its tick. It is *not* Markdown: it
  is not a property of any task file. A stored value that no longer parses or validates falls back to
  the defaults rather than making every read throw.
- **Enforced in the core**, in `fitDay`. How much task time a window holds is not a function of the
  window — it depends on how the work divides into tasks, because every boundary costs a rest — so
  the day is planned, its end is examined, and if it overshoots, the largest budget that fits is
  found by bisection. Only an attempt whose last item ends at or before the fence is ever returned,
  so no plan can contain an item past it, whatever the search does.
- **Bisection, not subtraction.** Subtracting the overshoot is wildly wrong at the small end, because
  removing task minutes also removes the rests between them: a 45-minute window asked to hold a
  480-minute day overshoots by about 9 h, and one subtraction lands on zero — so the day came out
  empty when a single 45-minute task fitted perfectly. That was a real bug, found by a test asserting
  a one-task-wide window still makes progress every day.
- **It replaced the midnight loop.** `regenerateToday` used to generate, check whether the day ran
  past midnight, lower a cap and retry. `dayEnd` defaults to `24:00`, so that loop was the same rule
  written twice; it is gone, and the core's fence covers every day rather than only a partial rebuild
  of today.

## API

| Method and path | Body | Effect |
|---|---|---|
| `GET /settings` | — | `{ activeHours, defaults, timeZone, effective: { dailyTaskMin, boundBy, lastEnd } }` |
| `PATCH /settings` | any subset of `{ dayStart, dayEnd, dailyTaskMin }` | Validates, stores, rebuilds **today and the future**, queues the sync. `dryRun` validates and writes nothing. |

`GET /health` carries `activeHours` too, so one call is enough to know how the day is shaped.
A change rebuilds today as well as the future — unlike a task edit, which leaves today alone — because
a setting about *when the day runs* would look broken if it waited until tomorrow to take effect.

## Invariants (tests, not prose)

1. **The defaults change nothing.** The plan generated with the defaults is identical, item for item,
   to the plan before active hours existed.
2. **Nothing past the fence.** For every window and every day, no item ends after `dayEnd`.
3. **Nothing before the start.** No item begins before `dayStart` on a day that is generated whole.
4. **No item on the wrong date.** Every item's own `date` equals the day it is stored under, for every
   window including a 21:00 start that would once have spilled past midnight.
5. **Deferred, not dropped.** A fenced plan schedules a subset of the days' work and the same tasks,
   further out; no task is placed twice and none disappears.
6. **The rest rules survive.** Long rests sit exactly on multiples of 240 task minutes, long rests are
   60 minutes and short ones 10, at every budget from 4 h to 14 h.
7. **Progress every day.** A window one task wide still places one task a day rather than stalling.
8. **Refused, not guessed.** An end before the start, a wrapping window, a window too short for one
   task, and a non-integer or out-of-range budget are all `400 INVALID_INPUT`, and nothing is stored.
9. **Durable and shared.** The setting survives a restart, and a second `PlanService` on the same
   database reads the same value, including after a change it did not make.


# Carry-forward (amendment to P7)

The owner's words: *"automatically put the pending task to the next day ... even if it affects the
program length ... basically the tasks work sequentially"*, and *"don't remove the skip option"*.

Most of this was already true. The parts that were not are recorded here.

## What already held

- **One-off work carries forward untouched.** The midnight rollover deletes every pending item on a
  past date and re-places the task's remaining minutes at the front of the next day's queue with
  fresh part numbers. Verified against the real `resources/` folder: four consecutive days ignored
  cost **0 minutes** of the 219 h of one-off work owed.
- **There is no programme end to run past.** The horizon is a *rolling* window (`today + horizon - 1`,
  extended by `meta.plan_to`), not a fixed four weeks. Neglect makes the plan reach further out; it
  cannot overflow it.
- **`skipped` is unchanged** and remains the only way to spend a task without doing it.

## What was wrong, and is now fixed

### 1. A capped daily series burned a session on a day that merely went by

`sessions_held` counted a session as held "on a date that ran (it is in the past, whatever its
status)". So four ignored days cost four of `lessons.md`'s 28 sessions, permanently — the opposite of
carrying the work forward.

**Now a session is held only when it is acted on**: `done`, or `skipped`. A date that passed with the
session pending consumed nothing, so the series slides and finishes later. Four ignored days now cost
**0 of 28**.

Two places had to agree, and only one of them is "status is not pending":

- `harvestSessions` records the durable row, and records only closed sessions.
- `sessionsHeldFor(from)` counts what is already spoken for before `from`, which is a closed session
  **or any date from today on** — because `purgePast` only deletes pending items *before* today and
  `replaceFrom` only rewrites dates from `from` on, so today's standing session survives and is
  already accounted for. Dropping that second case counted today's session as free and handed out a
  29th, which showed up as a 28-session series being planned across 56 days.

### 2. An undo of a future item left the rest of today running the wrong prep track

`replanFrom` re-planned from tomorrow when the undone item was in the future, so today kept the
layout it had while the task looked finished. Undoing work *grows* a task's remaining minutes, and
those minutes may belong to a higher-priority prep track than what is still scheduled for the rest of
the day — so hard rule 7 was violated until midnight.

This was **pre-existing**; fixing (1) is what made the state reachable, and the randomized 400-op test
found it: `beta/B5` placed on today while `alpha/A3` still had 240 minutes owed. The generated days
were correct — `alpha/A3` *was* placed first on the regenerated day — but today was never rebuilt.

**An undo now always re-plans from today.** `regenerateToday` keeps the past and in-progress items, so
history is untouched; only the part of today that has not started is re-timed. Hard rule 7 holds at
every instant.

## Invariants (tests, not prose)

`apps/api/test/carry-forward.test.ts`, against the real `resources/`:

1. **Nothing is lost.** After a day nobody touched, every unfinished one-off task is on the plan
   again and the minutes owed are identical to the minute.
2. **Neglect costs days, not work.** Four ignored days leave the work owed unchanged and the horizon
   end later than it was.
3. **A capped series slides.** Three ignored days spend 0 sessions and the series is still being
   handed out.
4. **Acting on it still spends it.** `done` spends a session; so does `skipped`.
5. **Skip is permanent.** A skipped one-off task reduces the work owed, does not return the next day,
   and is still skipped a week later.
6. **Sequential.** The task that led the abandoned day leads the next one; the queue is not reordered.


# Missed work, and what the day does about it (extends "Carry-forward")

The owner's words: *"Make the intra-day reflow automatic unless the user disables it and sets it to
don't do anything, just keep it with notification to keep him aware ... then he can specify whether
he skips it or sends the task to the next day."*

## The setting

`onMissed`, one more field of the active hours, applied to every day:

| Value | What happens when a task's slot goes by untouched |
|---|---|
| `reflow` **(default)** | The work leaves the past, the rest of the day is laid out again from now, and a notification says where it went. |
| `notify` | Nothing is touched. The notification says it is still pending and names the choices: do it, skip it, or let it roll over tonight. |

Neither value is "off": one re-times the day, the other leaves it alone *and tells you*. Work is
never lost either way - whatever is still pending at midnight carries to the next day, which is the
"Carry-forward" behaviour this builds on.

## Why reflow is a separate operation from `regenerate {from: today}`

`POST /plan/regenerate {"from":"today"}` **keeps the past exactly as it is** - including a task whose
slot went by untouched - and only re-times what has not started. That contract is documented, tested
and relied on, so it is unchanged.

A reflow does one more thing: it **reclaims** those missed tasks. They leave the timeline, their
minutes go back to the generator's pool, and they are re-placed later today if they fit and on the
following days if they do not. `PlanService.reflowToday()` is that operation;
`regenerateToday(reclaimMissed)` is the shared body, so there is one layout routine and two
documented meanings rather than two implementations.

Attempting it the other way round - making the reclaim unconditional inside `regenerateToday` - broke
ten tests at once, all of them pinning the existing contract. That is recorded here because the
failure was the useful part: the endpoint's promise to keep the past is load-bearing.

## What a reflow leaves behind

A reclaimed task vacates time that has already gone by, and that time cannot be filled. So the
rests that trailed the missed work go with it, the morning ends at the last thing that actually ran,
and a single **stretched rest** ("Rest (extended)") covers everything from there to now. The day
stays contiguous: the vacated time reads as time off, never as an unlabelled hole, and the day's
budget is not charged for work nobody did.

## Where it runs

The **daemon**, right after the boundary scan - because a task's own `task_end` is what makes it
missed, so it fires first and then the day reacts. Consequences:

- It needs the daemon running (`npm start` runs it). Without it the midnight rollover still carries
  the work; that is the behaviour that predates this setting, not a regression.
- **Nothing is missed while the plan is paused.** A slot going by during a pause is exactly what a
  pause means.
- **One notice per item per day**, deduplicated on `(item_key, "missed")`, so a day that reflows
  several times does not re-announce the same task. Everything detected in one tick is coalesced into
  one toast, so a daemon starting after a day away sends one notice, not nine.
- A reflow marks the calendar sync **pending** rather than running it on the spot. An idle day
  reflows roughly once per task duration, and rewriting the whole day in Google each time would be a
  lot of writes for a plan nobody is looking at; the retrier picks it up on its normal interval.
- `missed` is a notification type, not a boundary: it does **not** obey the scanner's grace window,
  because it is precisely a notice about something already stale. `BoundaryType` was split from
  `NotificationType` so the scanner still deals only in edges.

## Invariants (tests, not prose)

`apps/daemon/test/missed.test.ts`:

1. **Reclaimed, not stranded.** Hours into an untouched day, no pending item is left entirely in the
   past, and the first task is running or still to come - in queue order.
2. **Contiguous.** Every item starts when the one before it ended, and any rest longer than an hour
   is named as extended.
3. **Honest budget.** Every minute still on the timeline is a minute that can actually be worked.
4. **Deferred, not dropped.** A whole day ignored under `reflow` loses no minutes and puts the
   overflow on later dates.
5. **`notify` touches nothing** - the day is byte-for-byte what it was - and still says what the
   choices are.
6. **`notify` still carries at midnight.**
7. **Done and skipped are never "missed".**
8. **Paused means nothing is missed**, and the frozen plan is untouched.
9. **Read live**: switching to `reflow` mid-day reflows on the next tick, with no restart.
