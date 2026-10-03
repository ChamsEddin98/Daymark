# apps/web: design notes (P5 daily view)

## What I studied in Todoist, and how

I tried the live app at `app.todoist.com/app/today` on 2026-09-28. It redirected to the login page, and
per the brief I did not sign in. What follows comes from public material only: the keyboard shortcuts help
article, the "Plan your day with the Today view" help article, and the product screenshot of the Today
view on todoist.com (zoomed in). Behaviour I could not see directly, like the exact animation timing, is
marked *(from memory, unverified)*.

| # | Todoist Today, as observed | Consequence here |
|---|---|---|
| T1 | The title is a large bold "Today". Tasks are grouped under small bold section headers ("My Projects", "Team"). | A 22 px "Today" with the long date beside it. The groups are replaced by time structure, since time is what organises this day. |
| T2 | Each row has an 18–20 px ring checkbox, a 14 px title, and a second line of small metadata (green time "7:30 AM", a recurrence icon, a calendar badge). Hairline dividers run between rows, and "+ Add task" sits in the red accent. | Same 20 px ring and 14 px title. Metadata moves into aligned columns on desktop (time, track, link, duration) and stays a second line on phones. There is no "add task", because tasks come from `resources/*.md` (P0). |
| T3 | Priority is coded by the ring colour: P1 red, P2 orange, P3 blue, P4 grey. Coloured rings carry a faint tint of the same hue inside. | Colour codes the **track** (BCG green, Salesforce blue, Anthropic clay, Lessons violet, Portfolio amber, Apply rose). Each ring has a 10% tint inside. |
| T4 | Hovering the ring previews a check inside it. Clicking fills the ring and draws the check, then the task animates out of the list. A bottom-left toast reads "1 task completed" with **Undo** *(from memory, unverified)*. | The ring fills in the same frame as the click (11 ms measured), the check is drawn with a 234 ms pop, and a 5 s undo toast appears. **The row stays in place**, dimmed and struck through, because in a timeline, removing a row would shift every later time slot. |
| T5 | Keyboard help article: `Q` quick add, `J`/`K` or arrows move the selection, `E` completes the focused task, `X` selects, `Enter` opens, `T` sets a date, `?` shows shortcuts, `Esc` closes, `G then T` goes to Today, `M` toggles the sidebar. | `j`/`k`/arrows, **`x` or Space complete**, `d` skip (P5 names these, so `x` means complete here rather than select), `o`/Enter open the platform link, `s` shift, `u` undo, `n` jump to now, `?` help, `Esc` close. |
| T6 | Rescheduling means postponing a task to another day, one task at a time, or by dragging tasks in the calendar layout (Pro). The help centre recommends it to reach "Todoist Zero". | Shift moves **everything from now on** in one step, with the new end of day shown before you confirm. |
| T7 | The Today view has no start or end times unless you time-block manually. There is no "current task" and no rest concept. | These are exactly the P5 gaps: the now panel, the next boundary, the rests and the long-rest band. |
| T8 | Links live inside the task description or comments. | The platform link is a chip on the row and opens in one click. |
| T9 | The layout is light with generous whitespace, one warm accent (red) and soft greys. About 10 rows fit at desktop height. | Warm neutral greys and one accent (indigo) that marks "now", focus and primary actions. 10 task rows plus all rests fit at 1440×900. |

## Visual system

- **Type.** Geist Sans, with Geist Mono for the command block. The scale is 11 / 12 / 13 / 14 / 16 / 22 px. Every
  time and duration uses `tabular-nums` (the `.tnum` class), so columns don't jitter as the numbers tick.
- **Palette.** Warm neutrals: `#fafaf9` background and `#62605c` muted text in light mode; `#121211` and
  `#a3a19c` in dark. There is **one accent**, indigo (`#4338ca` light, `#9ea4ff` dark), used only for now,
  focus and progress. Track hues are set per mode so each one reaches at least 4.5:1 as text on both the
  background and the surface (enforced by the axe tests). Tokens live in `app/globals.css`, and dark
  mode follows `prefers-color-scheme`.
- **Rhythm.** Task rows are 44 px on desktop and 56 px (two lines) on phones. Short rests are 24 px
  separators. The long rest is a 48 px striped band. Every row shares one grid template, so times,
  rings and titles line up. The column is at most 768 px wide.
- **Motion** (the `motion` package plus CSS):
  - Check pop: 220 ms, ease-out-quart.
  - Check draw: 200 ms.
  - Title colour and strike: 200 ms.
  - Hover: 150 ms.
  - Popover and dialog: 100 ms.
  - Progress bars are the one exception: they move with a 1 s linear transform once per clock tick,
    so they read as continuous, and they are not a UI transition.
  - `MotionConfig reducedMotion="user"` plus a CSS override remove transforms and transitions under
    `prefers-reduced-motion` (tested).
  - Everything animates `transform`, `opacity` or colour, never layout. Measured CLS is 0.0000.

## P5 criteria and how each is met

| Criterion | How | Evidence |
|---|---|---|
| 1. Now and next at a glance | A now panel shows the current item, "N min left", a live progress bar, and the next boundary named: "Rest in 30 min", "Long rest in …", "Back to work in 35 min", "Day ends in …". The current row is tinted, carries an accent bar, and runs its own progress line. | `states.spec.ts`: "mid-task …", "during the long rest …" |
| 2. Timeline visible, ≥ 9 rows | Every row shows start–end and duration. 10-min rests are slim separators, and the long rest is a band. **10 task rows are fully visible at 1440×900.** | `states.spec.ts`: "density …" logs `10 task rows`. The structure test counts 11 tasks, 9 rests, 1 long rest and the split A13 parts. |
| 3. Checkbox ≥ Todoist | Hover previews the check. The click fills the ring in the same frame (**11.3 ms** from pointerdown to filled with aria-checked, against 400 ms of injected server latency). A **234 ms** pop plus check draw follows. The 5 s undo toast has a button and the `u` key. The change is persisted through `POST /items/:key/status` and survives a reload. If the API rejects it, the change is rolled back and an error toast explains why. | `checkbox.spec.ts` (all 5 tests) |
| 4. One-click link | A chip (label plus ↗) on desktop, a 40 px icon button on phones. Both use `target=_blank rel=noopener`. `o` opens the link from the keyboard. | `states.spec.ts`: "link chip …"; `keyboard-shift.spec.ts` (popup URL) |
| 5. Shift in ≤ 2 interactions, with preview | Opening the popover (click or `s`) fetches `POST /plan/shift/preview` for +15m, +30m, +1h and +1 day in parallel, and each option shows its outcome ("→ Ends 19:00", "14 items → tomorrow"). Picking an option (click, or keys `1`–`4`) **is** the confirmation. A custom amount and unit update the preview as you type and confirm with Enter. | `keyboard-shift.spec.ts`: "mouse: shift is two clicks …", "s opens shift …", "custom shift …" |
| 6. Keyboard-only flow | A roving tabindex runs over the task rows, with a visible 2 px ring (box-shadow asserted). The keys are j/k/↑/↓, x/Space, o/Enter, s, 1–4, u, n, ? and Esc. | `keyboard-shift.spec.ts`: "keyboard only …" (2 tests) |
| 7. Motion 150–300 ms, CLS < 0.02, reduced motion | See Motion above. The skeleton has the same geometry as the loaded page. | `states.spec.ts`: "loading skeleton … CLS" logs `0.0000`; `a11y-mobile.spec.ts`: "reduced motion …" |
| 8. Empty states name what comes next | Before 08:00: "Day starts at 08:00 with A7 · Sorting (part 2/2)". All done: "Done for today. Tomorrow starts with A15 · Join types at 08:00." API down: "The planner API isn't running", the API URL, `$ npm start` with a copy button, an auto-retry countdown and Retry now. Loading shows a skeleton. After the last item with tasks still open, a message says they come back first tomorrow. | `states.spec.ts` |
| 9. Contrast AA; 390 px | axe (WCAG 2.1 A/AA) finds 0 violations in light and dark across mid-day with a toast, the long rest with the shift popover open, before 08:00, all done, API down and the help dialog. At 390 px there is no horizontal scroll, and every visible control is ≥ 40×40. | `a11y-mobile.spec.ts` |

## Round 2 (critic round 1 FAIL → fixes)

| Critic item | Change | Test |
|---|---|---|
| 1. Tab-focused checkboxes had no ring | `outline-none` removed. `focus-visible:outline-solid` gives a 2 px ring in the accent colour. | `round2.spec.ts`: "Tab reaches a checkbox …" |
| 2. The +1 day preview did not match the toast | One wording helper (`lib/shift-copy.ts`) is used by the popover and by the toast. Days: "Today ends HH:MM · N items move to later days", where N is the API's `moved`. `dropped` and `carried` show as a warning line. After a day shift the toast adds "<date> starts with <task> at HH:MM", with the time taken from `GET /plan`. | `round2.spec.ts`: "+1 day …", "minute/hour shifts warn …" |
| 3. `day.checked` was ignored | A "Done earlier (n)" group shows each checked item at its original times (`plannedStart`/`plannedEnd`). It sits in the side column at ≥ 1280 px and below the timeline otherwise. The header count is the API's `progress`, adjusted only for optimistic changes that are still in flight. | `round2.spec.ts`: "+1 day …" (count equals the API's) |
| 4. Missed tasks looked like future ones | A timeline task that has ended and is still pending gets a "Missed" tag and an inline Skip button. The now panel shows "N earlier tasks unchecked" with a Review button (it focuses the first missed task) and the hint x done · d skip · j/k move. The new key `d` skips a task or unskips it. Skipped tasks get a grey dash. | `round2.spec.ts`: "missed tasks …", "the Skip button …" |
| 5. Undo in the toast was 54×32 | The action button is 40 px tall with a minimum width of 40 px. | `round2.spec.ts`: "the toast's Undo is at least 40×40" |
| 6. The mobile now panel truncated | The title can take two lines, and "then <task> at HH:MM" is shown at every width. | `round2.spec.ts`: "the now panel shows the whole title …" |
| 7. 08:00 was hard-coded | No "08:00" is left in UI code. Start times come from the first item of the day, or from `GET /plan` for the upcoming date. | "+1 day …" (tomorrow starts at 11:00 after an exact 24 h shift) |
| 8. The API-down panel needed more guidance | It shows `npm start` to start everything, or `npm run api` plus `npm run daemon` when the UI is already running, and explains why. | `states.spec.ts` |
| 9. `o` with no link; stretched long rest | `o` on a task without a link shows the toast "No link for this task". The long-rest band shows its real length ("1 h 15 min"). | `round2.spec.ts`: "o on a task without a link …", "a stretched long rest …" |
| 10. Wide screens were under-used | At ≥ 1280 px a 300 px side column shows a progress ring (done/total and minutes), an mm:ss countdown to the next boundary, track progress from `GET /tracks`, and "Done earlier". The before-08:00 icon is now an alarm clock. | `round2.spec.ts`: "wide screens get a side column …" |

The fixture mock follows the contract's "Response details" section. That covers `day.checked` with planned and last slots, `currentTask`/`nextTask`, `progress.checkedMin`, shift `dropped`/`day`, rests stretched after a minute shift, 409 when there is nothing to shift, the `GET /tracks` endpoint, and undo of a checked item. A `missed` scenario was added.

## Round 3 (critic round 2 FAIL → fixes)

| Critic item | Change | Test |
|---|---|---|
| 1 (blocking). On phones the initial scroll pushed the now panel off the top | The now panel is **sticky at the top below 640 px** (`sticky top-0`, static from `sm` up). Rows carry `scroll-margin-top: var(--sticky-h)`, measured from the panel with a `ResizeObserver`, so neither the initial scroll nor `j`/`k` can hide it, and the initial scroll uses `block: "start"` instead of centring. `body` moved from `overflow-x: hidden` to `overflow-x: clip`, which does not make the body a scroll container and so does not break sticky. The phone long-rest band now shows "N m left" like the desktop one. | `round3.spec.ts`: "390 px: the now panel stays on screen" (13:10, 16:00, all done, and after scrolling to the bottom), "at 16:00 the missed banner is on the first screen", "during the long rest …" |
| 2. The +1 day preview was unreadable and matched +2 days | A days shift leads with the date the work lands on and how much of today moves ("Tue 29 Sep · 7 of today's tasks move"), with counts on a second line ("116 items in all · today ends 10:50") and dropped sessions named on a warning line. The target date is computed from today plus the amount, so +1 and +2 days never read alike. | `round3.spec.ts`: "+1 and +2 days are told apart …", "dropped daily sessions are named …" |
| 3. After a days shift the panel dropped the next-day line | Whenever nothing pending starts later today, the now panel says "Nothing else starts today." followed by the next day and its first task. | `round3.spec.ts`: "a days shift keeps 'Tomorrow starts with …' …" |
| 4. The side column contradicted the panel | The countdown card is gone (see item 9), so nothing counts down beside "Done for today". The progress card adds "N open from earlier" whenever late tasks remain, instead of implying the day is clear. | `round3.spec.ts`: "the side column never contradicts the now panel" |
| 5. "Missed" appeared during a task's own rest | A late task reads **Unchecked** until the next task starts, then **Missed** (`derive.ts` `lateStates`, exposed as `data-late`). | `round3.spec.ts`: "a task is 'unchecked' during its own rest …" |
| 6. A dropped SSE stream was invisible; raw fetch errors | `useToday` tracks the stream. When it drops while the API still answers, a "Disconnected — retrying" bar appears and says saving still works. `friendlyError` turns "Failed to fetch" into "No response from the API — it looks stopped." | `round3.spec.ts`: "a dropped live stream shows a retry bar …" |
| 7. A superseded change left a stale toast | One toast per item: a new change dismisses that item's previous toast before showing its own. | `round3.spec.ts`: "a superseded change drops its older toast" |
| 8. The API-down hint ignored a non-default port | When the API is not on 4317, every command carries `PLANNER_API_PORT=<port>`, with a note giving the PowerShell form. | `round3.spec.ts`: "the API-down commands carry the port …" |
| 9. Desktop chrome repeated itself | Minutes left appear only in the side column's progress card (the header clause is hidden from `xl` up), the next boundary only in the now panel (the aside's countdown card is removed), and the footer keeps only the "press ? for keys" hint. | `round3.spec.ts`: "desktop chrome states each fact once" |

**Where I did not follow the critic literally.** The +1 day preview does not name the target day's first task. A preview cannot know it: `POST /plan/shift/preview` returns today after the shift, not the target day, and `GET /plan` for that date still shows the pre-shift plan, which the API re-lays when the shift lands. The preview therefore names the date and what leaves today, both of which are certain, and the confirmation toast names the first task and its time once the real data is back.

## P8 · Pause and Resume

A pause freezes the plan while you step away; resuming pushes everything still to come forward by
exactly how long you were gone (docs/PLAN.md, P8). Todoist has no equivalent at all: the closest
move is rescheduling each task by hand.

| Decision | Why | Test |
|---|---|---|
| **The button sits beside Shift, with the same height, border, surface and type.** Not a stock shadcn button: it uses the same `h-10 sm:h-8` / `rounded-lg` / `bg-surface` shell as the Shift trigger, and gains an accent-tinted skin only while paused, so "the day is frozen" is legible from the header alone. | Two neighbouring controls with different weights read as two unrelated features. | `pause.spec.ts`: "pause: the button becomes Resume …" |
| **The box never resizes.** The two labels share one grid cell, and an invisible sizer holds the widest one ("Resume 99:59"), so `Pause` → `Resume 1:12` changes no geometry. The counter is `tnum` like every other number in the UI. | Requirement 7: no layout shift on the label change. | "the label change causes no layout shift" (boxes byte-identical, CLS < 0.02) |
| **`aria-busy`, not `disabled`, for the in-flight state.** A disabled element loses focus, so the first build dropped the keyboard on every press. | Requirement 5: focus must stay visible on the new control. | "the Pause button keeps a visible focus ring" |
| **The clock splits in two.** `now` keeps running (it drives the counter); everything derived from the plan reads `frozenNow`, the pause instant. So the current item, its "N min left" and every progress bar stop at once, with no special-casing in `derive.ts`. `frozenNow` is the pause instant exactly, never `min(now, since)` — `now` is re-aligned to the server on each refetch, and that jitter crept into the "frozen" value. | Requirement 2: the timeline reads as frozen. | "the timeline reads as frozen …" (asserts the bars *do* move before the pause, then are byte-identical across 3.2 s) |
| **Calm, not greyed.** One accent-tinted strip at the top of the now panel ("Schedule paused · since 10:18 · 1:11" plus one line of explanation), a `Paused` tag on the current row, and the current row's accent bar and progress line switch from accent to `--muted-foreground`. Nothing is dimmed. | Requirement 2: contrast must still pass AA in both modes. | axe (light and dark, 1440×900 and 390×844) in `pause.spec.ts` |
| **Shift is disabled, not hidden**, with the reason on a wrapper's `title` (a disabled button gets no pointer events of its own) and on an `aria-describedby` target. `s` answers with the same sentence in a toast instead of a silent no-op. | Requirement 4. | "shift is disabled — not hidden — while paused …" |
| **`409 PAUSED` never surfaces raw**, in the shift previews ("Paused — resume first") or on commit ("The schedule is paused. Resume it first — a pause already moves everything forward."). | Requirement 4; a race with another client is the only way it can still arrive. | "a 409 PAUSED from the API shows a clear toast …" |
| **`pausedSec` is formatted, not printed.** `< 10 s` → one decimal at most ("4.3 s", "7 s"); `< 60 s` → whole seconds ("45 s"); above → `m:ss`. The toast is the existing style: **Resumed** · *everything moved 45 s later · today ends 18:31*. | Requirement 3: no absurd precision, and `45.317` is not a number to show a human. | "resume: the toast reports the duration …" (also asserts the plan moved by a non-round number of seconds), "a pause under 10 s …" |
| **`p` pauses and resumes**, added to the help dialog. It does not collide with j/k/arrows, x, Space, d, o, Enter, s, 1–4, u, n, ? or Esc. | Requirement 5. | "the p key pauses and resumes, and the help dialog lists it" |
| **SSE carries it.** `useToday` now subscribes to `pause` and `resume` as well as `plan`/`status`/`sync`, because a pause moves nothing and so publishes no `plan` event of its own. | Requirement: the UI updates without polling. | "the paused state arrives over SSE when another client pauses" (and the resume too) |
| **The header re-flows at 390 px.** Three text controls plus a long date do not fit. The title row keeps the controls; below `sm` the date moves to the front of the summary line, which already spans the full width. No row is added, no vertical space is lost, and the date stops truncating to "M". | Requirement 6: reachable ≥ 40 px button, no horizontal scroll, sticky now panel intact. | "paused, axe … 390 px" (scroll width, button box, tap targets) and "390 px: the now panel stays in view while paused" |

### Round 2 (P8 critique: two copy fixes)

| Critic item | Change | Test |
|---|---|---|
| 1. Developer copy in a user-facing toast: resuming a > 24 h pause showed the API's hint verbatim, request body and all — `Shift whole days instead ({ "amount": 1, "unit": "days" }); that clears the pause.` | An API `hint` is written for whoever calls the API, so it is now cleaned before it reaches a toast. `humanHint` (in `states.tsx`, beside `friendlyError`) strips a JSON object or array — with or without the parentheses that usually wrap it — closes the sentence up (`instead; that` → `instead — that`), and **drops the hint entirely if anything machine-shaped survives**, rather than showing it half-cooked. `sentence` capitalises and full-stops the API's lowercase `message`. `friendlyError` strips JSON too, so no path to a toast can leak one. The toast now reads: *The pause has run for 25.0 h, which is longer than the 24 h a resume may move the plan. Shift whole days instead — that clears the pause. The pause is kept until then, so nothing is lost.* | "no toast ever shows a raw API hint with a JSON body in it" (asserts the fixture's hint really does contain one, then that the toast contains no `{}`, no quoted keys and no bare `amount`/`unit`) |
| 2. "Schedule paused since 07:32" is ambiguous once the pause has run past a day boundary. | `whenOn(today, iso)` names the instant relative to today: the wall clock alone on the same day, `yesterday 23:40` the next morning, and `29 Sep 07:32` beyond that. A pause crossing midnight is the ordinary case (the API cuts the resume at midnight for exactly this reason), so this is not an edge. | "the paused banner names the day when the pause did not start today" (same day, and a pause begun at 23:40 read at 00:30) |

### Four places the backend landed differently from the brief, and how the UI followed

1. **A pause past 24 h stops being enforced.** `planner.ts#pauseIsStale` keeps reporting the pause
   but lets `/plan/shift` through, because a resume is `400` past 24 h and refusing the shift too
   would leave the owner with no way out. The first build disabled Shift on *any* pause, which would
   have locked that door. The UI now separates "paused" from "frozen": past 24 h the notice stays
   (in the warning tone, naming the day shift as the way out), the button still says Resume, but the
   timeline unfreezes and Shift is enabled again. Pressing Resume then surfaces the API's own hint.
   Tested by "a pause past 24 h stops freezing the plan and points at the way out".
2. **The resume cut point is the *pause* instant, not the resume instant**, and a pause crossing
   local midnight is cut at midnight. The fixture's `resumeShift` now cuts there too, so the mock
   keeps matching the real backend. Nothing in the UI depends on the cut point — it reads the
   returned `day` — but a fixture that diverges stops being evidence.
3. **`GET /today` freezes `current`/`next`/`currentTask`/`nextTask` at the pause instant while the
   pause is enforced.** The UI does not consume those fields at all: `derive.ts` recomputes them
   from `day.items` against the clock, which is what lets the page move forward second by second
   without a refetch. So there is **no double-correction risk** — freezing is choosing an instant to
   evaluate at, not applying an offset, and both sides choose the same instant (`paused.since`).
   Switching to the API's values would cost the once-per-second liveness, so the local derivation
   stays; what it needed was a guard that the two never disagree. The fixture freezes those fields
   the same way (and unfreezes them for a stale pause, matching enforcement), and
   "while paused, what the UI calls 'now' is what the API calls 'now'" asserts the agreement after
   real time has moved well past the pause instant.
4. **Pause and resume travel as `plan` SSE events**, with `reason: "pause" | "resume"` and the new
   `paused` state in the payload — not under their own event names. `useToday` already refetched on
   `plan`, so this worked as built; the fixture now publishes the same way, and the bare
   `pause`/`resume` names are still listened for so a frozen plan can never be missed.

Everything else matches the brief exactly: `PausedView { since, elapsedSec }`,
`PauseResult { paused: { since } }`, `ResumeResult { pausedSec, moved, endOfDay, day }`, `409 PAUSED`
on shift/preview/regenerate, `409 CONFLICT` on a double pause or a resume while running, and
`400 INVALID_INPUT` past 24 h with the pause kept.

The fixture mock implements the whole surface: `paused` on `/health` and `/today`, `POST /plan/pause`
and `/plan/resume` (with `409 CONFLICT` on a double pause or a resume while running, and
`400 INVALID_INPUT` past 24 h, leaving the pause in place), `409 PAUSED` on `/plan/shift`,
`/plan/shift/preview` and `/plan/regenerate` while paused, status changes still working, and a
millisecond-exact resume that moves only the items starting at or after the resume instant.
`POST /__mock/pause { agoMs }` backdates a pause so a test or a screenshot can show a known duration.

## Active hours · the working window

A gear beside Pause opens one panel with the owner's three limits: when the day starts, when it must
stop, and how many hours of work it holds. One setting for every day.

- **Four presets first, three fields after.** "Standard", "9 to 6", "Long days", "Evenings" fill all
  three at once, and the preset matching the current setting is marked, so the panel answers "where
  am I" before it asks for input. Most changes are one click.
- **Hours, not minutes.** The API stores `dailyTaskMin`; nobody thinks in minutes a day. The field is
  hours with a 0.5 step, converted in `lib/active-hours.ts` so the form and the request cannot drift.
- **The end field is text, not `type="time"`.** The API's `24:00` means "no fence", and a native time
  input clamps to 23:59, so it cannot express the default. The label shows "midnight" when it is set.
- **The panel shows what the window *grants*, never what was asked for.** This is the whole reason it
  needs a design rather than three inputs and a Save. Every 4 h of task time buys an hour of long
  rest, so the clock cost of work is **stepped**: asking for 10 h inside 08:00–20:00 yields 8 h.
  A UI that echoed the request back would be lying about the plan. So the line under the fields reads
  "Days hold 8h, ending by 18:40" — read back from the server after saving, never computed here — and
  when the window is the limit a warning names the mechanism *and* the fix ("each 4h of work adds an
  hour of rest. Push the end later to get the rest."). The toast after saving repeats it.
- **Invalid before the request.** An end at or before the start, a window under 15 minutes, a
  malformed time or an out-of-range budget show beside the fields and disable Save, rather than
  arriving as an error toast. The server validates the same things; this is about not wasting the
  round trip or the owner's attention.
- **Save is inert until something changes**, so the panel cannot be used to "confirm" a no-op, and a
  server refusal leaves the panel open with the values still in it.

Todoist has nothing to compare here — it has no concept of a day with a shape. The closest thing is
its working-hours setting for the calendar layout, which only draws a band; this one decides how much
work a day is given and when it runs.

## Where this deliberately differs from Todoist

- **Done rows stay in place.** Todoist removes completed tasks. Here, removing a row would shift the
  times below it and break "what do I do at 14:20".
- **`x` completes rather than selects**, and Todoist's `e` is not bound. There is no multi-select, because
  nothing here acts on several tasks at once.
- **No quick add (`q`) and no editing.** Tasks come from Markdown task files (P0) through the API. The web UI
  only changes status and shifts time.
- **Colour means track, not priority.** Order is already decided by the scheduler (P1), so a priority colour would
  carry no information.
- **One indigo accent instead of Todoist red.** Red reads as "overdue or error" in a timeline. Indigo is kept for
  "now" and focus only, so it never competes with the track hues.
- **The toast sits at bottom centre**, which suits a centred single column and is reachable by thumb on phones.

## Implementation notes

- `app/page.tsx` is a server component. It reads the API base per request (`PLANNER_API`, else
  `NEXT_PUBLIC_PLANNER_API`, else `http://127.0.0.1:4317`), so a single build can point at the real API or
  at the fixture. It forwards `?now=` to the API, and only the fixture API honours it.
- `hooks/use-today.ts` does the data work:
  - It fetches `GET /today` and keeps the clock aligned to the server (`now` offset), ticking every
    second.
  - It subscribes to `GET /events` (SSE) and refetches on `plan`, `status` and `sync`.
  - It applies optimistic status overrides and rolls them back on error.
  - When the API is unreachable, it retries every 5 s.
- `lib/derive.ts` is pure. It turns the items, the clock and the overrides into current, next, phase,
  progress and minutes left, so the UI moves forward in time without a refetch.
- `lib/types.ts` mirrors `packages/core/src/schedule/types.ts` and the `/today` payload. The web app talks
  only HTTP.
- **The real API must send CORS headers for `http://127.0.0.1:3417`.** The browser calls the API origin
  directly, including for SSE. `apps/api` already depends on `@fastify/cors`.
