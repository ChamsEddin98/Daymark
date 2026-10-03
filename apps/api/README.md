# @planner/api

This is the HTTP API for the study planner. The contract is in [`docs/API.md`](../../docs/API.md).
It uses Fastify and listens on `127.0.0.1:4317` only, with CORS for the web UI on port 3417.
It owns every write. The web UI, Claude Code and scripts are all clients.

```sh
npm run api                        # from the repo root
npm start -w @planner/api          # the same thing
PLANNER_NOW=2026-09-28T10:15:00+02:00 npm run api      # frozen clock
PLANNER_CLOCK=start=2026-09-28T07:59:00,speed=600 npm run api   # compressed day
npm test -w @planner/api
```

## How it works

- **State.** SQLite at `.data/planner.db` (WAL), through `@planner/store`. The daemon shares the
  same file. `PlanService` in the store package holds the plan rules, so the daemon can reuse them.
- **First start.** The anchor is set to today. `resources/**/*.md` is loaded and the horizon
  (`PLANNER_HORIZON_DAYS`, default 7) is generated and stored as items.
- **Status change.** It is saved, and today is never reshuffled. Days after today are regenerated.
  Today's pending items count as done, and a split task continues with the right part number.
- **Rollover.** When the stored plan was generated on an earlier day, the next request (or the 1-second
  poll) regenerates from today with the real status. The daemon may do the same thing, and a write lock
  makes sure it only happens once.
- **Shift.** Uses `shiftPlan` from core. The moved, added and removed items are saved in one transaction.
- **Side effects.** Every mutation publishes an SSE event (`plan`, `status`) and queues a Google
  Calendar sync, debounced by 2 s. A sync failure is recorded (`/health`, `/sync/status`) and never fails
  the mutation. `POST /sync` runs a sync straight away and returns 503 or 502 on failure.
- **Environment.** `PLANNER_TZ`, `PLANNER_DATA_DIR`, `PLANNER_RESOURCES_DIR`, `PLANNER_API_PORT`,
  `PLANNER_WEB_ORIGINS` and `PLANNER_SYNC_DEBOUNCE_MS`. `.env` at the root is loaded for the
  `GOOGLE_CLIENT_*` values. The Google token is read from `<data dir>/google-token.json`.
