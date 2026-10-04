# CLAUDE.md

**Daymark** — a local study-planner service. Markdown task files become a daily plan with fixed rest
rules.
The plan is synced to a dedicated Google Calendar, shown in a web UI, and announced with
native desktop notifications. It runs without Claude Code. Claude Code is only an HTTP client,
through the plugin in `plugin/`.

## Architecture

```
resources/*.md ─▶ packages/core      parser (taskfile/) + scheduler (schedule/): pure TS, no I/O
                  packages/store     SQLite (node:sqlite, WAL) at .data/planner.db, shared clock helper
                  packages/calendar  Google auth + reconcile. Two credentials, same client interface:
                                     a service-account key (.data/google-service-account.json, scope
                                     calendar.events, never expires) writing into the calendar named by
                                     CALENDAR_ID, or OAuth installed-app (scope calendar.app.created)
                                     with a calendar the planner creates and owns. A key present wins.
                  apps/api           Fastify on 127.0.0.1:4317, owns every write, SSE at /events
                                     (taskfiles.ts: the plan/task mutation endpoints that write the .md files back)
                  apps/daemon        notifications (task/rest start/end), midnight rollover, sync retries
                  apps/web           Next.js + shadcn/ui + Tailwind + motion on 127.0.0.1:3417, API client only (fetches /today in the browser)
                  plugin/            Claude Code plugin (skills/planner/SKILL.md documents the API)
```

- The API and the daemon are separate processes. They share state only through SQLite.
- The web UI and Claude Code talk only to the API.
- The API contract is `docs/API.md`. The scheduling rules and each part's acceptance criteria
  are in `docs/PLAN.md`, which is binding. Read both before changing behaviour.

## Commands

```sh
npm install                      # once, at the repo root (npm workspaces)
npm start                        # preflight (scripts/preflight.mjs: loads .env, inits the store, builds the web UI if stale, writes .data/runtime.json), then API + daemon + web UI (next start)
npm run dev                      # same with next dev + tsx watch, no web build
npm run auth [-- --no-browser]   # one-time Google OAuth (needs .env, see docs/GOOGLE_SETUP.md)
npm test                         # every workspace's tests
npm run tasks:check [-- <path>]  # validate task files
npm run dev:mock -w @planner/web # UI against the fixture API (no backend needed)
claude plugin validate plugin    # check the Claude Code plugin manifest (repo root has .claude-plugin/marketplace.json)
```

`scripts/start.mjs` runs the three processes with concurrently (kill-others-on-fail). Ports:
`PLANNER_API_PORT` (4317) and `PLANNER_WEB_PORT` (3417); it derives `PLANNER_API` for the web UI and
`PLANNER_WEB_ORIGINS` for the API's origin guard from them.

Tests use vitest; the web UI uses Playwright (`npm test -w @planner/web`). Clocks can be injected:
`PLANNER_NOW=<iso>` fixes the time, and `PLANNER_CLOCK=start=<iso>,speed=<n>` compresses it.

## Conventions

- TypeScript with ESM, run by `tsx`. There is no build step for the backend packages. Imports
  use `.ts` extensions.
- `packages/core` stays pure: no filesystem access outside `taskfile/load.ts`, no clock reads,
  no network. Every time goes in as an input.
- Times are ISO-8601 strings with the local offset. Dates are `YYYY-MM-DD` in the planner's zone
  (`PLANNER_TZ`, default the system zone). Use the helpers in `packages/core/src/schedule/time.ts`
  and never `Date` arithmetic on wall-clock times, because DST happens inside the plan.
- **Active hours** are the owner's working window: `dayStart` (08:00), `dayEnd` (24:00 = no fence)
  and `dailyTaskMin` (480 minutes of task time). They live in SQLite (`meta.active_hours`), are read
  through `PlanService.config()` - the only place a `ScheduleConfig` is built - and are never cached,
  because the API and the daemon hold separate services. The rest rules are not settable: a long rest
  still follows every 4 h of task time, so a bigger budget makes more blocks, not longer ones. The
  fence is enforced in `packages/core`'s `fitDay`, which bisects for the largest budget the window
  holds; it replaced the midnight retry loop that used to live in `regenerateToday`, so there is one
  definition of where a day has to end. See docs/PLAN.md, "Active hours".
- **Unfinished work carries itself forward.** The rollover deletes pending items on past dates and
  re-places the work at the front of the next day. A daily session is held only when it is **acted
  on** (done or skipped), never because its date went by, so an ignored day slides a capped series
  rather than spending one of its `occurrences`. Two places must agree on "held": `harvestSessions`
  (closed only) and `sessionsHeldFor` (closed, **or** any date from today on, because the purge only
  takes pending items from *before* today). An undo always re-plans from today, because the minutes it
  frees may belong to a higher-priority prep track than what is still scheduled for the rest of the
  day. See docs/PLAN.md, "Carry-forward".
- **A missed task** - its slot went by while it stayed pending - is handled by `onMissed`, one more
  active-hours field: `reflow` (default) reclaims the work and lays the rest of the day out again from
  now, `notify` changes nothing and only says so. Both notify; work is never lost either way. It runs
  in the **daemon**, after the boundary scan, and is skipped while paused. `reflowToday()` is a
  distinct operation from `regenerate {from: today}`, which keeps the past by contract - they share
  `regenerateToday(reclaimMissed)`. `missed` is a notification type, not a `BoundaryType`, and is
  exempt from the scanner's grace window. See docs/PLAN.md, "Missed work".
- Keys are stable:
  - task uid: `track/id`
  - plan item: `date|uid|part`
  - rest: `date|rest|n`

  Calendar events store the item key in `extendedProperties.private.plannerKey`, which is how sync
  stays idempotent. Never change a key format without migrating the store and the calendar.
- API errors are always `{ error: { code, message, hint } }`.
- Secrets: `.env` is gitignored and holds only non-secret ids plus the OAuth client secret
  (`CALENDAR_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). The two credentials are **files** in
  `.data/`, which is gitignored whole: `google-token.json` (OAuth refresh token) and
  `google-service-account.json` (a private key that never expires). `.gitignore` also matches
  `*service-account*.json` anywhere in the tree, because a browser downloads it wherever it likes.
  `.env.example` is committed. Never print a credential's contents, and never read a key file to
  "check" it - `GET /health` reports `calendar.credential` without touching the secret.
- A **calendar the owner supplied** (`CALENDAR_ID`) is never created and never replaced, even on a
  404. The planner only creates a calendar when it is going to own it. The reason is asymmetric
  failure: a service account that created a calendar would *own* it, and an owned calendar does not
  appear in the owner's Google Calendar at all - so every sync would report success for ever while
  nothing ever showed up. A 404 on a configured calendar means a wrong id or withdrawn sharing, and
  is reported as such. The `calendar.events` scope cannot call `calendars.insert`, which makes this
  impossible rather than merely avoided.
- `tools/convert_html.py` was a one-shot migration. Do not re-run it, because the Markdown is now
  the source of truth.

## Task-file schema (summary; the full spec is in the README, "Task files")

- Front matter:
  - `schema: planner/task-file@1`
  - `track`
  - `title`
  - `kind` (`prep` | `lessons` | `portfolio` | `recurring`)
  - `priority` (prep only)
  - optional: `default_duration`, `starts_after`
- A task is any heading directly followed by a ` ```task ` block with:
  - `id`
  - `duration` (`40m`, `2h`, `2h30m`)
  - `type` (`coding` `concept` `build` `mock` `drill` `reading` `admin`)
  - optional: `link` (`"[label](url)"`, a bare URL, or a list), `repeat: daily`, `occurrences`
- The heading text is the calendar event title. The body runs to the next heading of the same or
  higher level.
- Status is never stored in Markdown. After editing files by hand, call `POST /reload` (or restart).
- The files are also written **back** by the plan and task mutation endpoints (P9). The dividing line:
  if a change would survive `POST /reload` it lives in Markdown (title, duration, type, links, repeat,
  order, front matter); if `POST /reload` would wipe it, it lives in SQLite (done, skipped, progress,
  days off, the pause). Nothing is written to both. Writes are surgical — the editor changes the lines
  it was asked to and leaves every other byte alone, because these files are hand-written documents,
  not data dumps — and atomic, so the daemon never reads a half-written file.
