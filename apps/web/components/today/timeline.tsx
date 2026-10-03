"use client";

import { forwardRef } from "react";
import { ArrowUpRight, Coffee, Pause } from "lucide-react";
import { CheckCircle } from "./check-circle";
import { cn } from "@/lib/utils";
import { dur, durLong, hhmm, minutesBetween, ms } from "@/lib/time";
import { track } from "@/lib/tracks";
import type { PlanItem } from "@/lib/types";

/** Shared column template so times, checkboxes and titles line up across tasks and rests. */
const COLS = "grid-cols-[40px_minmax(0,1fr)_auto] sm:grid-cols-[92px_40px_minmax(0,1fr)_auto_64px]";

interface TimelineProps {
  items: PlanItem[];
  now: number;
  currentKey: string | null;
  progress: number;
  focusedKey: string | null;
  lateStates: ReadonlyMap<string, "unchecked" | "missed">;
  /** The plan is frozen: progress stops advancing and the current row says so. */
  paused?: boolean;
  onFocusRow(key: string): void;
  onToggle(item: PlanItem): void;
  onSkip(item: PlanItem): void;
  rowRef(key: string): (el: HTMLLIElement | null) => void;
}

export function Timeline({ items, now, currentKey, progress, focusedKey, lateStates, paused, onFocusRow, onToggle, onSkip, rowRef }: TimelineProps) {
  return (
    <ol
      aria-label={paused ? "Today's timeline, paused" : "Today's timeline"}
      className="flex flex-col"
      data-testid="timeline"
      data-paused={paused ? "true" : undefined}
    >
      {items.map((it) =>
        it.kind === "task" ? (
          <TaskRow
            key={it.key}
            ref={rowRef(it.key)}
            item={it}
            now={now}
            isCurrent={it.key === currentKey}
            progress={it.key === currentKey ? progress : 0}
            focused={it.key === focusedKey}
            late={lateStates.get(it.key)}
            paused={paused}
            onFocus={() => onFocusRow(it.key)}
            onToggle={() => onToggle(it)}
            onSkip={() => onSkip(it)}
          />
        ) : it.restKind === "long" ? (
          <LongRest key={it.key} item={it} now={now} isCurrent={it.key === currentKey} progress={progress} paused={paused} />
        ) : (
          <ShortRest key={it.key} item={it} now={now} isCurrent={it.key === currentKey} progress={progress} paused={paused} />
        ),
      )}
    </ol>
  );
}

function ProgressLine({ value, className, frozen }: { value: number; className?: string; frozen?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute inset-x-2 bottom-0 h-0.5 overflow-hidden rounded-full bg-border", className)}
    >
      <span
        data-testid="row-progress"
        data-frozen={frozen ? "true" : undefined}
        className={cn(
          "block h-full origin-left rounded-full transition-transform duration-1000 ease-linear",
          frozen ? "bg-muted-foreground" : "bg-accent",
        )}
        style={{ transform: `scaleX(${value})` }}
      />
    </span>
  );
}

/** Title with the " (part i/n)" suffix de-emphasised. The text itself stays verbatim. */
function Title({ title }: { title: string }) {
  const m = title.match(/^(.*?)( \(part \d+\/\d+\))$/);
  if (!m) return <>{title}</>;
  return (
    <>
      {m[1]}
      <span className="text-muted-foreground">{m[2]}</span>
    </>
  );
}

interface TaskRowProps {
  item: PlanItem;
  now: number;
  isCurrent: boolean;
  progress: number;
  focused: boolean;
  /** "unchecked" during the task's own trailing rest, "missed" once the next task has started. */
  late?: "unchecked" | "missed";
  paused?: boolean;
  onFocus(): void;
  onToggle(): void;
  onSkip(): void;
}

const TaskRow = forwardRef<HTMLLIElement, TaskRowProps>(function TaskRow(
  { item, now, isCurrent, progress, focused, late, paused, onFocus, onToggle, onSkip },
  ref,
) {
  const t = track(item.track);
  const done = item.status !== "pending";
  const minutes = minutesBetween(item.start, item.end);
  const left = Math.ceil((ms(item.end) - now) / 60_000);
  const link = item.links?.[0];
  const time = `${hhmm(item.start)}–${hhmm(item.end)}`;
  const skipped = item.status === "skipped";
  const missed = !!late;
  const lateLabel = late === "missed" ? "Missed" : "Unchecked";
  return (
    <li
      ref={ref}
      tabIndex={focused ? 0 : -1}
      data-key={item.key}
      data-testid="task-row"
      data-status={item.status}
      data-current={isCurrent || undefined}
      data-missed={late === "missed" || undefined}
      data-late={late || undefined}
      aria-current={isCurrent ? "time" : undefined}
      aria-label={`${item.title}, ${time}${skipped ? ", skipped" : done ? ", done" : late ? `, ${lateLabel.toLowerCase()}` : ""}`}
      onFocus={onFocus}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget || !(e.target as HTMLElement).closest("a,button")) onFocus();
      }}
      className={cn(
        "group/row relative grid min-h-14 items-center gap-x-1 rounded-lg pr-1 outline-none sm:min-h-11 sm:gap-x-0 sm:pr-2",
        "scroll-mt-(--sticky-h) sm:scroll-mt-2",
        COLS,
        "transition-colors duration-200 ease-out",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        isCurrent ? "bg-accent-soft" : "hover:bg-muted/60",
      )}
    >
      {isCurrent && (
        <span
          aria-hidden
          className={cn("absolute inset-y-1.5 left-0 w-0.5 rounded-full", paused ? "bg-muted-foreground" : "bg-accent")}
        />
      )}
      <span
        className={cn(
          "tnum hidden pl-3 text-sm sm:block",
          isCurrent ? "font-medium text-accent" : "text-muted-foreground",
        )}
      >
        {time}
      </span>
      <CheckCircle
        checked={done}
        skipped={skipped}
        color={t.color}
        label={`${done ? "Mark not done" : "Complete"}: ${item.title}`}
        onToggle={onToggle}
      />
      <div className="min-w-0 py-2 sm:py-0">
        <p
          title={item.title}
          className={cn(
            "line-clamp-2 text-base sm:truncate",
            "line-through decoration-transparent transition-[color,text-decoration-color] duration-200 ease-out",
            done && "text-muted-foreground decoration-muted-foreground",
          )}
        >
          <Title title={item.title} />
        </p>
        <p className="tnum mt-0.5 text-xs text-muted-foreground sm:hidden">
          <span className={cn(isCurrent && "font-medium text-accent")}>{time}</span>
          {" · "}
          {isCurrent && !done ? `${dur(left)} left` : dur(minutes)}
          {" · "}
          <span className="font-medium" style={{ color: t.color }}>
            {t.label}
          </span>
          {skipped && " · skipped"}
          {late && <span className="font-medium text-warning"> · {lateLabel.toLowerCase()}</span>}
        </p>
      </div>
      <div className="flex items-center gap-1 sm:gap-3 sm:pl-3">
        {isCurrent && paused && (
          <span
            data-testid="paused-tag"
            className="inline-flex items-center gap-1 rounded-sm border border-accent/50 px-1.5 text-2xs font-medium text-accent"
          >
            <Pause className="size-2.5 shrink-0" aria-hidden />
            Paused
          </span>
        )}
        {missed && (
          <>
            <span
              data-testid="missed-tag"
              className="hidden rounded-sm border border-warning/50 px-1.5 text-2xs font-medium text-warning sm:inline"
            >
              {lateLabel}
            </span>
            <button
              type="button"
              data-testid="skip"
              onClick={(e) => {
                e.stopPropagation();
                onSkip();
              }}
              aria-label={`Skip: ${item.title}`}
              className="h-10 min-w-10 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground sm:h-7"
            >
              Skip
            </button>
          </>
        )}
        {skipped && <span className="hidden text-2xs font-medium text-muted-foreground uppercase sm:inline">Skipped</span>}
        <span className="hidden text-xs font-medium sm:inline" style={{ color: t.color }}>
          {t.label}
        </span>
        {link ? (
          <a
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="link-chip"
            aria-label={`Open ${link.label} (new tab)`}
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "inline-flex items-center justify-center gap-1 rounded-md text-xs text-muted-foreground",
              "transition-colors duration-150 hover:bg-muted hover:text-foreground",
              "size-10 sm:size-auto sm:h-7 sm:max-w-52 sm:border sm:border-border sm:bg-surface sm:px-2",
            )}
          >
            <span className="hidden truncate sm:inline">{link.label}</span>
            <ArrowUpRight className="size-4 shrink-0 sm:size-3.5" aria-hidden />
          </a>
        ) : (
          <span className="size-10 sm:hidden" aria-hidden />
        )}
      </div>
      <span
        className={cn(
          "tnum hidden text-right text-sm sm:block",
          isCurrent && !done ? "font-medium text-accent" : "text-muted-foreground",
        )}
      >
        {isCurrent && !done ? `${dur(left)} left` : dur(minutes)}
      </span>
      {isCurrent && <ProgressLine value={progress} frozen={paused} />}
    </li>
  );
});

interface RestProps {
  item: PlanItem;
  now: number;
  isCurrent: boolean;
  progress: number;
  paused?: boolean;
}

function ShortRest({ item, now, isCurrent, progress, paused }: RestProps) {
  const m = minutesBetween(item.start, item.end);
  const left = Math.ceil((ms(item.end) - now) / 60_000);
  return (
    <li
      data-key={item.key}
      data-testid="rest-row"
      data-current={isCurrent || undefined}
      aria-current={isCurrent ? "time" : undefined}
      className={cn("relative grid h-6 items-center", COLS)}
    >
      <span className={cn("tnum hidden pl-3 text-xs sm:block", isCurrent ? "text-accent" : "text-muted-foreground")}>
        {hhmm(item.start)}
      </span>
      <span aria-hidden className="grid place-items-center">
        <span className={cn("h-full min-h-6 w-px", isCurrent ? "bg-accent" : "bg-border")} />
      </span>
      <span className="col-span-2 flex items-center gap-2 pr-2 sm:col-span-3">
        <span className={cn("tnum text-xs", isCurrent ? "font-medium text-accent" : "text-muted-foreground")}>
          <span className="sm:hidden">{hhmm(item.start)} · </span>
          {isCurrent ? `Rest · ${durLong(left)} left` : `${m} min rest`}
        </span>
        <span aria-hidden className="relative h-px flex-1 overflow-hidden bg-border">
          {isCurrent && (
            <span
              data-testid="row-progress"
              data-frozen={paused ? "true" : undefined}
              className={cn(
                "absolute inset-0 origin-left transition-transform duration-1000 ease-linear",
                paused ? "bg-muted-foreground" : "bg-accent",
              )}
              style={{ transform: `scaleX(${progress})` }}
            />
          )}
        </span>
      </span>
    </li>
  );
}

function LongRest({ item, now, isCurrent, progress, paused }: RestProps) {
  const left = Math.ceil((ms(item.end) - now) / 60_000);
  const m = minutesBetween(item.start, item.end);
  return (
    <li
      data-key={item.key}
      data-testid="long-rest"
      data-current={isCurrent || undefined}
      aria-current={isCurrent ? "time" : undefined}
      className={cn(
        "rest-band relative my-1.5 grid min-h-12 items-center rounded-lg border",
        COLS,
        isCurrent ? "border-accent/40 bg-accent-soft" : "border-border bg-muted/50",
      )}
    >
      <span className={cn("tnum hidden pl-3 text-sm sm:block", isCurrent ? "font-medium text-accent" : "text-muted-foreground")}>
        {hhmm(item.start)}–{hhmm(item.end)}
      </span>
      <span className="grid place-items-center" aria-hidden>
        <Coffee className={cn("size-4", isCurrent ? "text-accent" : "text-muted-foreground")} />
      </span>
      <span className="col-span-2 min-w-0 sm:col-span-2">
        <span className="block text-base font-medium">Long rest</span>
        <span className="tnum block text-xs sm:hidden">
          <span className="text-muted-foreground">
            {hhmm(item.start)}–{hhmm(item.end)} · {durLong(m)}
          </span>
          {isCurrent && <span className="font-medium text-accent"> · {dur(left)} left</span>}
        </span>
        <span className="tnum hidden text-xs text-muted-foreground sm:block">{durLong(m)} · step away from the screen</span>
      </span>
      <span
        className={cn(
          "tnum hidden pr-2 text-right text-sm sm:block",
          isCurrent ? "font-medium text-accent" : "text-muted-foreground",
        )}
      >
        {isCurrent ? `${dur(left)} left` : dur(m)}
      </span>
      {isCurrent && <ProgressLine value={progress} className="bottom-1" frozen={paused} />}
    </li>
  );
}
