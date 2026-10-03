"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { MotionConfig } from "motion/react";
import { toast } from "sonner";
import { Keyboard } from "lucide-react";
import { useToday } from "@/hooks/use-today";
import { derive } from "@/lib/derive";
import { durLong, hhmm, longDate, ms, pausedForLabel } from "@/lib/time";
import { shiftLabel, shiftSentence, type ShiftContext } from "@/lib/shift-copy";
import type { ItemStatus, PlanItem, ShiftBody, ShiftResult } from "@/lib/types";
import { Timeline } from "./timeline";
import { NowPanel } from "./now-panel";
import { ShiftControl } from "./shift-control";
import { PauseControl } from "./pause-control";
import { SettingsControl } from "./settings-control";
import { describeEffective } from "@/lib/active-hours";
import { HelpDialog } from "./help-dialog";
import { ApiDown, friendlyError, humanHint, LiveBar, LoadingSkeleton, sentence } from "./states";
import { ApiError } from "@/lib/api";
import { DoneEarlier } from "./done-earlier";
import { DayAside } from "./day-aside";

const UNDO_MS = 5000;
const WIDE = "(min-width: 1280px)";
const STALE_PAUSE_SEC = 24 * 3600;
const PAUSED_WHY = "The schedule is paused. Press Resume first — a resume already moves everything forward by the pause.";

interface LastAction {
  key: string;
  prev: ItemStatus;
  at: number;
  toastId: string | number;
}

function useMedia(q: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(q);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(q).matches,
    () => false,
  );
}

const VERB: Record<ItemStatus, string> = { done: "Completed", skipped: "Skipped", pending: "Marked not done" };

export function TodayView({ apiBase, pinnedNow }: { apiBase: string; pinnedNow?: string }) {
  const s = useToday(apiBase, pinnedNow);
  const { data, now, setStatus } = s;
  /**
   * P8: while the plan is paused the timeline is frozen. `now` keeps running (it drives the pause
   * counter), but everything derived from the plan reads the pause instant instead, so the current
   * item, its "N min left" and every progress bar stop advancing.
   */
  const pausedSince = data?.paused ? ms(data.paused.since) : null;
  const pauseElapsedSec = pausedSince !== null ? Math.max(0, (now - pausedSince) / 1000) : null;
  /**
   * Past 24 h the API keeps reporting the pause but stops enforcing it: a resume is 400 (it may not
   * move the plan that far) and a shift is allowed again, so the owner is never stuck. The UI
   * follows — it still shows the pause, but it unfreezes and re-enables Shift, which is the way out.
   */
  const pauseStale = pauseElapsedSec !== null && pauseElapsedSec > STALE_PAUSE_SEC;
  const frozen = pausedSince !== null && !pauseStale;
  // Exactly the pause instant, never min(now, since): `now` is re-aligned to the server on every
  // refetch, and that jitter would leak back into the "frozen" value and creep the progress bars.
  const frozenNow = frozen ? pausedSince! : now;
  const paused =
    pausedSince !== null && data?.paused
      ? { since: data.paused.since, elapsedSec: pauseElapsedSec!, stale: pauseStale }
      : null;
  const d = useMemo(() => derive(data, frozenNow, s.overrides), [data, frozenNow, s.overrides]);
  const wide = useMedia(WIDE);

  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shiftOpen, setShiftOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const last = useRef<LastAction | null>(null);
  const toastFor = useRef(new Map<string, string | number>());
  const scrolledOnce = useRef(false);
  const stickyRef = useRef<HTMLDivElement>(null);
  const [stickyH, setStickyH] = useState(0);

  // The now panel is sticky on phones. Rows keep clear of it through --sticky-h (scroll-margin),
  // so neither the initial scroll nor keyboard navigation can hide it.
  useEffect(() => {
    const el = stickyRef.current;
    if (!el) return;
    const measure = () => setStickyH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  const rowRef = useCallback(
    (key: string) => (el: HTMLLIElement | null) => {
      if (el) rows.current.set(key, el);
      else rows.current.delete(key);
    },
    [],
  );

  // The row that owns the roving tabindex: the focused one, else now, else the next pending task.
  const anchorKey = useMemo(() => {
    if (focusedKey && d.tasks.some((t) => t.key === focusedKey)) return focusedKey;
    if (d.current?.kind === "task") return d.current.key;
    return (d.nextTask ?? d.tasks.find((t) => t.status === "pending") ?? d.tasks[0])?.key ?? null;
  }, [focusedKey, d]);

  // On first data, bring the current item into view (matters on phones).
  useEffect(() => {
    if (!data || scrolledOnce.current) return;
    scrolledOnce.current = true;
    const key = d.current?.key ?? d.nextTask?.key;
    const el = key ? document.querySelector<HTMLElement>(`[data-testid=timeline] [data-key="${CSS.escape(key)}"]`) : null;
    if (el) {
      const r = el.getBoundingClientRect();
      // "start" honours the row's scroll-margin-top, which is the sticky panel's height.
      if (r.bottom > window.innerHeight - 80) el.scrollIntoView({ block: "start" });
    }
  }, [data, d]);

  const focusRow = useCallback((key: string | null | undefined) => {
    if (!key) return;
    setFocusedKey(key);
    const el = rows.current.get(key);
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
    }
  }, []);

  const undo = useCallback(() => {
    const a = last.current;
    if (!a || Date.now() - a.at > UNDO_MS + 250) return false;
    last.current = null;
    toast.dismiss(a.toastId);
    toastFor.current.delete(a.key);
    setStatus(a.key, a.prev).catch((e: unknown) =>
      toast.error("Undo failed", { description: e instanceof Error ? e.message : String(e) }),
    );
    return true;
  }, [setStatus]);

  /** Optimistic status change with a 5 s undo toast. `useToday` applies the override in this event. */
  const change = useCallback(
    (item: PlanItem, next: ItemStatus) => {
      const prev = item.status;
      if (prev === next) return;
      const p = setStatus(item.key, next);
      const stale = toastFor.current.get(item.key);
      if (stale !== undefined) toast.dismiss(stale);
      const toastId = toast(VERB[next], {
        description: item.title,
        duration: UNDO_MS,
        action: { label: "Undo", onClick: () => undo() },
      });
      last.current = { key: item.key, prev, at: Date.now(), toastId };
      toastFor.current.set(item.key, toastId);
      setTimeout(() => {
        if (toastFor.current.get(item.key) === toastId) toastFor.current.delete(item.key);
      }, UNDO_MS);
      p.catch((e: unknown) => {
        toast.dismiss(toastId);
        toastFor.current.delete(item.key);
        last.current = null;
        toast.error("Couldn't save that change", {
          description: `${item.title} is back to ${prev === "pending" ? "not done" : prev}. ${friendlyError(e instanceof Error ? e.message : String(e)) ?? ""}`,
          duration: 6000,
        });
      });
    },
    [setStatus, undo],
  );

  const toggle = useCallback((item: PlanItem) => change(item, item.status === "pending" ? "done" : "pending"), [change]);
  const skip = useCallback((item: PlanItem) => change(item, item.status === "skipped" ? "pending" : "skipped"), [change]);

  /** What the preview and the toast need beyond the API's counts: the target day and what it costs. */
  const shiftCtx: ShiftContext = useMemo(() => {
    const ahead = d.items.filter((i) => i.kind === "task" && ms(i.start) >= frozenNow);
    return {
      date: data?.date ?? "",
      movingTasks: ahead.filter((i) => i.status === "pending").length,
      droppedTitles: ahead.filter((i) => i.status === "pending" && i.taskUid?.endsWith("/DAILY")).map((i) => i.title),
    };
  }, [d.items, frozenNow, data]);

  const onShifted = useCallback(
    async (body: ShiftBody, r: ShiftResult) => {
      const title = `Shifted by ${shiftLabel(body)}`;
      const description = shiftSentence(body, r, shiftCtx);
      const id = toast(title, { description, duration: 6000 });
      const t = await s.refetch();
      // For day shifts, say where the work went, with the real start time of that day.
      if (body.unit === "days" && t?.upcoming) {
        try {
          const p = await s.api.plan(t.upcoming.date, 1);
          const first = p.days[0]?.items[0];
          const where = `${longDate(t.upcoming.date)} starts with ${t.upcoming.firstTitle}${first ? ` at ${hhmm(first.start)}` : ""}.`;
          toast(title, { id, description: `${description}. ${where}`, duration: 7000 });
        } catch {
          /* the first toast stands */
        }
      }
    },
    [s, shiftCtx],
  );

  /**
   * Pause / Resume. A pause moves nothing, so it only needs the button to flip and the timeline to
   * freeze. A resume reports the exact amount everything moved, from the API's `pausedSec`.
   */
  const togglePause = useCallback(async () => {
    if (pauseBusy || !data) return;
    const wasPaused = pausedSince !== null;
    setPauseBusy(true);
    try {
      if (wasPaused) {
        const r = await s.api.resume();
        toast("Resumed", {
          description: `everything moved ${pausedForLabel(r.pausedSec)} later${r.endOfDay ? ` · today ends ${hhmm(r.endOfDay)}` : ""}`,
          duration: 6000,
        });
      } else {
        await s.api.pause();
      }
      await s.refetch();
    } catch (e) {
      // 409 means this client's view of the pause was stale: say so and take the server's word.
      // The hint is written for an API caller, so it is cleaned of any request body first.
      const conflict = e instanceof ApiError && (e.code === "CONFLICT" || e.code === "PAUSED");
      const base = e instanceof ApiError ? sentence(e.message) : String(e);
      const hint = e instanceof ApiError ? humanHint(e.hint) : null;
      const msg = [base, hint].filter(Boolean).join(" ");
      toast.error(wasPaused ? "Couldn't resume" : "Couldn't pause", {
        description: conflict ? `${msg} The page has been refreshed.` : (friendlyError(msg) ?? msg),
        duration: 6000,
      });
      await s.refetch();
    } finally {
      setPauseBusy(false);
    }
  }, [pauseBusy, data, pausedSince, s]);

  const reviewMissed = useCallback(() => focusRow(d.missed[0]?.key), [d.missed, focusRow]);

  // ---- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true]")) return;
      if (helpOpen || shiftOpen || settingsOpen) return; // dialogs own the keyboard (Esc closes them)
      if (!data) return;
      const inRow = t.closest<HTMLElement>("[data-testid=task-row]");
      const targetKey = inRow?.dataset.key ?? null;
      const tasks = d.tasks;
      const idx = tasks.findIndex((x) => x.key === (targetKey ?? focusedKey));
      const item = inRow ? tasks[idx] : undefined;
      const k = e.key;
      if (k === "?") {
        e.preventDefault();
        setHelpOpen(true);
      } else if (k === "s") {
        e.preventDefault();
        if (frozen) toast("Paused — resume first", { description: PAUSED_WHY, duration: 4000 });
        else setShiftOpen(true);
      } else if (k === "p") {
        e.preventDefault();
        void togglePause();
      } else if (k === "u") {
        e.preventDefault();
        undo();
      } else if (k === "n") {
        e.preventDefault();
        focusRow(d.current?.kind === "task" ? d.current.key : anchorKey);
      } else if (k === "j" || k === "ArrowDown") {
        e.preventDefault();
        if (!inRow) focusRow(anchorKey);
        else focusRow(tasks[Math.min(tasks.length - 1, idx + 1)]?.key);
      } else if (k === "k" || k === "ArrowUp") {
        e.preventDefault();
        if (!inRow) focusRow(anchorKey);
        else focusRow(tasks[Math.max(0, idx - 1)]?.key);
      } else if (k === "x" || (k === " " && inRow === t)) {
        if (!item) return;
        e.preventDefault();
        toggle(item);
      } else if (k === "d") {
        if (!item) return;
        e.preventDefault();
        skip(item);
      } else if (k === "o" || (k === "Enter" && inRow === t)) {
        if (!item) return;
        e.preventDefault();
        const url = item.links?.[0]?.url;
        if (url) window.open(url, "_blank", "noopener,noreferrer");
        else toast("No link for this task", { description: item.title, duration: 2500 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data, d, focusedKey, anchorKey, helpOpen, shiftOpen, settingsOpen, focusRow, toggle, skip, undo, togglePause, frozen]);

  const showDown = s.conn === "down";
  const doneEarlier = <DoneEarlier items={d.checked} onToggle={toggle} compact={wide} />;

  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}>
      <div
        style={{ ["--sticky-h" as string]: `${stickyH + 12}px` }}
        className="mx-auto w-full max-w-3xl px-4 pt-5 pb-28 sm:px-6 sm:pt-8 xl:grid xl:max-w-[1200px] xl:grid-cols-[minmax(0,1fr)_300px] xl:gap-10"
      >
        <main className="min-w-0">
          {/*
            * Three controls plus a long date do not fit on 390 px. The title row keeps the
            * controls; below sm the date moves to the front of the summary line, which already
            * spans the full width, so nothing truncates and no row is added.
            */}
          <header className="mb-4">
            <div className="flex items-center justify-between gap-3">
              <h1 className="flex min-w-0 items-baseline gap-2.5 text-xl font-semibold tracking-tight">
                Today
                <span className="truncate text-base font-normal text-muted-foreground max-sm:hidden" data-testid="date">
                  {data ? longDate(data.date) : " "}
                </span>
              </h1>
              <div className="flex shrink-0 items-center gap-1.5">
              <ShiftControl
                api={s.api}
                open={shiftOpen}
                onOpenChange={setShiftOpen}
                dayEnd={d.dayEnd}
                ctx={shiftCtx}
                onShifted={(b, r) => void onShifted(b, r)}
                onError={(m) => toast.error("Shift failed", { description: friendlyError(m) ?? m })}
                disabled={!data || showDown || frozen}
                disabledReason={frozen ? PAUSED_WHY : undefined}
              />
              <PauseControl
                elapsedSec={pauseElapsedSec}
                busy={pauseBusy}
                disabled={!data || showDown}
                onToggle={() => void togglePause()}
              />
              <SettingsControl
                api={s.api}
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                disabled={showDown}
                onSaved={(saved, regenerated) => {
                  const c = describeEffective(saved);
                  // The effective figure, not the request: a window that cannot hold the budget is
                  // the one thing about this setting that would otherwise look like a bug.
                  toast.success("Working hours saved", {
                    description: c.warning ? `${c.main}. ${c.warning}` : `${c.main}${regenerated.length ? ` · ${regenerated.length} day${regenerated.length === 1 ? "" : "s"} re-planned` : ""}`,
                  });
                }}
                onError={(m) => toast.error("Could not save the hours", { description: friendlyError(m) ?? m })}
              />
              <button
                type="button"
                onClick={() => setHelpOpen(true)}
                aria-label="Keyboard shortcuts"
                data-testid="help-trigger"
                className="grid size-10 place-items-center rounded-lg text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground sm:size-8"
              >
                <Keyboard className="size-4" aria-hidden />
              </button>
              </div>
            </div>

            <p className="tnum mt-0.5 min-h-[18px] text-sm text-muted-foreground" data-testid="summary">
              {data && (
                <>
                  <span className="sm:hidden" data-testid="date-mobile">
                    {longDate(data.date)}
                  </span>
                  {d.total > 0 && (
                    <>
                      <span className="sm:hidden">{" · "}</span>
                      <span className="font-medium text-foreground" data-testid="count">
                        {d.done}/{d.total}
                      </span>{" "}
                      done
                      <span className="max-sm:hidden xl:hidden">
                        {" · "}
                        {d.minutesLeft > 0
                          ? `${durLong(d.minutesLeft)} of work left`
                          : d.missed.length
                            ? `${d.missed.length} open from earlier`
                            : "no work left"}
                      </span>
                      {d.dayEnd && (
                        <>
                          {" · "}ends {hhmm(d.dayEnd)}
                        </>
                      )}
                    </>
                  )}
                </>
              )}
            </p>
          </header>

          {!data && s.conn === "loading" && <LoadingSkeleton />}
          {!showDown && data && !s.live && <LiveBar onRetry={() => void s.refetch()} />}
          {showDown && (
            <div className={data ? "mb-4" : ""}>
              <ApiDown base={s.api.base} error={s.error} retryIn={s.retryIn} onRetry={() => void s.refetch()} />
            </div>
          )}
          {data && (
            <>
              <div
                ref={stickyRef}
                className="sticky top-0 z-20 -mx-4 bg-background px-4 pt-1 pb-2 sm:static sm:mx-0 sm:px-0 sm:pt-0 sm:pb-0"
              >
                <NowPanel
                  d={d}
                  now={frozenNow}
                  paused={paused}
                  date={data.date}
                  upcoming={data.upcoming}
                  upcomingStart={s.upcomingStart}
                  onReviewMissed={reviewMissed}
                />
              </div>
              <div className="mt-2 -mx-1 sm:mt-4 sm:mx-0">
                <Timeline
                  items={d.items}
                  now={frozenNow}
                  paused={frozen}
                  currentKey={d.current?.key ?? null}
                  progress={d.currentProgress}
                  focusedKey={anchorKey}
                  lateStates={d.lateStates}
                  onFocusRow={setFocusedKey}
                  onToggle={toggle}
                  onSkip={skip}
                  rowRef={rowRef}
                />
              </div>
              {d.tasks.length > 0 && (
                <p className="mt-3 pl-1 text-xs text-muted-foreground max-sm:hidden sm:pl-3">
                  <button type="button" className="underline-offset-2 hover:underline" onClick={() => setHelpOpen(true)}>
                    press ? for keys
                  </button>
                </p>
              )}
              {!wide && doneEarlier}
            </>
          )}
        </main>
        <div className="hidden xl:block">
          {data && (
            <div className="sticky top-8 pt-[68px]">
              <DayAside d={d} tracks={s.tracks}>
                {wide && doneEarlier}
              </DayAside>
            </div>
          )}
        </div>
      </div>
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </MotionConfig>
  );
}
