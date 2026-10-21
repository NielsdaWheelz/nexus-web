"use client";

// Server state (docs/modules/api-edge.md): the one owner of keyed async reads.
// useServerValue holds one resource: it loads on key, refetches when `stale`
// changes, coalesces refetches (one queued at most, never adopting the superseded
// run), restores this pane visit's snapshot, paints a server seed for its
// key without fetching, retries GETs unless manual and throws defects in render.
// One optional deadline bounds the entire read, including retries and decoding.
// usePaneFreeServerValue is the same read for code no pane visit owns (the
// shell above the panes, a dialog, a read that restores nothing). Lists live in
// useServerList.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isApiError,
  requestWithDeadline,
  isSameSystemApiDefect,
  type ApiError,
} from "@/lib/api/client";
import {
  handleUnauthenticatedApiError,
  useUnauthenticatedApiHandler,
} from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
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
  | { readonly status: "failed"; readonly error: ApiError; readonly retrying: boolean };
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

export interface ReadPolicy {
  readonly retry?: "manual";
  readonly timeoutMs?: number;
}

/**
 * The GET retry policy: three attempts with cancellable jittered backoff
 * (250 ms doubling, at most 2 s). Only transport failures and non-defect 5xx
 * retry; a 401 and same-system defects never do.
 */
export async function requestWithRetry<T>(
  request: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  policy: ReadPolicy = {},
): Promise<T> {
  const read = async (signal: AbortSignal): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await request(signal);
      } catch (error) {
        const retryable =
          !signal.aborted &&
          isApiError(error) &&
          (error.code === "E_NETWORK" ||
            (!isSameSystemApiDefect(error) && error.status >= 500));
        if (policy.retry === "manual" || !retryable || attempt === 3) throw error;
        const delay = Math.min(250 * 2 ** (attempt - 1), 2000);
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, delay * (0.75 + Math.random() * 0.5));
          signal.addEventListener("abort", abort, { once: true });
        });
      }
    }
  };
  return policy.timeoutMs === undefined ? read(signal) : requestWithDeadline({ request: read, signal, timeoutMs: policy.timeoutMs });
}

/** Rethrows an async defect during the next render, at the pane boundary. */
export function useThrowLater(): (defect: Defect) => void {
  const [defect, setDefect] = useState<Defect | null>(null);
  if (defect !== null) throw defect.error;
  return setDefect;
}

/**
 * The modeled ApiError; null after an abort, a handled 401 or a defect. Reads
 * pass the shell's `signIn`, a no-op outside it (share capture models its 401).
 */
export function modeledApiError(
  error: unknown,
  fail: (defect: Defect) => void,
  signIn: (error: unknown) => boolean = handleUnauthenticatedApiError,
): ApiError | null {
  if (isAbortError(error) || signIn(error)) return null;
  if (isApiError(error) && !isSameSystemApiDefect(error)) return error;
  fail({ error });
  return null;
}

// The bootstrap's first-paint reads per pane id, under the key of the hook that
// reads them. A hook in the pane body's first commit takes its key's seed; that
// commit spends the pane's seeds (ServerSeedsSpent), so every later mount
// reads. Not a cache.
const Seeds = createContext<Map<string, Record<string, unknown>> | null>(null);

export function ServerSeedsProvider(props: {
  readonly seeds: Record<string, Record<string, unknown>>;
  readonly children: ReactNode;
}) {
  const [seeds] = useState(() => new Map(Object.entries(props.seeds)));
  return <Seeds.Provider value={seeds}>{props.children}</Seeds.Provider>;
}

/** Rendered beside a pane body, in its Suspense: spends the pane's seeds. */
export function ServerSeedsSpent() {
  const seeds = useContext(Seeds);
  const paneId = usePaneRuntime()?.paneId;
  useEffect(() => {
    if (paneId !== undefined) seeds?.delete(paneId);
  }, [seeds, paneId]);
  return null;
}

/** The pane's server seed for this mount's first key, while the pane has one. */
export function useServerSeed<T>(key: string | null): Visit<T> | null {
  const seeds = useContext(Seeds);
  const paneId = usePaneRuntime()?.paneId;
  const pane = paneId === undefined ? undefined : seeds?.get(paneId);
  const [seed] = useState(() =>
    key !== null && pane !== undefined && Object.hasOwn(pane, key)
      ? { key, data: pane[key] as T }
      : null,
  );
  return seed;
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

function arrive<D>(key: string | null, shown: Visit<D> | null): Held<D> {
  const data = shown?.key === key ? shown.data : null;
  return {
    key,
    data,
    generation: 0,
    error: null,
    running: key !== null,
  };
}

function useServerState<D>(
  key: string | null,
  stale: string,
  restored: Visit<D> | null,
  load: Load<D>,
  policy: ReadPolicy,
) {
  const fail = useThrowLater();
  const signIn = useUnauthenticatedApiHandler();
  const seed = useServerSeed<D>(key);
  // A seed paints its key's first arrival, which then skips its fetch.
  const seeded = useRef(seed !== null && restored === null ? key : null);
  const heldRef = useRef<Held<D> | null>(null);
  const [state, setState] = useState(() =>
    seeded.current === null
      ? arrive(key, restored)
      : { ...arrive(key, seed), running: false },
  );
  const held = state.key === key ? state : arrive(key, restored);
  heldRef.current = held;
  const loadRef = useRef(load);
  loadRef.current = load;
  const latest = useRef({ key, stale, policy });
  latest.current = { key, stale, policy };
  const flight = useRef<{ controller: AbortController; queued: boolean }>(null);

  const run = useCallback(
    async () => {
      const controller = new AbortController();
      const current = { controller, queued: true };
      flight.current = current;
      // Keep the last failure and its focused action until a retry succeeds.
      setState((h) => ({
        ...h,
        running: true,
      }));
      try {
        while (current.queued) {
          current.queued = false;
          const reading = latest.current;
          try {
            const next = await requestWithRetry(
              (signal) => loadRef.current(signal),
              controller.signal,
              reading.policy,
            );
            if (controller.signal.aborted) return;
            if (current.queued || reading.key !== latest.current.key || reading.stale !== latest.current.stale) continue;
            setState((h) => ({
              ...h,
              data: next,
              error: null,
              generation: h.generation + 1,
            }));
          } catch (error) {
            if (controller.signal.aborted) return;
            if (current.queued || reading.key !== latest.current.key || reading.stale !== latest.current.stale) continue;
            const modeled = modeledApiError(error, fail, signIn);
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
    [fail, signIn],
  );

  useEffect(() => {
    setState((h) => (h.key === key ? h : arrive(key, restored)));
    if (key === null) return;
    if (seeded.current === key) seeded.current = null;
    else void run();
    // A seeded arrival keeps the cleanup too: a later refetch dies with its key.
    return () => {
      flight.current?.controller.abort();
      flight.current = null;
    };
  }, [key, restored, run]);

  const refetch = useCallback(() => {
    if (flight.current !== null) flight.current.queued = true;
    else if (typeof heldRef.current?.key === "string") void run();
  }, [run]);

  const staleRef = useRef({ key, stale });
  useEffect(() => {
    const previous = staleRef.current;
    staleRef.current = { key, stale };
    if (previous.key === key && previous.stale !== stale) refetch();
  }, [key, stale, refetch]);
  return valueOf(held, refetch);
}

function valueOf<T>(held: Held<T>, refetch: () => void): ServerValue<T> {
  if (held.data === null) {
    return held.error === null
      ? { status: "loading", refetch }
      : { status: "failed", error: held.error, retrying: held.running, refetch };
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

export function useServerValue<T>(input: ReadPolicy & {
  readonly key: string | null;
  readonly stale: string;
  readonly visit: PaneVisitDataKey<Visit<T>>;
  readonly load: Load<T>;
}): ServerValue<T> {
  const shown = useRef<Visit<T> | null>(null);
  const restored = useVisitSnapshot(
    input.visit,
    input.key,
    useCallback(() => shown.current, []),
  );
  const value = useServerState(input.key, input.stale, restored, input.load, input);
  shown.current =
    input.key !== null && value.status === "ready"
      ? { key: input.key, data: value.data }
      : null;
  return value;
}

export function usePaneFreeServerValue<T>(input: ReadPolicy & {
  readonly key: string | null;
  readonly stale: string;
  readonly load: Load<T>;
}): ServerValue<T> {
  return useServerState(input.key, input.stale, null, input.load, input);
}

/** `value` once it has held still for `ms`: a typed query before its read. */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(settled, value)) return;
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, settled, ms]);
  return settled;
}
