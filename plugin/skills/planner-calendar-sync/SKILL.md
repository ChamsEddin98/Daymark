---
name: planner-calendar-sync
description: Check and drive the Google Calendar sync of the owner's study planner through the local service at http://127.0.0.1:4317 — GET /sync/status for the last result and any error, GET /calendar/events for what is actually in the calendar, and POST /sync to sync a window now. Also covers one-time OAuth with npm run auth and the CALENDAR_NOT_AUTHORIZED (503) and CALENDAR_ERROR (502) answers. Use for "is my calendar up to date", "sync my calendar", "the events are wrong or missing", "why isn't it in Google Calendar", "re-authorise Google".
---

# Planner · Google Calendar sync

The planner owns a dedicated Google Calendar and rewrites it after every change on its own, debounced
by 2 s. **You never call Google Calendar directly** — not with a Google MCP tool, not with `gcloud`,
not with the Calendar API. Every calendar read and write goes through the planner API, because the
planner's reconcile is what keeps the events idempotent.

**Why.** Each event stores its plan-item key in `extendedProperties.private.plannerKey` (item key
`YYYY-MM-DD|<uid>|<part>`, rests `YYYY-MM-DD|rest|<n>`). That key is how sync knows which event
belongs to which plan item, so it can patch instead of duplicating. An event created or edited by
anything else has no `plannerKey`, so the planner cannot match it, and the next reconcile works
against a calendar it no longer understands.

Calendar state is **neither Markdown nor durable plan state**: it is derived. Nothing here writes a
`resources/*.md` file, and nothing in a task file describes an event.

## Calling the API

Base URL `http://127.0.0.1:4317` by default. Loopback only, no auth, JSON. Send
`content-type: application/json` when you post a body.

**Finding the port.** It is `PLANNER_API_PORT`, default 4317:

1. `.data/runtime.json` in the repo, written at every `npm start` / `npm run dev`:
   `{ "apiUrl": "http://127.0.0.1:4417", … }` — the *last* start, so confirm with `GET <apiUrl>/health`.
2. `PLANNER_API_PORT` in the environment or the repo's `.env` (the environment wins).
3. The `[preflight] API: http://127.0.0.1:<port>` line `npm start` prints.
4. The default, 4317. 5. Otherwise, ask the user.

**Always start with `GET /health`**: `calendar: { authorized, lastSyncAt, lastError, pending }` often
answers the question on its own. Connection refused (curl exit 7) on every candidate port means the
service is down — ask the user to run `npm start`. **Don't set a short `-m`/`--max-time`: a sync is
the slowest call in the API, and a slow answer is not a dead service.**

**Use the Bash tool with `curl -s`**, on every OS including Windows (Git Bash). Do **not** pass a
JSON body to `curl.exe` from Windows PowerShell 5.1: it strips the inner quotes, so
`'{"from":"2026-10-01"}'` arrives as `{from:2026-10-01}` and fails with `INVALID_INPUT`. PowerShell
fallback:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4317/sync' -ContentType 'application/json' -Body (@{ from = '2026-10-01'; to = '2026-10-08' } | ConvertTo-Json)
```

An error answer makes `Invoke-RestMethod` throw; the JSON body is in `$_.ErrorDetails.Message`.

**Identifiers.** Task uid `track/id` (`bcg/A1`), URL-encoded as `bcg%2FA1`. Item key
`YYYY-MM-DD|<uid>|<part>`, rests `YYYY-MM-DD|rest|<n>` — the same string that appears as an event's
`plannerKey`. Dates are `YYYY-MM-DD` in the planner's zone.

## Endpoints

| Endpoint | Body / query | When to call it | Returns |
|---|---|---|---|
| `GET /sync/status` | — | "Is my calendar up to date?" First call for any calendar question. **Never fails.** | `{ authorized, calendarId, lastSyncAt, lastAttemptAt, lastResult: { inserted, patched, deleted, unchanged }, pending, lastError: { code, message, at } }` |
| `GET /calendar/events?from&to` | dates | "What is actually in the calendar?" — reads the events back from Google, to compare with the plan. | `[{ eventId, plannerKey, summary, start, end, sourceUrl }]` (a bare array) |
| `POST /sync` | `{ from?, to? }` | Force a sync now: after a failed one, after re-authorising, or when the user wants the calendar correct this second. Default window is today to the end of the horizon. | `{ inserted, patched, deleted, unchanged, errors, calendarId, window: { from, to } }` |
| `GET /health` | — | `calendar.authorized`, `calendar.lastError`, `calendar.pending` in one call. | see `docs/API.md` |

```sh
curl -s http://127.0.0.1:4317/sync/status
curl -s "http://127.0.0.1:4317/calendar/events?from=2026-10-01&to=2026-10-08"
curl -s -X POST http://127.0.0.1:4317/sync -H "content-type: application/json" -d '{}'
curl -s -X POST http://127.0.0.1:4317/sync -H "content-type: application/json" \
  -d '{"from":"2026-10-01","to":"2026-10-08"}'
```

## How the sync behaves

- **Every mutation queues its own sync**, debounced by 2 s: a status change, a shift, a resume, a
  regenerate, a reload, and every Markdown write-back (create / update / delete of a task or a plan).
  So you rarely need `POST /sync` — reach for it after a failure, after `npm run auth`, or when the
  user asks for it now.
- **Idempotent.** A second sync of an unchanged plan reports `inserted: 0, patched: 0, deleted: 0`
  and everything in `unchanged`. If a repeated sync keeps patching, that is a defect worth reporting,
  not something to paper over by syncing again.
- **Events carry whole seconds.** The plan keeps exact milliseconds (after a resume every upcoming
  item sits mid-minute), but event times are floored to the second, because Google stores no finer.
  Drift detection compares with a 1 s tolerance, so two resumes inside the same second write nothing
  at all.
- **Checked items are left alone.** A done or skipped item that lost its slot is never passed to
  reconcile as a new placement: if it already has an event, that event stays at `lastStart`/`lastEnd`
  — not patched, not deleted; if it has none, none is created.
- **A deleted task's events go on their own.** The next reconcile deletes them because its items no
  longer exist (`study-planner:planner-delete`).
- **`pending` stays `true`** after a failed sync until one succeeds. `lastAttemptAt` is when it last
  tried, `lastSyncAt` when it last succeeded.
- `GET /sync/status` and `GET /health` **never fail**: if the Google client cannot even be constructed
  (no token, or a corrupt or unreadable one), `calendar.authorized` is `false` and the reason is
  logged. The underlying error only surfaces from `POST /sync`.

## Authorisation

- `calendar.authorized: false` means calendar sync is **off**, not that the planner is broken: every
  local change still works and is still recorded. Say that explicitly.
- Fix: the user runs **`npm run auth`** once from the repo root (add `-- --no-browser` on a headless
  box); see `docs/GOOGLE_SETUP.md`. It needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.
  The refresh token is written to `.data/google-token.json`. It is an installed-app OAuth flow with
  the scope `calendar.app.created`, so the planner can only touch the calendar it created.
- Never ask for, print or copy the client secret or the refresh token. **Don't run `npm run auth`
  yourself** — it is interactive and belongs to the user.
- After they have authorised, call `POST /sync` to fill the calendar, then report the result.

## Diagnosing "the calendar is wrong"

1. `GET /sync/status` — is it `authorized`, is `pending` true, what is `lastError`, when was
   `lastSyncAt`?
2. `GET /health` — is the plan paused (a pause queues no sync, so the calendar is deliberately
   behind until the resume)?
3. `POST /sync` for the window in question, and read the counts.
4. Still wrong: `GET /calendar/events?from&to` next to `GET /plan?from&days`
   (`study-planner:planner-read`) and compare by `plannerKey`. Report what differs — an event with no
   `plannerKey` was created outside the planner and the planner will not manage it.
5. Tell the user what you found; **don't repair Google Calendar by hand.**

## Errors

Always `{"error":{"code","message","hint"}}` — show the `hint`.

| Code (HTTP) | Meaning | What to do |
|---|---|---|
| connection refused | The service is down. | Ask the user to run `npm start`. |
| `CALENDAR_NOT_AUTHORIZED` (503) | Sync was requested before `npm run auth`, or the token is missing or revoked. **Local state is still updated.** | Say the local change succeeded, then ask the user to run `npm run auth`. |
| `CALENDAR_ERROR` (502) | Google returned an error after retries. `details` holds Google's status/reason, or the partial sync result when single event writes failed. **Local state is still updated.** | Report it; the sync retries on its own, or `POST /sync` later. |
| `INVALID_INPUT` (400) | A bad `from`/`to`. | Fix the dates (`YYYY-MM-DD`). |
| `FORBIDDEN_ORIGIN` / `FORBIDDEN_HOST` (403) | A browser `Origin`, or a `Host` other than `127.0.0.1:<port>`/`localhost:<port>`. | Call from the CLI on 127.0.0.1. |
| `INTERNAL` (500) | Unexpected failure. | Report it with the request; check the API console output. |

When a mutation elsewhere answers 503 or 502, **the change itself succeeded** — only the calendar is
behind. Always say that first; the user has not lost anything.

## Where to go next

- The plan itself: mark done / skipped, shift, regenerate, reload → `study-planner:planner-schedule`
- Pause and resume (a resume rewrites the events) → `study-planner:planner-pause-resume`
- Add / change / remove a task or plan → `study-planner:planner-create`,
  `study-planner:planner-update`, `study-planner:planner-delete`
- Reads of the plan to compare against → `study-planner:planner-read`
