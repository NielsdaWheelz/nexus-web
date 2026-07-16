"use client";

/**
 * LecternProvider — the single FIFO owner of every Lectern/consumption mutation
 * and every reconciliation/initial/revalidation GET (spec
 * `docs/cutovers/lectern-player-lifecycle-hard-cutover.md` §6).
 *
 * One lane serializes all work: nothing overtakes a mutation install, and a
 * queued GET can never overwrite a mutation result that landed after it was
 * enqueued. A capability promise represents ONE logical attempt — it stays
 * pending across an unknown outcome and same-id Retry, resolves only after the
 * canonical snapshot is installed, and rejects only after definitive
 * reconciliation (or provider unmount, with an abort error).
 *
 * Leaves call only the seven semantic methods and render `presentedSnapshot`
 * while Pending; the provider mints `clientMutationId`, owns optimism for
 * Remove/reorder, and owns the deadline/Retry/reconciliation lifecycle.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, isApiError } from "@/lib/api/client";
import type { AsyncResource } from "@/lib/api/useResource";
import { isAbortError } from "@/lib/errors";
import {
  getLectern,
  postConsumptionCommand,
  postLecternCommand,
  type ConsumptionCommand,
  type ConsumptionResult,
  type LecternCommand,
  type LecternItem,
  type LecternItemId,
  type LecternResult,
  type LecternSnapshot,
  type MediaId,
  type MediaListeningState,
  type NextCapability,
  type Placement,
} from "@/lib/lectern/client";

export const LECTERN_COMMAND_DEADLINE_MS = 35_000;
export const LECTERN_REVALIDATE_MIN_INTERVAL_MS = 60_000;

export type MutationAttempt = LecternCommand | ConsumptionCommand;

export type LecternMutationState =
  | { kind: "Idle" }
  | { kind: "Pending"; attempt: MutationAttempt; presentedSnapshot: LecternSnapshot }
  | { kind: "RetryableFailure"; attempt: MutationAttempt; error: ApiError; retry: () => void }
  | {
      kind: "ReconciliationFailed";
      attempt: MutationAttempt;
      error: ApiError;
      retryGet: () => void;
    };

/**
 * Minimal event stream the player provider (later unit) subscribes to for
 * resets/origin diffs: one canonical snapshot install and the listening states
 * a consumption command reset.
 */
export type CanonicalInstallEvent =
  | { kind: "snapshot"; snapshot: LecternSnapshot }
  | { kind: "listeningStates"; states: MediaListeningState[] };

export interface LecternCapability {
  resource: AsyncResource<LecternSnapshot>;
  mutation: LecternMutationState;
  placeItems(input: { mediaIds: MediaId[]; placement: Placement }): Promise<LecternResult>;
  removeItem(itemId: LecternItemId): Promise<LecternResult>;
  setOrder(itemIds: LecternItemId[]): Promise<LecternResult>;
  ensureMediaFinished(mediaId: MediaId): Promise<ConsumptionResult>;
  finishLecternItem(input: {
    mediaId: MediaId;
    itemId: LecternItemId;
    nextCapability: NextCapability;
  }): Promise<ConsumptionResult>;
  setUnread(mediaId: MediaId): Promise<ConsumptionResult>;
  setBatchState(input: {
    mediaIds: MediaId[];
    state: "Finished" | "Unread";
  }): Promise<ConsumptionResult>;
  onCanonicalInstall(listener: (event: CanonicalInstallEvent) => void): () => void;
}

// --- Internal primitives -----------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeAbortError(): DOMException {
  return new DOMException("Lectern provider aborted", "AbortError");
}

function toApiError(error: unknown): ApiError {
  if (isApiError(error)) return error;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new ApiError(0, "E_TIMEOUT", "The command exceeded its deadline");
  }
  if (isAbortError(error)) {
    return new ApiError(0, "E_TIMEOUT", "The command exceeded its deadline");
  }
  return new ApiError(0, "E_NETWORK", error instanceof Error ? error.message : "Request failed");
}

// All 4xx are definitive: they will not resolve by re-sending the same frozen
// body under the same clientMutationId (a same-id retry returns the memoized
// outcome, never a fresh 4xx). Timeout/network/5xx are unknown outcomes and
// stay retryable. Replay-mismatch cannot occur through this provider because it
// always re-sends byte-identical bodies per id; if it ever surfaces it is
// definitive too, which is the correct disposition (reconcile + reject).
function isDefinitiveFailure(error: unknown): error is ApiError {
  return isApiError(error) && error.status >= 400 && error.status < 500;
}

// --- Engine ------------------------------------------------------------------

interface EngineDeps {
  setResource: (resource: AsyncResource<LecternSnapshot>) => void;
  setMutation: (mutation: LecternMutationState) => void;
}

type GateOutcome = "retry" | "aborted";

type LecternEngineMethods = Pick<
  LecternCapability,
  | "placeItems"
  | "removeItem"
  | "setOrder"
  | "ensureMediaFinished"
  | "finishLecternItem"
  | "setUnread"
  | "setBatchState"
  | "onCanonicalInstall"
>;

interface LecternEngine extends LecternEngineMethods {
  start: () => void;
  stop: () => void;
}

function createLecternEngine(deps: EngineDeps): LecternEngine {
  let running = false;
  let generation = 0;
  let lifecycleController = new AbortController();
  let lane: Promise<void> = Promise.resolve();
  let installCounter = 0;
  let lastInstallAt = 0;
  let revalidationQueued = false;

  let resource: AsyncResource<LecternSnapshot> = { status: "loading" };
  let mutation: LecternMutationState = { kind: "Idle" };

  const gates = new Set<(outcome: GateOutcome) => void>();
  const listeners = new Set<(event: CanonicalInstallEvent) => void>();

  const active = (gen: number): boolean => running && gen === generation;

  function setResource(next: AsyncResource<LecternSnapshot>): void {
    resource = next;
    if (running) deps.setResource(next);
  }

  function setMutation(next: LecternMutationState): void {
    mutation = next;
    if (running) deps.setMutation(next);
  }

  function emit(event: CanonicalInstallEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  function installCanonical(snapshot: LecternSnapshot): void {
    installCounter += 1;
    lastInstallAt = Date.now();
    setResource({ status: "ready", data: snapshot });
    emit({ kind: "snapshot", snapshot });
  }

  function requireReadySnapshot(): LecternSnapshot {
    if (resource.status !== "ready") {
      throw new Error("Lectern mutation invoked before the snapshot is Ready (defect).");
    }
    return resource.data;
  }

  function enqueue(task: () => Promise<void>): void {
    lane = lane.then(task, task);
  }

  // Park the lane on a failure state until the user acts (retry/retryGet) or the
  // provider aborts. Holding the lane is intentional: later commands are visibly
  // blocked until the failure is reconciled (spec §6).
  function park(
    build: (resolveGate: (outcome: GateOutcome) => void) => LecternMutationState,
  ): Promise<GateOutcome> {
    const deferred = createDeferred<GateOutcome>();
    const resolveGate = (outcome: GateOutcome): void => {
      if (!gates.has(resolveGate)) return;
      gates.delete(resolveGate);
      deferred.resolve(outcome);
    };
    gates.add(resolveGate);
    setMutation(build(resolveGate));
    return deferred.promise;
  }

  async function runWithDeadline<R>(fn: (signal: AbortSignal) => Promise<R>): Promise<R> {
    const controller = new AbortController();
    const onLifecycleAbort = (): void => controller.abort(makeAbortError());
    if (lifecycleController.signal.aborted) {
      controller.abort(makeAbortError());
    } else {
      lifecycleController.signal.addEventListener("abort", onLifecycleAbort, { once: true });
    }
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Lectern command deadline exceeded", "TimeoutError"));
    }, LECTERN_COMMAND_DEADLINE_MS);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
      lifecycleController.signal.removeEventListener("abort", onLifecycleAbort);
    }
  }

  // One required reconciliation GET. On GET failure, expose GET-only Retry and
  // keep the caller promise pending; never rerun the definitive command.
  async function runReconciliation(gen: number, attempt: MutationAttempt): Promise<GateOutcome> {
    for (;;) {
      if (!active(gen)) return "aborted";
      let snapshot: LecternSnapshot | undefined;
      let failure: unknown;
      let ok = false;
      try {
        snapshot = await runWithDeadline(getLectern);
        ok = true;
      } catch (error) {
        failure = error;
      }
      if (!active(gen)) return "aborted";
      if (ok) {
        installCanonical(snapshot as LecternSnapshot);
        return "retry";
      }
      const outcome = await park((resolveGate) => ({
        kind: "ReconciliationFailed",
        attempt,
        error: toApiError(failure),
        retryGet: () => resolveGate("retry"),
      }));
      if (outcome === "aborted") return "aborted";
    }
  }

  async function runMutationFlow<R>(
    gen: number,
    attempt: MutationAttempt,
    presentedSnapshot: LecternSnapshot,
    execute: (signal: AbortSignal) => Promise<R>,
    installResult: (result: R) => void,
    deferred: Deferred<R>,
  ): Promise<void> {
    for (;;) {
      if (!active(gen)) {
        deferred.reject(makeAbortError());
        return;
      }
      setMutation({ kind: "Pending", attempt, presentedSnapshot });
      let result: R | undefined;
      let failure: unknown;
      let ok = false;
      try {
        result = await runWithDeadline(execute);
        ok = true;
      } catch (error) {
        failure = error;
      }
      if (!active(gen)) {
        deferred.reject(makeAbortError());
        return;
      }
      if (ok) {
        installResult(result as R);
        setMutation({ kind: "Idle" });
        deferred.resolve(result as R);
        return;
      }
      if (isDefinitiveFailure(failure)) {
        const definitive = failure;
        const reconciled = await runReconciliation(gen, attempt);
        if (reconciled === "aborted") {
          deferred.reject(makeAbortError());
          return;
        }
        setMutation({ kind: "Idle" });
        deferred.reject(definitive);
        return;
      }
      // Unknown outcome: stop being in flight, render provider-owned same-id
      // Retry, and block the lane until the user retries or the provider aborts.
      const outcome = await park((resolveGate) => ({
        kind: "RetryableFailure",
        attempt,
        error: toApiError(failure),
        retry: () => resolveGate("retry"),
      }));
      if (outcome === "aborted") {
        deferred.reject(makeAbortError());
        return;
      }
      // Retry loops with the SAME frozen command (identical id + wire body).
    }
  }

  async function runInitialGet(gen: number): Promise<void> {
    if (!active(gen)) return;
    setResource({ status: "loading" });
    let snapshot: LecternSnapshot | undefined;
    let failure: unknown;
    let ok = false;
    try {
      snapshot = await runWithDeadline(getLectern);
      ok = true;
    } catch (error) {
      failure = error;
    }
    if (!active(gen)) return;
    if (ok) {
      installCanonical(snapshot as LecternSnapshot);
      return;
    }
    setResource({
      status: "error",
      error: toApiError(failure),
      retry: () => {
        if (active(gen)) enqueue(() => runInitialGet(gen));
      },
    });
  }

  async function runRevalidationGet(gen: number, enqueuedCounter: number): Promise<void> {
    try {
      if (!active(gen)) return;
      let snapshot: LecternSnapshot | undefined;
      let ok = false;
      try {
        snapshot = await runWithDeadline(getLectern);
        ok = true;
      } catch {
        // justify-ignore-error: revalidation is best-effort. A failed background
        // GET keeps the last good snapshot; the spec surfaces no error affordance
        // for revalidation (never poll, no public refresh).
        ok = false;
      }
      if (!active(gen) || !ok) return;
      // Skip installing if any mutation/reconciliation install landed after this
      // GET was enqueued (a GET cannot overwrite a later mutation result).
      if (installCounter !== enqueuedCounter) return;
      installCanonical(snapshot as LecternSnapshot);
    } finally {
      revalidationQueued = false;
    }
  }

  function maybeRevalidate(gen: number): void {
    if (!active(gen)) return;
    if (resource.status !== "ready") return;
    if (Date.now() - lastInstallAt < LECTERN_REVALIDATE_MIN_INTERVAL_MS) return;
    if (revalidationQueued) return;
    revalidationQueued = true;
    const enqueuedCounter = installCounter;
    enqueue(() => runRevalidationGet(gen, enqueuedCounter));
  }

  function enqueueLecternMutation(
    gen: number,
    command: LecternCommand,
    presented: LecternSnapshot,
  ): Promise<LecternResult> {
    const deferred = createDeferred<LecternResult>();
    if (mutation.kind === "Idle") {
      setMutation({ kind: "Pending", attempt: command, presentedSnapshot: presented });
    }
    enqueue(() =>
      runMutationFlow(
        gen,
        command,
        presented,
        (signal) => postLecternCommand(command, signal),
        (result) => installCanonical(result.lectern),
        deferred,
      ),
    );
    return deferred.promise;
  }

  function enqueueConsumptionMutation(
    gen: number,
    command: ConsumptionCommand,
    presented: LecternSnapshot,
  ): Promise<ConsumptionResult> {
    const deferred = createDeferred<ConsumptionResult>();
    if (mutation.kind === "Idle") {
      setMutation({ kind: "Pending", attempt: command, presentedSnapshot: presented });
    }
    enqueue(() =>
      runMutationFlow(
        gen,
        command,
        presented,
        (signal) => postConsumptionCommand(command, signal),
        (result) => {
          installCanonical(result.lectern);
          emit({ kind: "listeningStates", states: result.listeningStates });
        },
        deferred,
      ),
    );
    return deferred.promise;
  }

  // --- Public capability -----------------------------------------------------

  function placeItems(input: { mediaIds: MediaId[]; placement: Placement }): Promise<LecternResult> {
    const snapshot = requireReadySnapshot();
    const command: LecternCommand = {
      kind: "PlaceItems",
      clientMutationId: crypto.randomUUID(),
      mediaIds: input.mediaIds,
      placement: input.placement,
    };
    return enqueueLecternMutation(generation, command, snapshot);
  }

  function removeItem(itemId: LecternItemId): Promise<LecternResult> {
    const snapshot = requireReadySnapshot();
    const command: LecternCommand = {
      kind: "RemoveItem",
      clientMutationId: crypto.randomUUID(),
      itemId,
    };
    const presented: LecternSnapshot = {
      items: snapshot.items.filter((item) => item.itemId !== itemId),
    };
    return enqueueLecternMutation(generation, command, presented);
  }

  function setOrder(itemIds: LecternItemId[]): Promise<LecternResult> {
    const snapshot = requireReadySnapshot();
    const command: LecternCommand = {
      kind: "SetOrder",
      clientMutationId: crypto.randomUUID(),
      itemIds,
    };
    const byId = new Map(snapshot.items.map((item) => [item.itemId, item]));
    const presented: LecternSnapshot = {
      items: itemIds
        .map((id) => byId.get(id))
        .filter((item): item is LecternItem => item !== undefined),
    };
    return enqueueLecternMutation(generation, command, presented);
  }

  function ensureMediaFinished(mediaId: MediaId): Promise<ConsumptionResult> {
    const snapshot = requireReadySnapshot();
    const command: ConsumptionCommand = {
      kind: "EnsureMediaFinished",
      clientMutationId: crypto.randomUUID(),
      mediaId,
    };
    return enqueueConsumptionMutation(generation, command, snapshot);
  }

  function finishLecternItem(input: {
    mediaId: MediaId;
    itemId: LecternItemId;
    nextCapability: NextCapability;
  }): Promise<ConsumptionResult> {
    const snapshot = requireReadySnapshot();
    const command: ConsumptionCommand = {
      kind: "FinishLecternItem",
      clientMutationId: crypto.randomUUID(),
      mediaId: input.mediaId,
      itemId: input.itemId,
      nextCapability: input.nextCapability,
    };
    return enqueueConsumptionMutation(generation, command, snapshot);
  }

  function setUnread(mediaId: MediaId): Promise<ConsumptionResult> {
    const snapshot = requireReadySnapshot();
    const command: ConsumptionCommand = {
      kind: "SetUnread",
      clientMutationId: crypto.randomUUID(),
      mediaId,
    };
    return enqueueConsumptionMutation(generation, command, snapshot);
  }

  function setBatchState(input: {
    mediaIds: MediaId[];
    state: "Finished" | "Unread";
  }): Promise<ConsumptionResult> {
    const snapshot = requireReadySnapshot();
    const command: ConsumptionCommand = {
      kind: "SetBatchState",
      clientMutationId: crypto.randomUUID(),
      mediaIds: input.mediaIds,
      state: input.state,
    };
    return enqueueConsumptionMutation(generation, command, snapshot);
  }

  function onCanonicalInstall(listener: (event: CanonicalInstallEvent) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  // --- Lifecycle -------------------------------------------------------------

  let onFocus = (): void => {};
  let onVisibility = (): void => {};
  let onOnline = (): void => {};

  function start(): void {
    generation += 1;
    const gen = generation;
    running = true;
    if (lifecycleController.signal.aborted) lifecycleController = new AbortController();
    lane = Promise.resolve();
    revalidationQueued = false;
    setResource({ status: "loading" });
    setMutation({ kind: "Idle" });
    onFocus = () => maybeRevalidate(gen);
    onVisibility = () => {
      if (document.visibilityState === "visible") maybeRevalidate(gen);
    };
    onOnline = () => maybeRevalidate(gen);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    enqueue(() => runInitialGet(gen));
  }

  function stop(): void {
    running = false;
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    lifecycleController.abort(makeAbortError());
    for (const resolveGate of [...gates]) resolveGate("aborted");
  }

  return {
    placeItems,
    removeItem,
    setOrder,
    ensureMediaFinished,
    finishLecternItem,
    setUnread,
    setBatchState,
    onCanonicalInstall,
    start,
    stop,
  };
}

// --- React binding -----------------------------------------------------------

const LecternContext = createContext<LecternCapability | null>(null);

export function LecternProvider({ children }: { children: ReactNode }) {
  const [resource, setResource] = useState<AsyncResource<LecternSnapshot>>({ status: "loading" });
  const [mutation, setMutation] = useState<LecternMutationState>({ kind: "Idle" });

  // The engine is created at render (once) so a child provider's mount effect —
  // which runs before this parent's effect — can register onCanonicalInstall
  // before the lane starts.
  const engineRef = useRef<ReturnType<typeof createLecternEngine> | null>(null);
  if (engineRef.current === null) {
    engineRef.current = createLecternEngine({ setResource, setMutation });
  }
  const engine = engineRef.current;

  useEffect(() => {
    engine.start();
    return () => engine.stop();
  }, [engine]);

  const value = useMemo<LecternCapability>(
    () => ({
      resource,
      mutation,
      placeItems: engine.placeItems,
      removeItem: engine.removeItem,
      setOrder: engine.setOrder,
      ensureMediaFinished: engine.ensureMediaFinished,
      finishLecternItem: engine.finishLecternItem,
      setUnread: engine.setUnread,
      setBatchState: engine.setBatchState,
      onCanonicalInstall: engine.onCanonicalInstall,
    }),
    [engine, resource, mutation],
  );

  return <LecternContext.Provider value={value}>{children}</LecternContext.Provider>;
}

export function useLectern(): LecternCapability {
  const value = useContext(LecternContext);
  if (value === null) {
    throw new Error("useLectern must be used within a LecternProvider.");
  }
  return value;
}
