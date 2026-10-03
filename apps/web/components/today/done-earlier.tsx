"use client";

import { CheckCircle } from "./check-circle";
import { cn } from "@/lib/utils";
import { hhmm } from "@/lib/time";
import { track } from "@/lib/tracks";
import type { PlanItem } from "@/lib/types";

/**
 * `day.checked`: done or skipped items that lost their timeline slot (a shift, a regeneration).
 * They keep their original times. Unchecking one asks the API to re-plan the task.
 */
export function DoneEarlier({
  items,
  onToggle,
  compact,
}: {
  items: PlanItem[];
  onToggle(item: PlanItem): void;
  compact?: boolean;
}) {
  if (!items.length) return null;
  return (
    <section data-testid="done-earlier" aria-labelledby="done-earlier-h" className={cn(!compact && "mt-6")}>
      <h2 id="done-earlier-h" className="flex items-baseline gap-2 px-1 text-sm font-semibold sm:px-3">
        Done earlier <span className="tnum font-normal text-muted-foreground">({items.length})</span>
      </h2>
      <p className="px-1 text-xs text-muted-foreground sm:px-3">Checked, then moved off the timeline. Shown at their original times.</p>
      <ul className="mt-1 flex flex-col">
        {items.map((it) => {
          const t = track(it.track);
          const done = it.status !== "pending";
          const s = it.plannedStart ?? it.start;
          const e = it.plannedEnd ?? it.end;
          return (
            <li
              key={it.key}
              data-testid="checked-row"
              data-key={it.key}
              className={cn(
                "grid min-h-10 items-center rounded-lg",
                compact
                  ? "grid-cols-[40px_minmax(0,1fr)]"
                  : "grid-cols-[40px_minmax(0,1fr)] sm:grid-cols-[92px_40px_minmax(0,1fr)_auto]",
              )}
            >
              {!compact && <span className="tnum hidden pl-3 text-sm text-muted-foreground sm:block">{hhmm(s)}–{hhmm(e)}</span>}
              <CheckCircle
                checked={done}
                skipped={it.status === "skipped"}
                color={t.color}
                label={`${done ? "Mark not done" : "Complete"}: ${it.title}`}
                onToggle={() => onToggle(it)}
              />
              <div className="min-w-0">
                <p
                  title={it.title}
                  className={cn(
                    "truncate text-sm line-through decoration-transparent transition-[color,text-decoration-color] duration-200",
                    done && "text-muted-foreground decoration-muted-foreground",
                  )}
                >
                  {it.title}
                </p>
                <p className={cn("tnum text-xs text-muted-foreground", !compact && "sm:hidden")}>
                  {hhmm(s)}–{hhmm(e)} · <span style={{ color: t.color }}>{t.label}</span>
                  {it.status === "skipped" && " · skipped"}
                </p>
              </div>
              {!compact && (
                <span className="hidden pr-2 text-xs font-medium sm:inline" style={{ color: t.color }}>
                  {t.label}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
