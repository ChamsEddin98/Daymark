"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Settings2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ApiError, type ApiClient } from "@/lib/api";
import {
  budgetLabel,
  describeEffective,
  draftError,
  draftOf,
  endLabel,
  patchOf,
  sameDraft,
  type HoursDraft,
} from "@/lib/active-hours";
import type { SettingsResponse } from "@/lib/types";

interface Props {
  api: ApiClient;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSaved(s: SettingsResponse, regenerated: string[]): void;
  onError(message: string): void;
  disabled?: boolean;
}

/** The windows most people actually want, so the common case is one click rather than three fields. */
const PRESETS: { id: string; label: string; draft: HoursDraft }[] = [
  { id: "default", label: "Standard", draft: { dayStart: "08:00", dayEnd: "24:00", hours: 8 } },
  { id: "nine-to-six", label: "9 to 6", draft: { dayStart: "09:00", dayEnd: "18:00", hours: 6 } },
  { id: "long", label: "Long days", draft: { dayStart: "08:00", dayEnd: "22:30", hours: 10 } },
  { id: "evenings", label: "Evenings", draft: { dayStart: "18:00", dayEnd: "23:00", hours: 4 } },
];

/**
 * The owner's working hours: when a day may start, when it must stop, and how much work it holds.
 *
 * The screen has to carry one idea that the numbers alone do not: **the clock cost of work is
 * stepped**, because every 4 h of task time buys an hour of long rest. So "10 hours" inside an
 * 08:00–20:00 window silently becomes 8. Rather than let that look like a bug, the panel always
 * shows what the window *actually grants* — read back from the server after saving, never guessed
 * here — and when the window is the limit it says so and names the fix.
 */
export function SettingsControl({ api, open, onOpenChange, onSaved, onError, disabled }: Props) {
  const [loaded, setLoaded] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<HoursDraft | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    api.settings(ctl.signal).then(
      (s) => {
        setLoaded(s);
        setDraft(draftOf(s.activeHours));
      },
      (e) => {
        if (!ctl.signal.aborted) onError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => ctl.abort();
  }, [open, api, onError]);

  const error = draft ? draftError(draft) : null;
  const dirty = !!draft && !!loaded && !sameDraft(draft, draftOf(loaded.activeHours));

  const save = useCallback(async () => {
    if (!draft || error) return;
    setBusy(true);
    try {
      const r = await api.saveSettings(patchOf(draft));
      // Re-read, because what the window grants is the server's answer, not something to infer.
      const fresh = await api.settings();
      setLoaded(fresh);
      setDraft(draftOf(fresh.activeHours));
      onSaved(fresh, r.regenerated ?? []);
      onOpenChange(false);
    } catch (e) {
      onError(e instanceof ApiError ? `${e.message}${e.hint ? ` ${e.hint}` : ""}` : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, draft, error, onSaved, onOpenChange, onError]);

  const set = (patch: Partial<HoursDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const eff = loaded ? describeEffective(loaded) : null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        disabled={disabled}
        data-testid="settings-trigger"
        aria-label="Working hours"
        title="Working hours: when your day starts and ends, and how much it holds"
        className={cn(
          "grid size-10 place-items-center rounded-lg text-muted-foreground sm:size-8",
          "transition-colors duration-150 hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground disabled:opacity-50",
        )}
      >
        <Settings2 className="size-4" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        // The popover is a dialog, so it needs a name of its own: without one a screen reader
        // announces an unlabelled dialog (axe: aria-dialog-name).
        aria-label="Working hours"
        className="w-[min(23rem,calc(100vw-2rem))] gap-0 p-1.5"
        data-testid="settings-popover"
      >
        <div className="px-2 pt-1 pb-2">
          <p className="text-sm font-semibold">Working hours</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Your limits, used for every day.</p>
        </div>

        {!draft || !loaded ? (
          <div className="flex min-h-28 items-center justify-center" data-testid="settings-loading">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1 px-2 pb-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`settings-preset-${p.id}`}
                  data-active={sameDraft(draft, p.draft) || undefined}
                  onClick={() => set(p.draft)}
                  className={cn(
                    "rounded-md border border-border px-2 py-1 text-xs font-medium outline-none",
                    "transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                    "data-[active]:border-accent data-[active]:text-accent",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 px-2 py-1">
              <label htmlFor="ah-start" className="text-sm">
                Day starts
              </label>
              <Input
                id="ah-start"
                type="time"
                data-testid="settings-start"
                value={draft.dayStart}
                onChange={(e) => set({ dayStart: e.target.value })}
                className="tnum h-9 w-28 sm:h-8"
              />

              <label htmlFor="ah-end" className="text-sm">
                Day ends
                <span className="ml-1.5 text-xs text-muted-foreground">{draft.dayEnd === "24:00" ? "midnight" : ""}</span>
              </label>
              {/*
               * A text field, not `type="time"`: the API's "24:00" means "no fence", and a native
               * time input cannot hold it (it clamps to 23:59). The owner can type it.
               */}
              <Input
                id="ah-end"
                type="text"
                inputMode="numeric"
                placeholder="24:00"
                data-testid="settings-end"
                value={draft.dayEnd}
                onChange={(e) => set({ dayEnd: e.target.value.trim() })}
                className="tnum h-9 w-28 sm:h-8"
              />

              <label htmlFor="ah-hours" className="text-sm">
                Hours a day
                <span className="ml-1.5 text-xs text-muted-foreground">of work, rests on top</span>
              </label>
              <Input
                id="ah-hours"
                type="number"
                min="0.25"
                max="24"
                step="0.5"
                data-testid="settings-hours"
                value={String(draft.hours)}
                onChange={(e) => set({ hours: Number(e.target.value) })}
                className="tnum h-9 w-28 sm:h-8"
              />
            </div>

            <div className="px-2 pt-1.5 pb-1" aria-live="polite">
              {error ? (
                <p data-testid="settings-error" className="text-xs font-medium text-warning">
                  {error}
                </p>
              ) : (
                <>
                  <p data-testid="settings-effective" className="text-xs text-muted-foreground">
                    {dirty ? `Will apply ${budgetLabel(patchOf(draft).dailyTaskMin)} a day, ${draft.dayStart} to ${endLabel(draft.dayEnd)}` : eff?.main}
                  </p>
                  {!dirty && eff?.warning && (
                    <p data-testid="settings-warning" className="mt-1 flex items-start gap-1 text-xs font-medium text-warning">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                      {eff.warning}
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center justify-end gap-1.5 px-2 pt-1 pb-1">
              <button
                type="button"
                data-testid="settings-cancel"
                onClick={() => onOpenChange(false)}
                className="h-9 rounded-md px-2.5 text-sm text-muted-foreground outline-none transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="settings-save"
                disabled={!dirty || !!error || busy}
                aria-busy={busy || undefined}
                onClick={() => void save()}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground outline-none sm:h-8",
                  "transition-colors duration-150 hover:bg-accent/90 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                )}
              >
                {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                Save
              </button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
