"use client";

// Server state (docs/modules/api-edge.md): the one owner of keyed async reads.
// useServerValue holds one resource: it loads on key, refetches when `stale`
// changes, coalesces refetches (one queued at most, never adopting the superseded
// run), restores this pane visit's snapshot, paints a server seed for its
// key without fetching, retries GETs and throws defects in render.
// usePaneFreeServerValue is the same read for code no pane visit owns (the
// shell above the panes, a dialog, a read that restores nothing). Lists live in
// useServerList.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LIVE_SOURCE, type CatalogRead, type ReadSource } from "@/lib/catalog/types";
import { remoteReady } from "@/lib/native/admission";
import { useRemoteGeneration } from "@/lib/native/admissionHooks";
import {
  ApiError,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import {
  handleUnauthenticatedApiError,
  useUnauthenticatedApiHandler,
} from "@/lib/auth/UnauthenticatedApiBoundary";
import { useOptionalAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { isAbortError } from "@/lib/errors";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import {
  usePaneVisitData,
  type PaneVisitDataKey,
} from "@/lib/workspace/paneReturnMemento";

export interface Visit<T> {
  readonly key: string;
  readonly data: T;
  readonly source: ReadSource;
}
type Unready =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: ApiError; readonly retrying: boolean };
export type ServerValue<T> = (
  | Unready
  | {
      readonly status: "ready";
      readonly data: T;
      readonly source: ReadSource;
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
  readonly source: ReadSource;
  readonly generation: number;
  readonly error: ApiError | null;
  readonly running: boolean;
}

// live reads share requests, not pane snapshots. the representation key and policy
// name the result; each caller retains its own cancellation and presentation.
interface SharedRequest {
  controller: AbortController;
  promise: Promise<unknown>;
  consumers: number;
  settled: boolean;
}
interface ReadOwner {
  readers: number;
  generation: number;
  stale: string;
  listeners: Set<() => void>;
  requests: Map<string, SharedRequest>;
  invalidate(stale?: string): void;
  read<T>(key: string, request: Load<T>, signal: AbortSignal): Promise<T>;
}
const liveReads = new Map<string, ReadOwner>();

function releaseReadOwner(identity: string, owner: ReadOwner): void {
  if (owner.readers === 0 && owner.listeners.size === 0 && owner.requests.size === 0 && liveReads.get(identity) === owner)
    liveReads.delete(identity);
}

function readOwner(identity: string, stale: string): ReadOwner {
  const existing = liveReads.get(identity);
  if (existing) return existing;
  const next: ReadOwner = {
    readers: 0, generation: 0, stale, listeners: new Set(), requests: new Map(),
    invalidate(token) {
      if (token !== undefined && token === next.stale) return;
      if (token !== undefined) next.stale = token;
      next.generation += 1;
      for (const request of next.requests.values()) request.controller.abort();
      next.requests.clear();
      for (const listener of next.listeners) listener();
    },
    read<T>(requestKey: string, request: Load<T>, signal: AbortSignal): Promise<T> {
      if (signal.aborted) return Promise.reject(signal.reason);
      let held = next.requests.get(requestKey);
      if (!held) {
        const controller = new AbortController();
        const current: SharedRequest = { controller, consumers: 0, settled: false,
          promise: Promise.resolve().then(() => request(controller.signal)) };
        held = current;
        next.requests.set(requestKey, current);
        const settled = () => {
          current.settled = true;
          if (next.requests.get(requestKey) === current) next.requests.delete(requestKey);
          releaseReadOwner(identity, next);
        };
        void current.promise.then(settled, settled);
      }
      const current = held;
      current.consumers += 1;
      return new Promise<T>((resolve, reject) => {
        let done = false;
        const finish = () => {
          if (done) return false;
          done = true;
          signal.removeEventListener("abort", abort);
          current.consumers -= 1;
          if (current.consumers === 0 && !current.settled) {
            current.controller.abort();
            if (next.requests.get(requestKey) === current) next.requests.delete(requestKey);
          }
          releaseReadOwner(identity, next);
          return true;
        };
        const abort = () => { if (finish()) reject(signal.reason); };
        signal.addEventListener("abort", abort, { once: true });
        current.promise.then(value => {
          // justify-type-assertion: identical account/representation/policy/request keys own one result type.
          if (finish()) resolve(value as T);
        }, error => { if (finish()) reject(error); });
      });
    },
  };
  if (typeof window !== "undefined") liveReads.set(identity, next);
  return next;
}

/** Join a live value read; receive invalidation supersedes its prior generation once. */
export async function readSharedValue<T>(input: {
  accountId: string;
  key: string;
  load: (signal: AbortSignal) => Promise<T>;
  signal: AbortSignal;
  readPolicy?: string;
  requestKey?: string;
  revalidate?: boolean;
}): Promise<T> {
  input.signal.throwIfAborted();
  const identity = JSON.stringify([input.accountId, input.key, input.readPolicy ?? "value:retry3"]);
  const owner = readOwner(identity, "");
  owner.readers += 1;
  try {
    if (input.revalidate) owner.invalidate();
    while (true) {
      input.signal.throwIfAborted();
      const generation = owner.generation;
      try {
        const value = await owner.read(input.requestKey ?? "value", signal => requestWithRetry(input.load, signal), input.signal);
        input.signal.throwIfAborted();
        if (generation === owner.generation) return value;
      } catch (error) {
        input.signal.throwIfAborted();
        if (generation === owner.generation) throw error;
      }
    }
  } finally {
    owner.readers -= 1;
    releaseReadOwner(identity, owner);
  }
}

export function useReadOwner(key: string | null, policy: string, stale: string, invalidate: () => void): ReadOwner {
  const account = useOptionalAuthenticatedAccount();
  const identity = JSON.stringify([account?.accountId ?? null, key, policy]);
  const owner = useMemo(() => readOwner(identity, stale),
    // stale is an invalidation token, not a different representation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identity]);
  const callback = useRef(invalidate);
  callback.current = invalidate;
  useEffect(() => {
    if (key === null) return;
    // strict-mode effect replay can reacquire the same live owner.
    liveReads.set(identity, owner);
    const changed = () => callback.current();
    owner.listeners.add(changed);
    return () => {
      owner.listeners.delete(changed);
      releaseReadOwner(identity, owner);
    };
  }, [identity, key, owner]);
  useEffect(() => { if (key !== null) owner.invalidate(stale); }, [key, stale, owner]);
  return owner;
}

/**
 * The GET retry policy: three attempts with cancellable jittered backoff
 * (250 ms doubling, at most 2 s). Only transport failures and non-defect 5xx
 * retry; a 401 and same-system defects never do.
 */
export async function requestWithRetry<T>(
  request: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      return await request(signal);
    } catch (error) {
      const retryable =
        !signal.aborted && remoteReady() &&
        isApiError(error) &&
        (error.code === "E_NETWORK" ||
          (!isSameSystemApiDefect(error) && error.status >= 500));
      if (!retryable || attempt === 3) throw error;
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
  if (isAbortError(error)) return null;
  signIn(error);
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
      ? { key, data: pane[key] as T, source: LIVE_SOURCE }
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
    source: shown?.source ?? LIVE_SOURCE,
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
  readPolicy: string,
  catalog?: CatalogRead<D>,
) {
  const admissionGeneration = useRemoteGeneration();
  const account = useOptionalAuthenticatedAccount();
  const accountId = account?.accountId ?? null;
  const [firstAccount] = useState(accountId);
  const stateKey = key === null ? null : JSON.stringify([accountId, key]);
  const restoredHere = useMemo(() =>
    stateKey !== null && restored !== null && restored.key === key && accountId === firstAccount &&
      (restored.source.kind === "live" || restored.source.snapshot_id === catalog?.snapshot_id)
      ? { key: stateKey, data: restored.data, source: restored.source } : null,
  [stateKey, restored, key, accountId, firstAccount, catalog?.snapshot_id]);
  const fail = useThrowLater();
  const signIn = useUnauthenticatedApiHandler();
  const seed = useServerSeed<D>(key);
  // A seed paints its key's first arrival, which then skips its fetch.
  const seedHere = stateKey !== null && seed !== null && seed.key === key && accountId === firstAccount
    ? { key: stateKey, data: seed.data, source: LIVE_SOURCE } : null;
  const seeded = useRef(seedHere !== null && restoredHere === null ? key : null);
  const heldRef = useRef<Held<D> | null>(null);
  const [state, setState] = useState(() =>
    seeded.current === null
      ? arrive(stateKey, restoredHere)
      : { ...arrive(stateKey, seedHere), running: false },
  );
  const held = state.key === stateKey ? state : arrive(stateKey, restoredHere);
  heldRef.current = held;
  const loadRef = useRef(load);
  loadRef.current = load;
  const latest = useRef({ key, stale, accountId, catalog });
  latest.current = { key, stale, accountId, catalog };
  const flight = useRef<{ controller: AbortController; queued: boolean }>(null);

  const queueRead = () => {
    if (flight.current !== null) flight.current.queued = true;
    else if (typeof heldRef.current?.key === "string") void run();
  };
  const owner = useReadOwner(key, readPolicy, stale, queueRead);
  const run = useCallback(
    async () => {
      if (flight.current !== null) { flight.current.queued = true; return; }
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
          if (latest.current.accountId !== accountId) return;
          current.queued = false;
          const reading = latest.current;
          const generation = owner.generation;
          try {
            let localError: ApiError | null = null;
            const held = heldRef.current;
            if (reading.catalog && (held?.key !== stateKey || held.data === null || held.source.kind === "catalog")) {
              try {
                const saved = await reading.catalog.load(controller.signal);
                if (controller.signal.aborted) return;
                if (current.queued || generation !== owner.generation || reading.key !== latest.current.key || reading.accountId !== latest.current.accountId) continue;
                if (saved !== null) {
                  const next: Held<D> = { key: stateKey, data: saved.data, source: saved.source, error: null, running: remoteReady(), generation: (heldRef.current?.generation ?? 0) + 1 };
                  heldRef.current = next;
                  setState(next);
                } else localError = new ApiError(0, "E_CATALOG_UNAVAILABLE", "catalog not ready on this device");
              } catch (error) {
                if (controller.signal.aborted) return;
                if (!isApiError(error)) throw error;
                localError = error;
              }
            }
            if (localError?.code === "E_CATALOG_COVERAGE" && heldRef.current?.source.kind === "catalog") {
              const next: Held<D> = { ...heldRef.current, data: null, source: LIVE_SOURCE, error: remoteReady() ? null : localError };
              heldRef.current = next;
              setState(next);
            }
            if (!remoteReady()) {
              setState(h => ({ ...h, error: h.data === null ? localError ?? new ApiError(0, "E_NETWORK", "this view needs a connection") : null }));
              continue;
            }
            const load = loadRef.current;
            const next = await owner.read("value", signal => requestWithRetry(load, signal), controller.signal);
            if (controller.signal.aborted) return;
            if (current.queued || generation !== owner.generation || reading.accountId !== latest.current.accountId || reading.key !== latest.current.key || reading.stale !== latest.current.stale) continue;
            setState((h) => ({
              ...h,
              data: next,
              source: LIVE_SOURCE,
              error: null,
              generation: h.generation + 1,
            }));
          } catch (error) {
            if (controller.signal.aborted) return;
            if (current.queued || generation !== owner.generation || reading.accountId !== latest.current.accountId || reading.key !== latest.current.key || reading.stale !== latest.current.stale) continue;
            const modeled = modeledApiError(error, fail, signIn);
            if (modeled === null) return;
            if (modeled.code === "E_NETWORK" && !remoteReady() && heldRef.current?.source.kind === "catalog" && heldRef.current.data !== null) {
              setState(h => ({ ...h, error: null }));
              continue;
            }
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
    [fail, signIn, owner, accountId, stateKey],
  );

  useEffect(() => {
    setState((h) => (h.key === stateKey ? h : arrive(stateKey, restoredHere)));
    if (key === null) return;
    if (seeded.current === key) seeded.current = null;
    else void run();
    // A seeded arrival keeps the cleanup too: a later refetch dies with its key.
    return () => {
      flight.current?.controller.abort();
      flight.current = null;
    };
  }, [key, stateKey, restoredHere, run]);

  const catalogSnapshot = catalog?.snapshot_id ?? null;
  const observedCatalog = useRef(catalogSnapshot);
  useEffect(() => {
    if (observedCatalog.current === catalogSnapshot) return;
    observedCatalog.current = catalogSnapshot;
    const held = heldRef.current;
    if (held?.data !== null && held?.source.kind === "live") return;
    owner.invalidate();
  }, [catalogSnapshot, owner]);
  const refetch = useCallback(() => owner.invalidate(), [owner]);
  const admittedGeneration = useRef(admissionGeneration);
  useEffect(() => {
    if (admissionGeneration === admittedGeneration.current) return;
    admittedGeneration.current = admissionGeneration;
    refetch();
  }, [admissionGeneration, refetch]);

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
    source: held.source,
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
  readonly load: Load<T>;
  readonly readPolicy?: string;
  readonly catalog?: CatalogRead<T>;
}): ServerValue<T> {
  const shown = useRef<Visit<T> | null>(null);
  const restored = useVisitSnapshot(
    input.visit,
    input.key,
    useCallback(() => shown.current, []),
  );
  const value = useServerState(input.key, input.stale, restored, input.load, input.readPolicy ?? "value:retry3", input.catalog);
  shown.current =
    input.key !== null && value.status === "ready"
      ? { key: input.key, data: value.data, source: value.source }
      : null;
  return value;
}

export function usePaneFreeServerValue<T>(input: {
  readonly key: string | null;
  readonly stale: string;
  readonly load: Load<T>;
  readonly readPolicy?: string;
  readonly catalog?: CatalogRead<T>;
}): ServerValue<T> {
  return useServerState(input.key, input.stale, null, input.load, input.readPolicy ?? "value:retry3", input.catalog);
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
