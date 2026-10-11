"use client";

// Server state (docs/modules/podcast.md, docs/modules/contributors.md,
// docs/modules/imports.md). useServerValue holds one resource: it loads on
// key, refetches when `stale` changes, coalesces refetches (one queued at most,
// never aborting the run in flight), restores this pane visit's snapshot and
// throws defects in render. usePaneFreeServerValue is useServerValue for a read
// no pane visit owns (the shell above the panes, or a read that restores
// nothing). Lists live in useServerList.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  isApiError,
  isSameSystemApiDefect,
  type ApiError,
} from "@/lib/api/client";
import { requestWithRetry } from "@/lib/api/retryPolicy";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  usePaneVisitData,
  type PaneVisitDataKey,
} from "@/lib/workspace/paneReturnMemento";

export interface Visit<T> {
  readonly key: string;
  readonly data: T;
}
type Unready =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: ApiError };
export type ServerValue<T> = (
  | Unready
  | {
      readonly status: "ready";
      readonly data: T;
      readonly generation: number;
      readonly error: ApiError | null;
      /** A refetch is running over the shown data. */
      readonly refreshing: boolean;
    }
) & { readonly refetch: () => void };
type Load<D> = (signal: AbortSignal) => Promise<D>;
type Defect = { readonly error: unknown };
interface Held<D> {
  readonly key: string | null;
  readonly data: D | null;
  readonly generation: number;
  readonly error: ApiError | null;
  readonly running: boolean;
}

/** Rethrows an async defect during the next render, at the pane boundary. */
export function useThrowLater(): (defect: Defect) => void {
  const [defect, setDefect] = useState<Defect | null>(null);
  if (defect !== null) throw defect.error;
  return setDefect;
}

/** The modeled ApiError; null after an abort, a 401 or a defect. */
export function modeledApiError(
  error: unknown,
  fail: (defect: Defect) => void,
): ApiError | null {
  if (isAbortError(error) || handleUnauthenticatedApiError(error)) return null;
  if (isApiError(error) && !isSameSystemApiDefect(error)) return error;
  fail({ error });
  return null;
}

function arrive<D>(key: string | null, restored: Visit<D> | null): Held<D> {
  const data = restored?.key === key ? restored.data : null;
  return {
    key,
    data,
    generation: 0,
    error: null,
    running: key !== null,
  };
}

/**
 * This visit's snapshot until the first arrival at another key: a snapshot
 * serves the one arrival it was captured for (a null key waits).
 */
export function useVisitSnapshot<V extends { readonly key: string }>(
  visit: PaneVisitDataKey<V>,
  key: string | null,
  capture: () => V | null,
): V | null {
  const sample = usePaneVisitData(visit, capture);
  const kept = useRef({ sample, live: sample });
  if (kept.current.sample !== sample) kept.current = { sample, live: sample };
  if (key !== null && kept.current.live?.key !== key) kept.current.live = null;
  return kept.current.live;
}

function useServerState<D>(
  key: string | null,
  stale: string,
  restored: Visit<D> | null,
  load: Load<D>,
) {
  const fail = useThrowLater();
  const heldRef = useRef<Held<D> | null>(null);
  const [state, setState] = useState(() => arrive(key, restored));
  const held = state.key === key ? state : arrive(key, restored);
  heldRef.current = held;
  const loadRef = useRef(load);
  loadRef.current = load;
  const flight = useRef<{ controller: AbortController; queued: boolean }>(null);

  const run = useCallback(
    async () => {
      const controller = new AbortController();
      const current = { controller, queued: true };
      flight.current = current;
      // A retried first load shows progress again, not its last failure.
      setState((h) => ({
        ...h,
        running: true,
        error: h.data === null ? null : h.error,
      }));
      try {
        while (current.queued) {
          current.queued = false;
          try {
            const next = await requestWithRetry(
              (signal) => loadRef.current(signal),
              controller.signal,
            );
            if (controller.signal.aborted) return;
            setState((h) => ({
              ...h,
              data: next,
              error: null,
              generation: h.generation + 1,
            }));
          } catch (error) {
            if (controller.signal.aborted) return;
            const modeled = modeledApiError(error, fail);
            if (modeled === null) return;
            setState((h) => ({ ...h, error: modeled }));
          }
        }
      } finally {
        if (flight.current === current) {
          flight.current = null;
          setState((h) => ({ ...h, running: false }));
        }
      }
    },
    [fail],
  );

  useEffect(() => {
    setState((h) => (h.key === key ? h : arrive(key, restored)));
    if (key === null) return;
    void run();
    return () => {
      flight.current?.controller.abort();
      flight.current = null;
    };
  }, [key, restored, run]);

  const refetch = useCallback(() => {
    if (flight.current !== null) flight.current.queued = true;
    else if (heldRef.current?.key) void run();
  }, [run]);

  const staleRef = useRef({ key, stale });
  useEffect(() => {
    const previous = staleRef.current;
    staleRef.current = { key, stale };
    if (previous.key === key && previous.stale !== stale) refetch();
  }, [key, stale, refetch]);
  return { held, refetch };
}

/** useServerState that records its data as this pane visit's snapshot. */
function useVisitState<D>(
  key: string | null,
  stale: string,
  visit: PaneVisitDataKey<Visit<D>>,
  load: Load<D>,
) {
  const shown = useRef<Visit<D> | null>(null);
  const restored = useVisitSnapshot(
    visit,
    key,
    useCallback(() => shown.current, []),
  );
  const state = useServerState(key, stale, restored, load);
  const { held } = state;
  shown.current =
    held.key && held.data !== null ? { key: held.key, data: held.data } : null;
  return state;
}

function valueOf<T>(held: Held<T>, refetch: () => void): ServerValue<T> {
  if (held.data === null) {
    return held.error === null
      ? { status: "loading", refetch }
      : { status: "failed", error: held.error, refetch };
  }
  const { data, generation, error, running } = held;
  return {
    status: "ready",
    data,
    generation,
    error,
    refreshing: running,
    refetch,
  };
}

export function useServerValue<T>(input: {
  readonly key: string | null;
  readonly stale: string;
  readonly visit: PaneVisitDataKey<Visit<T>>;
  readonly load: (signal: AbortSignal) => Promise<T>;
}): ServerValue<T> {
  const { held, refetch } = useVisitState<T>(
    input.key,
    input.stale,
    input.visit,
    input.load,
  );
  return valueOf(held, refetch);
}

export function usePaneFreeServerValue<T>(input: {
  readonly key: string | null;
  readonly stale: string;
  readonly load: (signal: AbortSignal) => Promise<T>;
}): ServerValue<T> {
  const { held, refetch } = useServerState<T>(
    input.key,
    input.stale,
    null,
    input.load,
  );
  return valueOf(held, refetch);
}
