import type {
  ActiveHours,
  ApiErrorBody,
  ItemStatus,
  PauseResult,
  PlanDay,
  ResumeResult,
  SettingsResponse,
  SettingsResult,
  ShiftBody,
  ShiftResult,
  TodayResponse,
  TrackInfo,
} from "./types";

export const DEFAULT_API = "http://127.0.0.1:4317";

/** Thrown for HTTP errors (the API answered) as opposed to network errors (it did not). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}

export interface ApiClient {
  base: string;
  today(signal?: AbortSignal): Promise<TodayResponse>;
  setStatus(key: string, status: ItemStatus): Promise<unknown>;
  shift(body: ShiftBody): Promise<ShiftResult>;
  previewShift(body: ShiftBody, signal?: AbortSignal): Promise<ShiftResult>;
  pause(): Promise<PauseResult>;
  resume(): Promise<ResumeResult>;
  tracks(signal?: AbortSignal): Promise<{ tracks: TrackInfo[] }>;
  settings(signal?: AbortSignal): Promise<SettingsResponse>;
  /** `dryRun` validates and re-plans nothing, so a form can check a window before committing. */
  saveSettings(patch: Partial<ActiveHours>, opts?: { dryRun?: boolean }): Promise<SettingsResult>;
  plan(from: string, days: number, signal?: AbortSignal): Promise<{ days: PlanDay[] }>;
  eventsUrl(): string;
}

/**
 * `pinnedNow` forwards a `?now=` override to the API. Only the fixture API honours it; it exists so
 * a page URL like `/?now=2026-09-28T07:30:00%2B01:00` can render any moment of the day.
 */
export function createApi(base: string, pinnedNow?: string): ApiClient {
  const url = (path: string) => {
    const u = new URL(path, base);
    if (pinnedNow) u.searchParams.set("now", pinnedNow);
    return u.toString();
  };
  async function req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url(path), {
      ...init,
      cache: "no-store",
      headers: init?.body ? { "content-type": "application/json" } : undefined,
    });
    if (!res.ok) {
      let body: ApiErrorBody | undefined;
      try {
        body = (await res.json()) as ApiErrorBody;
      } catch {
        /* not JSON */
      }
      throw new ApiError(
        res.status,
        body?.error?.code ?? "HTTP_" + res.status,
        body?.error?.message ?? res.statusText,
        body?.error?.hint,
      );
    }
    return (await res.json()) as T;
  }
  return {
    base,
    today: (signal) => req<TodayResponse>("/today", { signal }),
    setStatus: (key, status) =>
      req(`/items/${encodeURIComponent(key)}/status`, { method: "POST", body: JSON.stringify({ status }) }),
    shift: (body) => req<ShiftResult>("/plan/shift", { method: "POST", body: JSON.stringify(body) }),
    previewShift: (body, signal) =>
      req<ShiftResult>("/plan/shift/preview", { method: "POST", body: JSON.stringify(body), signal }),
    pause: () => req<PauseResult>("/plan/pause", { method: "POST", body: "{}" }),
    resume: () => req<ResumeResult>("/plan/resume", { method: "POST", body: "{}" }),
    tracks: (signal) => req<{ tracks: TrackInfo[] }>("/tracks", { signal }),
    settings: (signal) => req<SettingsResponse>("/settings", { signal }),
    saveSettings: (patch, opts) =>
      req<SettingsResult>(`/settings${opts?.dryRun ? "?dryRun=true" : ""}`, { method: "PATCH", body: JSON.stringify(patch) }),
    plan: (from, days, signal) => req<{ days: PlanDay[] }>(`/plan?from=${from}&days=${days}`, { signal }),
    eventsUrl: () => url("/events"),
  };
}
