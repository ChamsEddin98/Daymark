"use client";

import { AlarmClock, CheckCheck, Moon, Pause } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import type { Derived } from "@/lib/derive";
import { clockDur, durLong, hhmm, isTomorrow, longDate, ms, whenOn } from "@/lib/time";
import type { TodayResponse } from "@/lib/types";

interface Paused {
  since: string;
  elapsedSec: number;
  /** Past 24 h the API stops enforcing the pause, so the UI stops freezing on it. */
  stale?: boolean;
}

interface Props {
  d: Derived;
  now: number;
  date: string;
  upcoming: TodayResponse["upcoming"];
  /** Start of the first item on the upcoming date, when known (never assumed to be 08:00). */
  upcomingStart: string | null;
  /** The pause: when it started, how long it has run (seconds), and whether it is past 24 h. */
  paused?: Paused | null;
  onReviewMissed(): void;
}

/**
 * Why the day has stopped moving, and since when. Calm on purpose: one accent-tinted strip, full
 * contrast text, and no dimming of the page behind it.
 */
function PausedNotice({ since, elapsedSec, stale, today }: Paused & { today: string }) {
  return (
    <div
      role="status"
      data-testid="paused-notice"
      data-stale={stale ? "true" : undefined}
      className={cn(
        "mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border px-2.5 py-1.5",
        stale ? "border-warning/40 bg-warning/10" : "border-accent/40 bg-accent-soft",
      )}
    >
      <span className={cn("flex items-center gap-1.5 text-sm font-semibold", stale ? "text-warning" : "text-accent")}>
        <Pause className="size-3.5 shrink-0" aria-hidden />
        Schedule paused
      </span>
      <span className="tnum text-sm text-muted-foreground">
        since{" "}
        <span className="font-medium text-foreground" data-testid="paused-since">
          {whenOn(today, since)}
        </span>
      </span>
      <span className={cn("tnum ml-auto text-sm font-semibold", stale ? "text-warning" : "text-accent")} data-testid="paused-for">
        {clockDur(elapsedSec)}
      </span>
      <p className="w-full text-xs text-muted-foreground" data-testid="paused-explainer">
        {stale
          ? "This pause has run over 24 h, so it no longer holds the plan. Resume cannot move it that far — shift whole days instead, which clears the pause."
          : "The timeline is frozen. Resuming moves everything still to come forward by exactly this much."}
      </p>
    </div>
  );
}

/** "Rest in 12 min" — the name of the next boundary, from the item after the current one. */
export function nextBoundary(d: Derived, now: number): string | null {
  const cur = d.current;
  if (!cur) {
    if (d.phase === "before" && d.next) return `Day starts in ${durLong((ms(d.next.start) - now) / 60_000)}`;
    if (d.phase === "gap" && d.next)
      return `${d.next.kind === "task" ? d.next.title : "Rest"} starts in ${durLong((ms(d.next.start) - now) / 60_000)}`;
    return null;
  }
  const inMin = durLong((ms(cur.end) - now) / 60_000);
  const after = d.next;
  if (cur.kind === "task") {
    if (!after) return `Day ends in ${inMin}`;
    if (after.kind === "rest") return `${after.restKind === "long" ? "Long rest" : "Rest"} in ${inMin}`;
    return `Next task in ${inMin}`;
  }
  if (!after) return `Day ends in ${inMin}`;
  return `Back to work in ${inMin}`;
}

/** "Tomorrow starts with A15 · Join types at 08:00." — the time comes from the plan, not a constant. */
export function UpcomingLine({
  date,
  upcoming,
  upcomingStart,
}: {
  date: string;
  upcoming: TodayResponse["upcoming"];
  upcomingStart: string | null;
}) {
  if (!upcoming) return <>Nothing is planned after today.</>;
  const when = isTomorrow(date, upcoming.date) ? "Tomorrow" : longDate(upcoming.date);
  return (
    <>
      {when} starts with <span className="font-medium text-foreground">{upcoming.firstTitle}</span>
      {upcomingStart && (
        <>
          {" "}
          at <span className="tnum">{hhmm(upcomingStart)}</span>
        </>
      )}
      .
    </>
  );
}

export function NowPanel({ d, now, date, upcoming, upcomingStart, paused, onReviewMissed }: Props) {
  const boundary = nextBoundary(d, now);
  /** Nothing pending starts later today: the day's remaining work lives on another date. */
  const noFutureWork = !d.nextTask;
  const longRest = d.items.find((i) => i.restKind === "long");
  const missed = d.missed.length;

  const missedLine = missed > 0 && (
    <div
      data-testid="missed-banner"
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2.5 text-sm"
    >
      <span className="font-medium text-warning">
        {missed} earlier task{missed === 1 ? "" : "s"} unchecked
      </span>
      <button
        type="button"
        onClick={onReviewMissed}
        className="h-10 rounded-md border bg-surface px-3 text-sm font-medium transition-colors duration-150 hover:bg-muted sm:h-8"
      >
        Review
      </button>
      <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:inline-flex">
        <Kbd>x</Kbd> done <Kbd>d</Kbd> skip <Kbd>j</Kbd>/<Kbd>k</Kbd> move
      </span>
    </div>
  );

  // ---- all done
  if (d.allDone) {
    return (
      <Panel testId="state-done" tone="done" paused={paused} today={date}>
        <div className="flex items-center gap-3">
          <Icon>
            <CheckCheck className="size-4" />
          </Icon>
          <div className="min-w-0">
            <p className="text-lg font-semibold">Done for today</p>
            <p className="text-sm text-muted-foreground">
              <UpcomingLine date={date} upcoming={upcoming} upcomingStart={upcomingStart} />
            </p>
          </div>
        </div>
      </Panel>
    );
  }

  // ---- before the day starts
  if (d.phase === "before") {
    const first = d.nextTask ?? d.tasks[0];
    return (
      <Panel testId="state-before" paused={paused} today={date}>
        <div className="flex items-center gap-3">
          <Icon>
            <AlarmClock className="size-4" />
          </Icon>
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold">
              Day starts at <span className="tnum">{d.dayStart ? hhmm(d.dayStart) : "—"}</span>
              {first && (
                <>
                  {" "}
                  with <span className="font-semibold">{first.title}</span>
                </>
              )}
            </p>
            <p className="tnum text-sm text-muted-foreground" data-testid="boundary">
              Starts in {d.next ? durLong((ms(d.next.start) - now) / 60_000) : "a moment"} · {durLong(d.minutesLeft)} of
              work{longRest ? `, long rest at ${hhmm(longRest.start)}` : ""}
            </p>
          </div>
        </div>
      </Panel>
    );
  }

  // ---- after the last item, or nothing on the timeline
  if (d.phase === "after" || d.phase === "empty") {
    const open = d.missed.length;
    return (
      <Panel testId="state-after" paused={paused} today={date}>
        <div className="flex items-center gap-3">
          <Icon>
            <Moon className="size-4" />
          </Icon>
          <div className="min-w-0">
            <p className="text-lg font-semibold">
              {d.phase === "empty" ? "Nothing left on today's timeline" : "Today's plan has ended"}
            </p>
            <p className="text-sm text-muted-foreground">
              {open > 0 && `${open} task${open === 1 ? "" : "s"} still open. `}
              <UpcomingLine date={date} upcoming={upcoming} upcomingStart={upcomingStart} />
            </p>
          </div>
        </div>
        {missedLine}
      </Panel>
    );
  }

  // ---- in the day: current item + next boundary
  const cur = d.current;
  const doneEarly = cur?.kind === "task" && cur.status !== "pending";
  const label = cur
    ? cur.kind === "task"
      ? doneEarly
        ? "Done"
        : "Now"
      : cur.restKind === "long"
        ? "Long rest"
        : "Rest"
    : "Gap";
  const title = cur?.kind === "task" ? cur.title : d.nextTask ? `Next: ${d.nextTask.title}` : "Rest";
  const left = cur ? (ms(cur.end) - now) / 60_000 : 0;
  return (
    <Panel testId="state-now" paused={paused} today={date}>
      <div className="min-w-0">
        <div className="flex items-start justify-between gap-3">
          <p className="flex min-w-0 items-start gap-2">
            <span className="mt-[3px] shrink-0 rounded-sm bg-accent px-1.5 py-px text-2xs font-semibold tracking-wide text-accent-foreground uppercase">
              {label}
            </span>
            <span className="line-clamp-2 text-lg font-semibold sm:truncate" data-testid="now-title">
              {title}
            </span>
          </p>
          {cur && (
            <span className="tnum mt-0.5 shrink-0 text-sm font-medium text-accent" data-testid="now-left">
              {doneEarly ? `${durLong(left)} spare` : `${durLong(left)} left`}
            </span>
          )}
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-border" aria-hidden>
          <div
            data-testid="now-progress"
            data-frozen={paused && !paused.stale ? "true" : undefined}
            className={cn(
              "h-full origin-left rounded-full transition-transform duration-1000 ease-linear",
              paused && !paused.stale ? "bg-muted-foreground" : "bg-accent",
            )}
            style={{ transform: `scaleX(${d.currentProgress})` }}
          />
        </div>
        {noFutureWork && (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="upcoming-line">
            Nothing else starts today. <UpcomingLine date={date} upcoming={upcoming} upcomingStart={upcomingStart} />
          </p>
        )}
        <p className="tnum mt-2 text-sm text-muted-foreground">
          <span className="font-medium text-foreground" data-testid="boundary">
            {boundary}
          </span>
          {cur && d.next && (
            <>
              {" · "}
              {hhmm(cur.end)}
              {d.next.kind === "rest" && d.nextTask && (
                <>
                  {", then "}
                  {d.nextTask.title} at {hhmm(d.nextTask.start)}
                </>
              )}
              {d.next.kind === "task" && cur.kind === "task" && <> · {d.next.title}</>}
            </>
          )}
        </p>
      </div>
      {missedLine}
    </Panel>
  );
}

function Panel({
  children,
  testId,
  tone,
  paused,
  today,
}: {
  children: React.ReactNode;
  testId: string;
  tone?: "done";
  paused?: Paused | null;
  today: string;
}) {
  return (
    <section
      aria-label={paused && !paused.stale ? "Now (paused)" : "Now"}
      data-testid={testId}
      data-paused={paused && !paused.stale ? "true" : undefined}
      className={cn(
        "flex min-h-[92px] flex-col justify-center rounded-xl border bg-surface px-4 py-3 shadow-[0_1px_2px_rgb(0_0_0/0.04)]",
        tone === "done" && "border-track-bcg/30",
        paused && !paused.stale && "border-accent/40",
      )}
    >
      {paused && (
        <PausedNotice since={paused.since} elapsedSec={paused.elapsedSec} stale={paused.stale} today={today} />
      )}
      {children}
    </section>
  );
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>
      {children}
    </span>
  );
}
