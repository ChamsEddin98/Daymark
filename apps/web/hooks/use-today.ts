"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createApi, type ApiClient } from "@/lib/api";
import type { ItemStatus, PlanItem, TodayResponse, TrackInfo } from "@/lib/types";

export type Conn = "loading" | "ready" | "down";

export interface TodayState {
  api: ApiClient;
  data: TodayResponse | null;
  conn: Conn;
  /** Last network/API problem, for the "API down" state */
  error: string | null;
  /** Server-aligned clock, ticking once per second */
  now: number;
  overrides: ReadonlyMap<string, ItemStatus>;
  tracks: TrackInfo[] | null;
  /** Start of the first item on `data.upcoming.date` (from GET /plan), when known. */
  upcomingStart: string | null;
  setStatus(key: string, status: ItemStatus): Promise<void>;
  refetch(): Promise<TodayResponse | null>;
  retryIn: number | null;
  /** The SSE stream is open, so changes made elsewhere arrive on their own. */
  live: boolean;
}

const RETRY_MS = 5000;

const allItems = (t: TodayResponse | null): PlanItem[] => (t ? [...t.day.items, ...(t.day.checked ?? [])] : []);

export function useToday(apiBase: string, pinnedNow?: string): TodayState {
  const api = useMemo(() => createApi(apiBase, pinnedNow), [apiBase, pinnedNow]);
  const [data, setData] = useState<TodayResponse | null>(null);
  const [conn, setConn] = useState<Conn>("loading");
  const [error, setError] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Map<string, ItemStatus>>(() => new Map());
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(() => Date.now());
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [tracks, setTracks] = useState<TrackInfo[] | null>(null);
  const [upcomingStart, setUpcomingStart] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const inflight = useRef(new Map<string, number>()); // key -> request id
  const reqSeq = useRef(0);
  const fetchSeq = useRef(0);
  const dataRef = useRef<TodayResponse | null>(null);
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;

  const refetch = useCallback(async (): Promise<TodayResponse | null> => {
    const seq = ++fetchSeq.current;
    try {
      const t = await api.today();
      if (seq !== fetchSeq.current) return dataRef.current;
      dataRef.current = t;
      setOffset(Date.parse(t.now) - Date.now());
      setData(t);
      setConn("ready");
      setError(null);
      setRetryAt(null);
      // Drop optimistic overrides the server now agrees with (and that are not in flight).
      setOverrides((prev) => {
        if (!prev.size) return prev;
        const next = new Map(prev);
        const items = allItems(t);
        for (const [k, v] of prev) {
          const it = items.find((i) => i.key === k);
          if (!inflight.current.has(k) && (!it || it.status === v)) next.delete(k);
        }
        return next;
      });
      // Secondary reads: never block the timeline on them.
      api.tracks().then((r) => setTracks(r.tracks), () => {});
      if (t.upcoming) {
        api.plan(t.upcoming.date, 1).then(
          (r) => setUpcomingStart(r.days[0]?.items[0]?.start ?? null),
          () => setUpcomingStart(null),
        );
      } else setUpcomingStart(null);
      return t;
    } catch (e) {
      if (seq !== fetchSeq.current) return dataRef.current;
      const msg = e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
      setError(msg);
      setConn("down");
      setRetryAt(Date.now() + RETRY_MS);
      return null;
    }
  }, [api]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // retry loop while down
  useEffect(() => {
    if (conn !== "down") return;
    const id = setTimeout(() => void refetch(), RETRY_MS);
    return () => clearTimeout(id);
  }, [conn, refetch, retryAt]);

  // live updates
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource(api.eventsUrl());
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refetch(), 80);
    };
    // P8 pause/resume arrive as `plan` with `reason: "pause" | "resume"` (a pause moves nothing, so
    // it carries no dates). The bare `pause`/`resume` names are listened for too, in case the API
    // ever publishes them under their own event, so a frozen plan is never missed.
    for (const name of ["plan", "status", "sync", "pause", "resume"]) es.addEventListener(name, soon);
    let hadError = false;
    es.onerror = () => {
      hadError = true;
      // EventSource reconnects on its own; CLOSED means it gave up.
      setLive(false);
    };
    es.onopen = () => {
      setLive(true);
      if (hadError) soon();
      hadError = false;
    };
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [api, refetch]);

  // clock
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    const onVis = () => {
      if (document.visibilityState === "visible") {
        setTick(Date.now());
        void refetch();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refetch]);

  const setStatus = useCallback(
    async (key: string, status: ItemStatus) => {
      const previous =
        overridesRef.current.get(key) ?? allItems(dataRef.current).find((i) => i.key === key)?.status ?? "pending";
      const id = ++reqSeq.current;
      inflight.current.set(key, id);
      setOverrides((prev) => new Map(prev).set(key, status));
      try {
        await api.setStatus(key, status);
        if (inflight.current.get(key) === id) inflight.current.delete(key);
        void refetch();
      } catch (e) {
        if (inflight.current.get(key) === id) {
          inflight.current.delete(key);
          setOverrides((prev) => new Map(prev).set(key, previous));
        }
        throw e;
      }
    },
    [api, refetch],
  );

  return {
    api,
    data,
    conn,
    error,
    now: tick + offset,
    overrides,
    tracks,
    upcomingStart,
    setStatus,
    refetch,
    live,
    retryIn: retryAt ? Math.max(0, Math.ceil((retryAt - tick) / 1000)) : null,
  };
}
