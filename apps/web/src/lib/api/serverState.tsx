"use client";

// Server state (docs/modules/api-edge.md): the one owner of keyed async reads.
// useServerValue holds one resource. Tokens supersede strict reads; observations
// queue once without discarding useful results. Visits retain accepted tokens.
// Strict refetch is awaitable and rejects on failure/retirement; ignored event
// promises are observed here because failure already renders. Arrival records
// transfer one prepared read to the first committed reader, never a cache.
// usePaneFreeServerValue is the same read for code no pane visit owns (the
// shell above the panes, a dialog, a read that restores nothing). Lists live in
// useServerList.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LIVE_SOURCE, type CatalogRead, type ReadSource } from "@/lib/catalog/types";
import { remoteReady, remoteAttemptAllowed } from "@/lib/native/admission";
import { useRemoteGeneration } from "@/lib/native/admissionHooks";
import {
  ApiError,
  isApiError,
  isSameSystemApiDefect,
  requestWithDeadline,
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
  readonly acceptedStale: string | null;
}
export interface ReadPolicy {
  readonly retry?: "manual";
  readonly timeoutMs?: number;
}
export interface ReadDescriptor<T> extends ReadPolicy {
  readonly key: string | null;
  readonly stale: string;
  readonly load: Load<T>;
  readonly readPolicy?: string;
}

function policyIdentity(input: ReadPolicy & { readonly readPolicy?: string }): string {
  return JSON.stringify([input.readPolicy ?? "value:retry3", input.retry ?? null, input.timeoutMs ?? null]);
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
      readonly acceptedStale: string | null;
      readonly fresh: boolean;
      readonly generation: number;
      readonly error: ApiError | null;
      /** A refetch is running over the shown data. */
      readonly refreshing: boolean;
    }
) & { readonly refetch: () => Promise<void>; readonly revalidate: () => void };
type Load<D> = (signal: AbortSignal) => Promise<D>;
type Defect = { readonly error: unknown };
interface Held<D> {
  readonly key: string | null;
  readonly data: D | null;
  readonly source: ReadSource;
  readonly acceptedStale: string | null;
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
interface ReadHandle {
  readonly generation: number;
  invalidate(stale?: string): void;
  read<T>(key: string, request: Load<T>, signal: AbortSignal): Promise<T>;
}
interface ReadOwner extends ReadHandle {
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
  return next;
}

/** Join a live value read; receive invalidation supersedes its prior generation once. */
export async function readSharedValue<T>(input: ReadPolicy & {
  accountId: string;
  key: string;
  load: (signal: AbortSignal) => Promise<T>;
  signal: AbortSignal;
  readPolicy?: string;
  invalidate?: boolean;
}): Promise<T> {
  input.signal.throwIfAborted();
  const identity = JSON.stringify([input.accountId, input.key, policyIdentity(input)]);
  const owner = readOwner(identity, "");
  liveReads.set(identity, owner);
  owner.readers += 1;
  try {
    if (input.invalidate) owner.invalidate();
    while (true) {
      input.signal.throwIfAborted();
      const generation = owner.generation;
      try {
        const value = await owner.read("value", signal => requestWithRetry(input.load, signal, input), input.signal);
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

export function useReadOwner(key: string | null, policy: string, stale: string, invalidate: () => void): ReadHandle {
  const account = useOptionalAuthenticatedAccount();
  const identity = JSON.stringify([account?.accountId ?? null, key, policy]);
  // Render allocates only this binding. Abandoned renders own no global entry;
  // independently rendered subscribers acquire the canonical owner at commit.
  const binding = useMemo<{ identity: string; current: ReadOwner | null }>(() => ({ identity, current: null }), [identity]);
  const handle = useMemo<ReadHandle>(() => ({
    get generation() { return binding.current?.generation ?? liveReads.get(identity)?.generation ?? 0; },
    invalidate(token) { binding.current?.invalidate(token); },
    read(requestKey, request, signal) {
      return binding.current?.read(requestKey, request, signal)
        ?? Promise.reject(new DOMException("read owner retired", "AbortError"));
    },
  }), [binding, identity]);
  const callback = useRef(invalidate);
  callback.current = invalidate;
  useEffect(() => {
    if (key === null) return;
    const owner = readOwner(identity, stale);
    liveReads.set(identity, owner);
    binding.current = owner;
    const changed = () => callback.current();
    owner.listeners.add(changed);
    return () => {
      binding.current = null;
      owner.listeners.delete(changed);
      releaseReadOwner(identity, owner);
    };
  // stale is an invalidation token, not an acquisition identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, key, binding]);
  useEffect(() => { if (key !== null) handle.invalidate(stale); }, [key, stale, handle]);
  return handle;
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
  const run = async (ownedSignal: AbortSignal): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      ownedSignal.throwIfAborted();
      try {
        return await request(ownedSignal);
      } catch (error) {
        const retryable =
          !ownedSignal.aborted && remoteReady() && policy.retry !== "manual" &&
          isApiError(error) &&
          (error.code === "E_NETWORK" ||
            (!isSameSystemApiDefect(error) && error.status >= 500));
        if (!retryable || attempt === 3) throw error;
        const delay = Math.min(250 * 2 ** (attempt - 1), 2000);
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(ownedSignal.reason);
          };
          const timer = setTimeout(() => {
            ownedSignal.removeEventListener("abort", abort);
            resolve();
          }, delay * (0.75 + Math.random() * 0.5));
          ownedSignal.addEventListener("abort", abort, { once: true });
        });
      }
    }
  };
  return policy.timeoutMs === undefined ? run(signal)
    : requestWithDeadline({ request: run, signal, timeoutMs: policy.timeoutMs });
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

// A bounded, one-use handoff from bootstrap/accepted entry to its mounted reader.
// Claims retain a record across strict effect replay; unused work dies at body
// commit or destination retirement. It never owns completed browsing snapshots.
export type ArrivalOutcome<T> =
  | { readonly status: "pending" }
  | { readonly status: "success"; readonly data: T }
  | { readonly status: "failure"; readonly error: unknown };
export interface ArrivalClaim<T> {
  readonly promise: Promise<T>;
  readonly release: () => void;
}
interface ArrivalRecord {
  scope: ArrivalScope;
  readonly descriptor: ReadDescriptor<unknown>;
  readonly owner: ReadOwner;
  readonly generation: number;
  readonly controller: AbortController;
  readonly releaseOwner: () => void;
  retired: boolean;
  readonly promise: Promise<unknown>;
  outcome: ArrivalOutcome<unknown>;
  claims: number;
  claimed: boolean;
}
interface SeedOwner {
  readonly bootstrap: Map<string, Record<string, unknown>>;
  readonly arrivals: Map<string, Map<string, ArrivalRecord>>;
}
const Seeds = createContext<SeedOwner | null>(null);
interface ArrivalScope {
  readonly id: string;
  readonly paneId: string;
  readonly accountId: string | null;
  readonly reads: readonly ReadDescriptor<unknown>[];
  spent: boolean;
  active: boolean;
}
const ArrivalContext = createContext<ArrivalScope | null>(null);

function arrivalKey(descriptor: ReadDescriptor<unknown>): string {
  return JSON.stringify([descriptor.key, policyIdentity(descriptor)]);
}

function retireArrival(record: ArrivalRecord): void {
  if (record.retired) return;
  record.retired = true;
  record.releaseOwner();
  record.controller.abort(new DOMException("arrival retired", "AbortError"));
}

function ensureArrival(seeds: SeedOwner, scope: ArrivalScope, descriptor: ReadDescriptor<unknown>): ArrivalRecord | null {
  if (descriptor.key === null) return null;
  let records = seeds.arrivals.get(scope.id);
  if (!records) { records = new Map(); seeds.arrivals.set(scope.id, records); }
  const key = arrivalKey(descriptor);
  const existing = records.get(key);
  if (existing && existing.descriptor.stale === descriptor.stale && existing.generation === existing.owner.generation && !existing.controller.signal.aborted) { existing.scope = scope; return existing; }
  if (existing) retireArrival(existing);
  const identity = JSON.stringify([scope.accountId, descriptor.key, policyIdentity(descriptor)]);
  const owner = readOwner(identity, descriptor.stale);
  liveReads.set(identity, owner);
  owner.readers += 1;
  owner.invalidate(descriptor.stale);
  const controller = new AbortController();
  const bootstrap = seeds.bootstrap.get(scope.paneId);
  const seeded = bootstrap !== undefined && Object.hasOwn(bootstrap, descriptor.key);
  const seededData = seeded ? bootstrap[descriptor.key] : null;
  if (seeded) delete bootstrap[descriptor.key];
  const record: ArrivalRecord = {
    scope, descriptor, owner, generation: owner.generation, controller, retired: false,
    releaseOwner: () => { owner.readers -= 1; releaseReadOwner(identity, owner); },
    claims: 0, claimed: false,
    outcome: seeded ? { status: "success", data: seededData } : { status: "pending" },
    promise: seeded ? Promise.resolve(seededData)
      : remoteReady() ? owner.read("value", signal => requestWithRetry(descriptor.load, signal, descriptor), controller.signal)
        : Promise.reject(new ApiError(0, "E_NETWORK", "this view needs a connection")),
  };
  records.set(key, record);
  // Both outcomes are held. A failed arrival is not a seed miss or a retry.
  void record.promise.then(data => { record.outcome = { status: "success", data }; }, error => { record.outcome = { status: "failure", error }; });
  return record;
}

export function ServerSeedsProvider(props: {
  readonly seeds: Record<string, Record<string, unknown>>;
  readonly children: ReactNode;
}) {
  const [seeds] = useState<SeedOwner>(() => ({ bootstrap: new Map(Object.entries(props.seeds)), arrivals: new Map() }));
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Defer so strict replay may reclaim the same records.
      queueMicrotask(() => {
        if (mounted.current) return;
        for (const records of seeds.arrivals.values()) for (const record of records.values())
          if (record.claims === 0) retireArrival(record);
      });
    };
  }, [seeds]);
  return <Seeds.Provider value={seeds}>{props.children}</Seeds.Provider>;
}

/** Outside the lazy body: entry alone starts only the declared GETs. */
export function PaneEntryReads(props: { readonly reads: readonly ReadDescriptor<unknown>[]; readonly children: ReactNode }) {
  const seeds = useContext(Seeds);
  const runtime = usePaneRuntime();
  const account = useOptionalAuthenticatedAccount();
  if (runtime === null) throw new Error("arrival requires a pane runtime");
  const id = JSON.stringify([account?.accountId ?? null, runtime.paneId, runtime.visitId, runtime.routeId, runtime.pathname]);
  const scope = useMemo<ArrivalScope>(() => ({ id, paneId: runtime.paneId, accountId: account?.accountId ?? null, reads: props.reads, spent: false, active: false }), [id, runtime.paneId, account?.accountId, props.reads]);
  const first = useRef(scope);
  useLayoutEffect(() => {
    if (seeds === null) return;
    const entering = first.current;
    entering.active = true;
    if (!entering.spent) for (const descriptor of first.current.reads) ensureArrival(seeds, first.current, descriptor);
    return () => {
      const retired = entering;
      retired.active = false;
      queueMicrotask(() => {
        if (retired.active) return;
        const records = seeds.arrivals.get(retired.id);
        if (!records) return;
        for (const [key, record] of records) if (record.scope === retired && record.claims === 0) { retireArrival(record); records.delete(key); }
        if (records.size === 0) seeds.arrivals.delete(retired.id);
      });
    };
  }, [seeds]);
  return <ArrivalContext.Provider value={first.current}>{props.children}</ArrivalContext.Provider>;
}

/** Render peeks; only the first read effect claims and transfers ownership. */
export function useServerArrival<T>(descriptor: ReadDescriptor<T> | null): { readonly peek: ArrivalOutcome<T> | null; readonly claim: () => ArrivalClaim<T> | null } {
  const seeds = useContext(Seeds);
  const scope = useContext(ArrivalContext);
  const claimed = useRef<ArrivalRecord | null>(null);
  const localClaims = useRef(0);
  const initialKey = useRef(descriptor?.key ?? null);
  const leftEntry = useRef(false);
  if (descriptor?.key !== initialKey.current) leftEntry.current = true;
  const offered = !leftEntry.current && descriptor !== null && scope?.reads.some(read => read.key === descriptor.key && read.stale === descriptor.stale && policyIdentity(read) === policyIdentity(descriptor)) === true;
  const lookup = () => {
    if (!seeds || !scope || !descriptor || !offered) return null;
    const record = claimed.current ?? seeds.arrivals.get(scope.id)?.get(arrivalKey(descriptor)) ?? null;
    return record !== null && record.descriptor.key === descriptor.key && policyIdentity(record.descriptor) === policyIdentity(descriptor) && record.descriptor.stale === descriptor.stale && record.generation === record.owner.generation && !record.controller.signal.aborted ? record : null;
  };
  const candidate = () => claimed.current ?? (seeds && scope && descriptor ? seeds.arrivals.get(scope.id)?.get(arrivalKey(descriptor)) ?? null : null);
  const record = lookup();
  const bootstrap = seeds && scope ? seeds.bootstrap.get(scope.paneId) : undefined;
  const bootstrapPeek = offered && !scope?.spent && candidate() === null && descriptor?.key != null && bootstrap !== undefined && Object.hasOwn(bootstrap, descriptor.key)
    ? { status: "success" as const, data: bootstrap[descriptor.key] } : null;
  // justify-type-assertion: an account/representation/policy key owns exactly one result type.
  const peek = (record?.outcome ?? bootstrapPeek) as ArrivalOutcome<T> | null;
  const claim = () => {
    if (!seeds || !scope || !descriptor || !offered || scope.spent && claimed.current === null) return null;
    const available = lookup();
    if (available === null && candidate() !== null) return null;
    const record = available ?? ensureArrival(seeds, scope, descriptor);
    if (record === null) return null;
    claimed.current = record;
    record.claimed = true;
    record.claims += 1;
    localClaims.current += 1;
    let released = false;
    return {
      // justify-type-assertion: same representation/policy check as the render peek.
      promise: record.promise as Promise<T>,
      release() {
        if (released) return;
        released = true;
        record.claims -= 1;
        localClaims.current -= 1;
        queueMicrotask(() => {
          if (localClaims.current === 0 && claimed.current === record) claimed.current = null;
          if (record.claims === 0) retireArrival(record);
        });
      },
    };
  };
  return { peek, claim };
}

/** Body effects claim first; unused preparation is then retired. */
export function ServerSeedsSpent() {
  const seeds = useContext(Seeds);
  const scope = useContext(ArrivalContext);
  const paneId = usePaneRuntime()?.paneId;
  useEffect(() => {
    if (paneId !== undefined) seeds?.bootstrap.delete(paneId);
    if (!seeds || !scope) return;
    scope.spent = true;
    queueMicrotask(() => {
      const records = seeds.arrivals.get(scope.id);
      if (!records) return;
      for (const [key, record] of records) if (!record.claimed) { retireArrival(record); records.delete(key); }
      // Claimed work belongs to hooks; retained refs support strict replay.
      seeds.arrivals.delete(scope.id);
    });
  }, [seeds, paneId, scope]);
  return null;
}

/** Synchronous bootstrap projection for the unchanged paged readers. */
export function useServerSeed<T>(key: string | null): Visit<T> | null {
  const seeds = useContext(Seeds);
  const paneId = usePaneRuntime()?.paneId;
  const pane = paneId === undefined ? undefined : seeds?.bootstrap.get(paneId);
  const [seed] = useState(() => key !== null && pane !== undefined && Object.hasOwn(pane, key)
    // justify-type-assertion: bootstrap registry and caller share the representation key.
    ? { key, data: pane[key] as T, source: LIVE_SOURCE, acceptedStale: null } : null);
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
  return {
    key, data: shown?.key === key ? shown.data : null,
    source: shown?.source ?? LIVE_SOURCE,
    acceptedStale: shown?.acceptedStale ?? null,
    generation: 0, error: null, running: key !== null,
  };
}

function useServerState<D>(
  key: string | null,
  stale: string,
  restored: Visit<D> | null,
  load: Load<D>,
  readPolicy: string,
  policy: ReadPolicy,
  catalog?: CatalogRead<D>,
  onDefect?: (defect: Defect) => void,
) {
  const admissionGeneration = useRemoteGeneration();
  const account = useOptionalAuthenticatedAccount();
  const accountId = account?.accountId ?? null;
  const [firstAccount] = useState(accountId);
  const stateKey = key === null ? null : JSON.stringify([accountId, key]);
  const restoredHere = useMemo(() =>
    stateKey !== null && restored !== null && restored.key === key && accountId === firstAccount &&
      (restored.source.kind === "live" || restored.source.snapshot_id === catalog?.snapshot_id)
      ? { ...restored, key: stateKey } : null,
  [stateKey, restored, key, accountId, firstAccount, catalog?.snapshot_id]);
  const throwHere = useThrowLater();
  const fail = onDefect ?? throwHere;
  const signIn = useUnauthenticatedApiHandler();
  const { peek: preparedOutcome, claim: claimArrival } = useServerArrival({ key, stale, load, readPolicy, ...policy });
  const arrivalScope = useContext(ArrivalContext);
  const bootstrap = useServerSeed<D>(arrivalScope === null ? key : null);
  const seedHere = arrivalScope === null && stateKey !== null && bootstrap !== null && bootstrap.key === key && accountId === firstAccount
    ? { ...bootstrap, key: stateKey, acceptedStale: stale } : null;
  const initial = preparedOutcome?.status === "success" && stateKey !== null
    ? { key: stateKey, data: preparedOutcome.data, source: LIVE_SOURCE, acceptedStale: stale }
    : seedHere ?? restoredHere;
  const heldRef = useRef<Held<D> | null>(null);
  const [state, setState] = useState(() => ({ ...arrive(stateKey, initial), running: initial === null || initial === restoredHere }));
  const held = state.key === stateKey ? state : arrive(stateKey, restoredHere);
  heldRef.current = held;
  const loadRef = useRef(load);
  loadRef.current = load;
  const latest = useRef({ key, stale, accountId, catalog, policy, stateKey });
  latest.current = { key, stale, accountId, catalog, policy, stateKey };
  type Flight = { controller: AbortController; strict: boolean; observe: boolean };
  const flight = useRef<Flight | null>(null);
  const waiters = useRef(new Set<{ resolve: () => void; reject: (error: unknown) => void }>());
  const mounted = useRef(false);
  const settle = (error: unknown | null) => {
    for (const waiter of waiters.current) { if (error === null) waiter.resolve(); else waiter.reject(error); }
    waiters.current.clear();
  };
  const update = (change: (held: Held<D>) => Held<D>) => {
    const previous = heldRef.current;
    if (previous === null) return;
    const next = change(previous);
    heldRef.current = next;
    setState(next);
  };
  const start = useRef<() => void>(() => {});
  const queueRead = () => {
    if (!mounted.current) return;
    if (flight.current !== null) flight.current.strict = true;
    else start.current();
  };
  const owner = useReadOwner(key, policyIdentity({ readPolicy, ...policy }), stale, queueRead);
  const lane = useMemo(() => ({ active: false, owner, stateKey }), [owner, stateKey]);
  const run = useCallback(async (prepared: ArrivalClaim<D> | null = null) => {
    if (flight.current !== null) { flight.current.strict = true; return; }
    const controller = new AbortController();
    const current: Flight = { controller, strict: true, observe: false };
    flight.current = current;
    const releasePrepared = () => prepared?.release();
    controller.signal.addEventListener("abort", releasePrepared, { once: true });
    update(h => ({ ...h, running: true }));
    try {
      while (current.strict || current.observe) {
        if (controller.signal.aborted || latest.current.accountId !== accountId || latest.current.stateKey !== stateKey) return;
        current.strict = false;
        current.observe = false;
        const reading = latest.current;
        const generation = owner.generation;
        const superseded = () => controller.signal.aborted || current.strict || generation !== owner.generation || reading.accountId !== latest.current.accountId || reading.key !== latest.current.key || reading.stale !== latest.current.stale;
        try {
          let localError: ApiError | null = null;
          const retained = heldRef.current;
          if (reading.catalog && (retained?.data === null || retained?.source.kind === "catalog")) {
            try {
              const saved = await reading.catalog.load(controller.signal);
              if (superseded()) continue;
              if (saved !== null) update(h => ({ ...h, data: saved.data, source: saved.source, acceptedStale: null, error: null, generation: h.generation + 1 }));
              else localError = new ApiError(0, "E_CATALOG_UNAVAILABLE", "catalog not ready on this device");
            } catch (error) {
              if (controller.signal.aborted) return;
              if (!isApiError(error)) throw error;
              localError = error;
            }
          }
          if (localError?.code === "E_CATALOG_COVERAGE" && heldRef.current?.source.kind === "catalog")
            update(h => ({ ...h, data: null, source: LIVE_SOURCE, acceptedStale: null, error: remoteAttemptAllowed() ? null : localError }));
          let next: D;
          if (prepared !== null) {
            const claimed = prepared;
            try { next = await claimed.promise; }
            finally { claimed.release(); prepared = null; }
          } else {
            if (!remoteAttemptAllowed()) {
              const error = localError ?? new ApiError(0, "E_NETWORK", "this view needs a connection");
              update(h => ({ ...h, error: h.data === null ? error : null }));
              settle(error);
              current.observe = false;
              break;
            }
            const request = loadRef.current;
            next = await owner.read("value", signal => requestWithRetry(request, signal, reading.policy), controller.signal);
          }
          if (superseded()) continue;
          update(h => ({ ...h, data: next, source: LIVE_SOURCE, acceptedStale: reading.stale, error: null, generation: h.generation + 1 }));
          settle(null);
        } catch (error) {
          if (controller.signal.aborted) return;
          if (superseded()) continue;
          const modeled = modeledApiError(error, fail, signIn);
          if (modeled !== null && !(modeled.code === "E_NETWORK" && !remoteReady() && heldRef.current?.source.kind === "catalog" && heldRef.current.data !== null))
            update(h => ({ ...h, error: modeled }));
          settle(error);
          current.observe = false;
          break;
        }
      }
    } finally {
      prepared?.release();
      controller.signal.removeEventListener("abort", releasePrepared);
      if (flight.current === current) {
        flight.current = null;
        if (!controller.signal.aborted) update(h => ({ ...h, running: false }));
      }
    }
  // Presentation refs update synchronously; owner/key alone define this lane.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fail, signIn, owner, accountId, stateKey]);
  start.current = () => { void run(); };

  const seeded = useRef(seedHere !== null ? key : null);
  const claimedArrival = useRef(false);
  useEffect(() => {
    mounted.current = true;
    lane.active = true;
    const next = heldRef.current;
    if (next?.key !== stateKey) update(() => arrive(stateKey, restoredHere));
    if (key !== null) {
      const prepared = claimArrival();
      if (prepared !== null) {
        claimedArrival.current = true;
        void run(prepared);
      } else if (seeded.current === key && !claimedArrival.current) {
        seeded.current = null;
        update(h => ({ ...h, running: false }));
      } else void run();
    }
    return () => {
      mounted.current = false;
      lane.active = false;
      flight.current?.controller.abort(new DOMException("read retired", "AbortError"));
      flight.current = null;
      settle(new DOMException("read retired", "AbortError"));
    };
  // Key entry consumes at most one prepared read; descriptor changes are ordinary invalidations.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, stateKey, run, lane]);

  const catalogSnapshot = catalog?.snapshot_id ?? null;
  const observedCatalog = useRef(catalogSnapshot);
  useEffect(() => {
    if (observedCatalog.current === catalogSnapshot) return;
    observedCatalog.current = catalogSnapshot;
    if (heldRef.current?.data !== null && heldRef.current?.source.kind === "live") return;
    owner.invalidate();
  }, [catalogSnapshot, owner]);
  const refetch = useCallback((): Promise<void> => {
    const active = lane.active && mounted.current && key !== null && latest.current.stateKey === stateKey;
    const promise = active
      ? new Promise<void>((resolve, reject) => waiters.current.add({ resolve, reject }))
      : Promise.reject<void>(new DOMException("read retired", "AbortError"));
    if (active) owner.invalidate();
    // Event callers may ignore this promise: modeled failures already render
    // and defects already reach the boundary. Awaiters receive this SAME
    // rejected promise, including key/account retirement.
    void promise.catch(() => {});
    return promise;
  }, [key, owner, stateKey, lane]);
  const revalidate = useCallback(() => {
    if (!lane.active || !mounted.current || key === null || latest.current.stateKey !== stateKey || heldRef.current?.error !== null) return;
    if (flight.current !== null) flight.current.observe = true;
    else start.current();
  }, [key, stateKey, lane]);
  const admittedGeneration = useRef(admissionGeneration);
  useEffect(() => {
    if (admissionGeneration === admittedGeneration.current) return;
    admittedGeneration.current = admissionGeneration;
    void refetch().catch(() => { /* A modeled read failure is rendered by this owner. */ });
  }, [admissionGeneration, refetch]);

  return valueOf(held, stale, refetch, revalidate);
}

function valueOf<T>(held: Held<T>, stale: string, refetch: () => Promise<void>, revalidate: () => void): ServerValue<T> {
  if (held.data === null) return held.error === null
    ? { status: "loading", refetch, revalidate }
    : { status: "failed", error: held.error, retrying: held.running, refetch, revalidate };
  return {
    status: "ready", data: held.data, source: held.source,
    acceptedStale: held.acceptedStale,
    fresh: held.source.kind === "live" && held.acceptedStale === stale,
    generation: held.generation, error: held.error, refreshing: held.running,
    refetch, revalidate,
  };
}

export function useServerValue<T>(input: ReadPolicy & {
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
  const value = useServerState(input.key, input.stale, restored, input.load, input.readPolicy ?? "value:retry3", input, input.catalog);
  shown.current =
    input.key !== null && value.status === "ready"
      ? { key: input.key, data: value.data, source: value.source, acceptedStale: value.acceptedStale }
      : null;
  return value;
}

export function usePaneFreeServerValue<T>(input: ReadPolicy & {
  readonly key: string | null;
  readonly stale: string;
  readonly load: Load<T>;
  readonly readPolicy?: string;
  readonly catalog?: CatalogRead<T>;
  /** An account owner relays defects below its retained command state. */
  readonly onDefect?: (defect: Defect) => void;
}): ServerValue<T> {
  return useServerState(input.key, input.stale, null, input.load, input.readPolicy ?? "value:retry3", input, input.catalog, input.onDefect);
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
