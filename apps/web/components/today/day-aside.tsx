"use client";

import type { Derived } from "@/lib/derive";
import { durLong } from "@/lib/time";
import { track } from "@/lib/tracks";
import type { TrackInfo } from "@/lib/types";

function Ring({ value }: { value: number }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 80 80" className="size-20 -rotate-90" aria-hidden>
      <circle cx="40" cy="40" r={r} fill="none" strokeWidth="6" className="stroke-border" />
      <circle
        cx="40"
        cy="40"
        r={r}
        fill="none"
        strokeWidth="6"
        strokeLinecap="round"
        className="stroke-accent transition-[stroke-dashoffset] duration-300 ease-out"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, Math.max(0, value)))}
      />
    </svg>
  );
}

/** Right column at ≥ 1280 px: the day at a glance. Uses only width the timeline does not need. */
export function DayAside({ d, tracks, children }: { d: Derived; tracks: TrackInfo[] | null; children?: React.ReactNode }) {
  const shown = (tracks ?? []).filter((t) => t.kind === "prep" || t.active);
  return (
    <aside data-testid="day-aside" aria-label="Day overview" className="flex flex-col gap-6">
      <section className="flex items-center gap-4 rounded-xl border bg-surface p-4">
        <div className="relative grid place-items-center">
          <Ring value={d.total ? d.done / d.total : 0} />
          <span className="tnum absolute text-sm font-semibold" data-testid="aside-count">
            {d.done}/{d.total}
          </span>
        </div>
        <div className="min-w-0 text-sm">
          <p className="font-medium">Tasks done</p>
          <p className="tnum text-muted-foreground">{d.minutesDone > 0 ? `${durLong(d.minutesDone)} done` : "nothing done yet"}</p>
          <p className="tnum text-muted-foreground">
            {d.minutesLeft > 0 ? `${durLong(d.minutesLeft)} to go` : "nothing left"}
          </p>
          {d.missed.length > 0 && (
            <p className="tnum font-medium text-warning">{d.missed.length} open from earlier</p>
          )}
        </div>
      </section>


      {shown.length > 0 && (
        <section aria-labelledby="tracks-h">
          <h2 id="tracks-h" className="px-1 text-sm font-semibold">
            Tracks
          </h2>
          <ul className="mt-2 flex flex-col gap-3" data-testid="aside-tracks">
            {shown.map((t) => {
              const meta = track(t.track);
              const closed = t.done + t.skipped;
              return (
                <li key={t.track} className="px-1">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-medium" style={{ color: meta.color }}>
                      {meta.label}
                    </span>
                    <span className="tnum text-xs text-muted-foreground">
                      {t.total > 1 ? `${closed}/${t.total} · ${durLong(t.remainingMin)} left` : t.active ? "today" : "later"}
                    </span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-border" aria-hidden>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${t.total ? (closed / t.total) * 100 : 0}%`, background: meta.color }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {children}
    </aside>
  );
}
