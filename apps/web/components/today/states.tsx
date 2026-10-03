"use client";

import { useState } from "react";
import { Check, Copy, PlugZap, RotateCw, WifiOff } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

/** Same geometry as the real header + rows, so swapping it out causes no layout shift. */
export function LoadingSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading today" data-testid="skeleton">
      <Skeleton className="h-[92px] rounded-xl" />
      <div className="mt-5 flex flex-col">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i}>
            <div className="flex h-14 items-center gap-3 px-2 sm:h-11">
              <Skeleton className="hidden h-3 w-20 sm:block" />
              <Skeleton className="size-5 rounded-full" />
              <Skeleton className="h-3.5" style={{ width: `${38 + ((i * 17) % 34)}%` }} />
            </div>
            {i < 9 && <div className="h-6" />}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/60 py-1 pr-1 pl-3 font-mono text-sm">
      <span className="text-muted-foreground select-none">$</span>
      <code className="flex-1" data-testid={command.endsWith("npm start") ? "start-command" : undefined}>
        {command}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="grid size-10 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-background hover:text-foreground sm:size-8"
        aria-label={copied ? "Copied" : "Copy command"}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

/**
 * An API `hint` is written for whoever is calling the API, so it may carry a request body
 * (`Shift whole days instead ({ "amount": 1, "unit": "days" }); that clears the pause.`). A JSON
 * fragment is noise in a toast, so it is removed and the sentence closed up. If anything
 * machine-shaped survives, the whole hint is dropped rather than shown half-cooked.
 */
/** The endpoint behind a control is that control's name on this page, never its method and path. */
const CONTROL: Record<string, string> = {
  pause: "Pause",
  resume: "Resume",
  shift: "Shift",
  regenerate: "Regenerate",
};

export function humanHint(hint: string | null | undefined): string | null {
  if (!hint) return null;
  const stripped = hint
    // a JSON object or array, with or without the parentheses that usually wrap it
    .replace(/\s*\(\s*[[{][^[\]{}]*[\]}]\s*\)/g, "")
    .replace(/\s*[[{][^[\]{}]*[\]}]/g, "");
  const out = stripped
    .split(/(?<=[.;])\s+/)
    .map((clause) => clause.replace(/\bPOST\s+\/plan\/(pause|resume|shift|regenerate)\b/gi, (_m, p: string) => CONTROL[p.toLowerCase()]!))
    // a clause still naming an endpoint, or still holding a payload, is dropped whole rather than
    // patched into half a sentence
    .filter((clause) => !/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//i.test(clause) && !/["{}[\]]/.test(clause))
    .join(" ")
    // what the removal leaves behind: doubled spaces, orphaned punctuation, "instead; that …"
    .replace(/\s+/g, " ")
    .replace(/\s+([;,.:])/g, "$1")
    .replace(/;\s*(?=[a-z])/g, " — ")
    .replace(/^[\s;,.:—-]+/, "")
    .replace(/[;,:]\s*$/, ".")
    .trim();
  if (!out || /["{}[\]]/.test(out)) return null;
  return out;
}

/** API messages start lowercase and often have no full stop; a toast reads better with both. */
export function sentence(text: string): string {
  const t = humanHint(text) ?? text;
  if (!t) return t;
  const capped = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

/**
 * Network and fetch errors read like internals ("Failed to fetch"). Say what actually happened.
 */
export function friendlyError(message: string | null): string | null {
  if (!message) return null;
  if (/failed to fetch|load failed|networkerror/i.test(message)) return "No response from the API — it looks stopped.";
  if (/aborted/i.test(message)) return "The request was cancelled before the API answered.";
  if (/^FORBIDDEN_ORIGIN/.test(message)) return "The API refused this page's origin. Start both from the repo root so their ports agree.";
  // No raw JSON in a toast, wherever the text came from.
  return /[{[]/.test(message) ? (humanHint(message) ?? message.replace(/\s*\(?\s*[[{][^[\]{}]*[\]}]\s*\)?/g, "").trim()) : message;
}

/** The SSE stream is down while the API still answers: changes made elsewhere may not show up. */
export function LiveBar({ onRetry }: { onRetry(): void }) {
  return (
    <div
      role="status"
      data-testid="live-bar"
      className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm"
    >
      <span className="flex items-center gap-2 font-medium text-warning">
        <WifiOff className="size-4 shrink-0" aria-hidden />
        Disconnected — retrying
      </span>
      <span className="text-muted-foreground">Live updates are paused. What you do here still saves.</span>
      <button
        type="button"
        onClick={onRetry}
        className="ml-auto h-10 rounded-md px-3 font-medium underline-offset-2 hover:underline sm:h-8"
      >
        Refresh now
      </button>
    </div>
  );
}

export function ApiDown({
  base,
  error,
  retryIn,
  onRetry,
}: {
  base: string;
  error: string | null;
  retryIn: number | null;
  onRetry(): void;
}) {
  const port = (() => {
    try {
      return new URL(base).port || "4317";
    } catch {
      return "4317";
    }
  })();
  const custom = port !== "4317";
  const prefix = custom ? `PLANNER_API_PORT=${port} ` : "";
  return (
    <section data-testid="state-down" className="rounded-xl border bg-surface p-5 sm:p-6" role="alert">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground" aria-hidden>
          <PlugZap className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">The planner API isn&apos;t running</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            This page reads and writes everything through the API at{" "}
            <span className="font-mono break-all text-foreground">{base}</span>, and it isn&apos;t answering.
          </p>
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-3 sm:pl-12">
        <div>
          <p className="mb-1.5 text-sm">Start everything (API, notifier and this UI) from the repo root:</p>
          <CopyCommand command={`${prefix}npm start`} />
        </div>
        <div>
          <p className="mb-1.5 text-sm text-muted-foreground">
            If this page is already running on its own, start just the API, and the notifier in a second terminal:
          </p>
          <div className="flex flex-col gap-1.5">
            <CopyCommand command={`${prefix}npm run api`} />
            <CopyCommand command={`${prefix}npm run daemon`} />
          </div>
          {custom && (
            <p className="mt-1.5 text-xs text-muted-foreground" data-testid="port-note">
              This page expects the API on port {port}, not the default 4317, so the commands carry{" "}
              <span className="font-mono">PLANNER_API_PORT</span>. In PowerShell, set it first:{" "}
              <span className="font-mono">$env:PLANNER_API_PORT={port}</span>.
            </p>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-10 items-center gap-1.5 rounded-md border bg-surface px-3 font-medium text-foreground transition-colors duration-150 hover:bg-muted sm:h-8"
          >
            <RotateCw className="size-3.5" aria-hidden />
            Retry now
          </button>
          <span className="tnum" aria-live="polite">
            {retryIn !== null ? `Retrying automatically in ${retryIn} s` : "Retrying…"}
          </span>
        </div>
        {error && <p className="mt-3 text-xs break-words text-muted-foreground">{friendlyError(error)}</p>}
      </div>
    </section>
  );
}
