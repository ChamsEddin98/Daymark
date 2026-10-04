"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { ApiError, type ApiClient } from "@/lib/api";
import { hhmm } from "@/lib/time";
import { describeShift, type ShiftContext } from "@/lib/shift-copy";
import type { ShiftBody, ShiftResult, ShiftUnit } from "@/lib/types";

const PRESETS: { id: string; label: string; body: ShiftBody }[] = [
  { id: "15m", label: "+15 min", body: { amount: 15, unit: "minutes" } },
  { id: "30m", label: "+30 min", body: { amount: 30, unit: "minutes" } },
  { id: "1h", label: "+1 hour", body: { amount: 1, unit: "hours" } },
  { id: "1d", label: "+1 day", body: { amount: 1, unit: "days" } },
];

type Preview = { ok: true; r: ShiftResult } | { ok: false; message: string };

interface Props {
  api: ApiClient;
  open: boolean;
  onOpenChange(open: boolean): void;
  dayEnd: string | null;
  ctx: ShiftContext;
  onShifted(body: ShiftBody, result: ShiftResult): void;
  onError(message: string): void;
  disabled?: boolean;
  /** Why it is disabled, for the tooltip and the aria description (P8: "resume first"). */
  disabledReason?: string;
}

function toPreview(e: unknown): Preview {
  if (e instanceof ApiError && e.code === "PAUSED") return { ok: false, message: "Paused — resume first" };
  if (e instanceof ApiError && e.code === "CONFLICT") return { ok: false, message: "Nothing left to shift" };
  return { ok: false, message: e instanceof Error ? e.message : String(e) };
}

function Outcome({ body, p, testId, ctx }: { body: ShiftBody; p: Preview | undefined; testId: string; ctx: ShiftContext }) {
  if (!p) return <span data-testid={testId} className="text-muted-foreground">…</span>;
  if (!p.ok) return <span data-testid={testId} className="text-muted-foreground">{p.message}</span>;
  const c = describeShift(body, p.r, ctx);
  return (
    <span className="flex min-w-0 flex-col items-end gap-0.5 text-right">
      <span data-testid={testId} className="text-foreground">
        {c.main}
      </span>
      {c.detail && (
        <span data-testid={`${testId}-detail`} className="text-xs text-muted-foreground">
          {c.detail}
        </span>
      )}
      {c.warning && (
        <span data-testid={`${testId}-warning`} className="flex items-center gap-1 text-xs font-medium text-warning">
          <AlertTriangle className="size-3 shrink-0" aria-hidden />
          {c.warning}
        </span>
      )}
    </span>
  );
}

/**
 * Shift in two interactions: open (click or `s`), then pick an option. Every option already shows
 * its preview (from POST /plan/shift/preview, fetched in parallel on open), so the pick is the
 * confirmation. Custom amounts preview as you type and confirm with Enter.
 */
export function ShiftControl({ api, open, onOpenChange, dayEnd, ctx, onShifted, onError, disabled, disabledReason }: Props) {
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [amount, setAmount] = useState("45");
  const [unit, setUnit] = useState<ShiftUnit>("minutes");
  const [custom, setCustom] = useState<Preview | undefined>();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    setPreviews({});
    for (const p of PRESETS) {
      api.previewShift(p.body, ctl.signal).then(
        (r) => setPreviews((prev) => ({ ...prev, [p.id]: { ok: true, r } })),
        (e) => !ctl.signal.aborted && setPreviews((prev) => ({ ...prev, [p.id]: toPreview(e) })),
      );
    }
    return () => ctl.abort();
  }, [open, api]);

  const n = Number(amount);
  const customBody: ShiftBody | null = Number.isFinite(n) && n > 0 ? { amount: n, unit } : null;

  useEffect(() => {
    if (!open || !customBody) {
      setCustom(undefined);
      return;
    }
    const ctl = new AbortController();
    const id = setTimeout(() => {
      api.previewShift(customBody, ctl.signal).then(
        (r) => setCustom({ ok: true, r }),
        (e) => !ctl.signal.aborted && setCustom(toPreview(e)),
      );
    }, 150);
    return () => {
      clearTimeout(id);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, api, amount, unit]);

  const confirm = useCallback(
    async (id: string, body: ShiftBody) => {
      setBusy(id);
      try {
        const r = await api.shift(body);
        onShifted(body, r);
        onOpenChange(false);
      } catch (e) {
        onError(
          e instanceof ApiError && e.code === "PAUSED"
            ? "The schedule is paused. Resume it first — a pause already moves everything forward."
            : e instanceof ApiError && e.code === "CONFLICT"
              ? "Nothing left to shift."
              : e instanceof Error
                ? e.message
                : String(e),
        );
      } finally {
        setBusy(null);
      }
    },
    [api, onShifted, onOpenChange, onError],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "SELECT") return;
    const idx = ["1", "2", "3", "4"].indexOf(e.key);
    if (idx >= 0) {
      e.preventDefault();
      void confirm(PRESETS[idx]!.id, PRESETS[idx]!.body);
      return;
    }
    if (["ArrowDown", "ArrowUp", "j", "k"].includes(e.key)) {
      e.preventDefault();
      const buttons = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-shift-option]") ?? []);
      const i = buttons.indexOf(document.activeElement as HTMLElement);
      const d = e.key === "ArrowDown" || e.key === "j" ? 1 : -1;
      buttons[(i + d + buttons.length) % buttons.length]?.focus();
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/*
       * The wrapper carries `title` because a disabled button gets no pointer events of its own,
       * and `aria-describedby` names the same reason for assistive tech. The control is disabled,
       * never hidden, so "Shift" stays where it was and explains itself.
       */}
      <span title={disabled && disabledReason ? disabledReason : undefined} className="inline-flex">
        <PopoverTrigger
          disabled={disabled}
          data-testid="shift-trigger"
          aria-describedby={disabled && disabledReason ? "shift-disabled-why" : undefined}
          className={cn(
            "inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-sm font-medium sm:h-8 sm:px-3",
            // Icon only on a phone: four labelled controls left 34 px for a 60 px "Today", so the
            // view's own name rendered as "Toda". 40x40 keeps the touch target.
            "max-sm:w-10 max-sm:justify-center max-sm:px-0",
            "transition-colors duration-150 hover:bg-muted aria-expanded:bg-muted disabled:opacity-50",
          )}
        >
          <CalendarClock className="size-4 text-muted-foreground" aria-hidden />
          {/* sr-only, not hidden: this text *is* the button's accessible name. */}
          <span className="max-sm:sr-only">Shift</span>
          <Kbd className="hidden sm:inline-flex">S</Kbd>
        </PopoverTrigger>
      </span>
      {disabled && disabledReason && (
        <span id="shift-disabled-why" data-testid="shift-disabled-why" className="sr-only">
          {disabledReason}
        </span>
      )}
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[min(24rem,calc(100vw-2rem))] gap-0 p-1.5"
        data-testid="shift-popover"
      >
        <div ref={listRef} onKeyDown={onKeyDown}>
          <div className="flex items-baseline justify-between px-2 pt-1 pb-2">
            <p className="text-sm font-semibold">Shift everything from now</p>
            {dayEnd && (
              <p className="tnum text-xs text-muted-foreground">
                today ends <span className="text-foreground">{hhmm(dayEnd)}</span>
              </p>
            )}
          </div>
          <ul className="flex flex-col">
            {PRESETS.map((p, i) => (
              <li key={p.id}>
                <button
                  type="button"
                  data-shift-option
                  data-testid={`shift-${p.id}`}
                  autoFocus={i === 0}
                  disabled={busy !== null}
                  onClick={() => void confirm(p.id, p.body)}
                  className={cn(
                    "group flex min-h-10 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none",
                    "transition-colors duration-150 hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  <Kbd className="w-5 shrink-0 self-start mt-0.5">{i + 1}</Kbd>
                  <span className="w-16 shrink-0 self-start pt-0.5 font-medium">{p.label}</span>
                  <span className="tnum flex min-w-0 flex-1 justify-end">
                    <Outcome body={p.body} p={previews[p.id]} testId={`preview-${p.id}`} ctx={ctx} />
                  </span>
                  {busy === p.id && <Loader2 className="size-4 animate-spin" aria-hidden />}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="mt-1 border-t px-2 pt-2 pb-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (customBody) void confirm("custom", customBody);
            }}
          >
            <label className="text-xs font-medium text-muted-foreground" htmlFor="shift-amount">
              Custom
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id="shift-amount"
                data-testid="shift-amount"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                className="tnum h-10 w-16 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
                aria-label="Custom amount"
              />
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value as ShiftUnit)}
                data-testid="shift-unit"
                aria-label="Unit"
                className="h-10 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
              >
                <option value="minutes">min</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
              <button
                type="submit"
                data-testid="shift-custom"
                disabled={!customBody || busy !== null}
                className="ml-auto h-10 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity duration-150 hover:opacity-90 disabled:opacity-40 sm:h-8"
              >
                Shift
              </button>
            </div>
            <div className="tnum mt-1.5 flex min-h-4 justify-start text-xs">
              {customBody ? (
                <span className="[&>span]:items-start [&>span]:text-left">
                  <Outcome body={customBody} p={custom} testId="preview-custom" ctx={ctx} />
                </span>
              ) : (
                <span className="text-muted-foreground" data-testid="preview-custom">
                  Enter an amount above 0
                </span>
              )}
            </div>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  );
}
