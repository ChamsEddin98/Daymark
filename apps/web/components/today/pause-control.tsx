"use client";

import { Loader2, Pause, Play } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { clockDur } from "@/lib/time";

interface Props {
  /** Seconds the pause has run, from the server-aligned clock. `null` when the plan is running. */
  elapsedSec: number | null;
  busy?: boolean;
  disabled?: boolean;
  onToggle(): void;
}

/**
 * Pause / Resume, beside Shift and with the same visual weight (same height, border, surface and
 * type). The two labels sit in one grid cell, and an invisible sizer holds the widest of them, so
 * the box never changes size when the label does: swapping Pause for "Resume 1:12" causes no
 * layout shift, and the counter's tabular digits keep it steady as it ticks.
 */
export function PauseControl({ elapsedSec, busy, disabled, onToggle }: Props) {
  const paused = elapsedSec !== null;
  const counter = clockDur(elapsedSec ?? 0);
  return (
    <button
      type="button"
      onClick={onToggle}
      // Only the real "nothing to act on" case disables the button. A disabled element loses
      // focus, so the in-flight state is aria-busy instead: pressing it never drops the keyboard.
      disabled={disabled}
      aria-busy={busy || undefined}
      data-testid="pause-toggle"
      data-paused={paused || undefined}
      data-label={paused ? "Resume" : "Pause"}
      aria-label={paused ? "Resume the schedule" : "Pause the schedule"}
      title={paused ? "Resume: push everything still to come forward by the pause" : "Pause: freeze the plan while you step away"}
      className={cn(
        "relative inline-grid h-10 place-items-center rounded-lg border px-2.5 text-sm font-medium sm:h-8 sm:px-3",
        "transition-colors duration-200 ease-out disabled:opacity-50",
        paused
          ? "border-accent/45 bg-accent-soft text-accent hover:bg-accent/15"
          : "border-border bg-surface text-foreground hover:bg-muted",
      )}
    >
      {/* Sizer: never shown, but it fixes the width at the widest label the button can hold. */}
      <span aria-hidden className="invisible col-start-1 row-start-1 flex items-center gap-2 whitespace-nowrap">
        <Play className="size-4" />
        Resume
        <span className="tnum">99:59</span>
      </span>
      <span
        aria-hidden={paused}
        className={cn(
          "col-start-1 row-start-1 flex items-center gap-2 whitespace-nowrap transition-opacity duration-200 ease-out",
          paused && "invisible opacity-0",
        )}
      >
        <Pause className="size-4 text-muted-foreground" />
        Pause
        <Kbd className="hidden sm:inline-flex">P</Kbd>
      </span>
      <span
        aria-hidden={!paused}
        className={cn(
          "col-start-1 row-start-1 flex items-center gap-2 whitespace-nowrap transition-opacity duration-200 ease-out",
          !paused && "invisible opacity-0",
        )}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
        Resume
        {/* aria-hidden: the ticking number must not be announced every second. */}
        <span className="tnum font-semibold" data-testid="pause-elapsed" aria-hidden>
          {counter}
        </span>
      </span>
    </button>
  );
}
