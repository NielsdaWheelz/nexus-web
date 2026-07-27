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
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  getLectern,
  postConsumptionCommand,
  postLecternCommand,
} from "@/lib/lectern/client";
import type {
  ConsumptionCommand,
  ConsumptionResult,
  CompletionHandle,
  LecternCommand,
  LecternItem,
  LecternItemId,
  LecternResult,
  LecternSnapshot,
  MediaId,
  MediaProgressState,
  NextCapability,
  Placement,
} from "@/lib/lectern/contract";

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
 * Minimal install stream for origin maintenance and ResetProgress. The reset
 * carries exactly one server-authoritative current-progress snapshot. A
 * snapshot may additionally name successful status-only Unread targets; that
 * annotation never carries or changes progress state.
 */
export type CanonicalInstallEvent =
  | {
      kind: "snapshot";
      snapshot: LecternSnapshot;
      unreadMediaIds: readonly MediaId[];
    }
  | { kind: "progressState"; state: MediaProgressState };

export interface LecternCapability {
  resource: AsyncResource<LecternSnapshot>;
  mutation: LecternMutationState;
  placeItems(input: {
    mediaIds: MediaId[];
    placement: Placement;
    unknownObservation?: {
      signal: AbortSignal;
      onUnknown: (error: ApiError) => void;
    };
  }): Promise<LecternResult>;
  removeItem(itemId: LecternItemId): Promise<LecternResult>;
  setOrder(itemIds: LecternItemId[]): Promise<LecternResult>;
  ensureMediaFinished(
    mediaId: MediaId,
    options?: { clientMutationId?: string },
  ): Promise<ConsumptionResult>;
  finishLecternItem(input: {
    mediaId: MediaId;
    itemId: LecternItemId;
    nextCapability: NextCapability;
    clientMutationId?: string;
  }): Promise<ConsumptionResult>;
  setUnread(mediaId: MediaId): Promise<ConsumptionResult>;
  resetProgress(mediaId: MediaId): Promise<ConsumptionResult>;
  /**
   * `unreadMediaId` is local installation metadata only: the sealed server
   * command remains identified exclusively by `completionHandle`.
   */
  undoCompletion(
    completionHandle: CompletionHandle,
    options: { unreadMediaId: MediaId },
  ): Promise<ConsumptionResult>;
  setBatchState(input: {
    mediaIds: MediaId[];
    state: "Finished" | "Unread";
  }): Promise<ConsumptionResult>;
  /** Queue one best-effort canonical refresh, bypassing lifecycle throttling. */
  revalidate(): void;
  onCanonicalInstall(listener: (event: CanonicalInstallEvent) => void): () => void;
  /**
   * Register a pre-command hook run (and awaited) before ResetProgress enters
   * the FIFO. Active consumers drain their old generation here; server fences
   * remain the correctness boundary. Returns an unsubscribe.
   */
  registerBeforeProgressReset(hook: (mediaId: MediaId) => Promise<void>): () => void;
  /**
   * Read the provider's current canonical snapshot (undefined until Ready). This
   * is a live read of the FIFO owner, so it stays correct even when the calling
   * leaf has unmounted (spec §6 Undo: the snapshot must survive an offering-pane
   * unmount during the 10s toast).
   */
  getCanonicalSnapshot(): LecternSnapshot | undefined;
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
  // Every caught failure flows through here before it is surfaced: classify
  // unauthenticated errors so the login-redirect owner takes over (the lane
  // still records the failure while the navigation starts).
  handleUnauthenticatedApiError(error);
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
  | "resetProgress"
  | "undoCompletion"
  | "setBatchState"
  | "revalidate"
  | "onCanonicalInstall"
  | "registerBeforeProgressReset"
  | "getCanonicalSnapshot"
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
  let lifecycleRevalidationQueued = false;
  let forcedRevalidationQueued = false;

  let resource: AsyncResource<LecternSnapshot> = { status: "loading" };
  let mutation: LecternMutationState = { kind: "Idle" };

  const gates = new Set<(outcome: GateOutcome) => void>();
  const listeners = new Set<(event: CanonicalInstallEvent) => void>();
  const beforeProgressResetHooks = new Set<(mediaId: MediaId) => Promise<void>>();

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

  function installCanonical(
    snapshot: LecternSnapshot,
    unreadMediaIds: readonly MediaId[] = [],
  ): void {
    installCounter += 1;
    lastInstallAt = Date.now();
    setResource({ status: "ready", data: snapshot });
    emit({ kind: "snapshot", snapshot, unreadMediaIds });
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
        snapshot = await runWithDeadline((signal) => getLectern({ signal }));
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
    unknownObservation?: {
      signal: AbortSignal;
      onUnknown: (error: ApiError) => void;
    },
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
        try {
          installResult(result as R);
        } catch (error) {
          // A decoded same-system response that violates a cross-field
          // command invariant is a defect, not a retryable transport result.
          // Keep the FIFO usable and settle the caller rather than leaving a
          // rejected lane and a permanently pending capability promise.
          setMutation({ kind: "Idle" });
          deferred.reject(error);
          return;
        }
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
      const unknownError = toApiError(failure);
      const parked = park((resolveGate) => ({
        kind: "RetryableFailure",
        attempt,
        error: unknownError,
        retry: () => resolveGate("retry"),
      }));
      if (unknownObservation && !unknownObservation.signal.aborted) {
        unknownObservation.onUnknown(unknownError);
      }
      const outcome = await parked;
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
      snapshot = await runWithDeadline((signal) => getLectern({ signal }));
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

  async function runRevalidationGet(
    gen: number,
    forced: boolean,
    enqueuedCounter: number,
  ): Promise<void> {
    try {
      if (!active(gen)) return;
      let snapshot: LecternSnapshot | undefined;
      let ok = false;
      try {
        snapshot = await runWithDeadline((signal) =>
          getLectern(forced ? { signal, cache: "no-store" } : { signal }),
        );
        ok = true;
      } catch (error) {
        // justify-ignore-error: revalidation is best-effort. A failed background
        // GET keeps the last good snapshot; the spec gives background refresh no
        // error affordance and never polls. Unauthenticated failures still
        // classify to the login-redirect owner.
        handleUnauthenticatedApiError(error);
        ok = false;
      }
      if (!active(gen) || !ok) return;
      // Skip installing if another FIFO install landed while this GET was in
      // flight (a GET cannot overwrite a later mutation result).
      if (installCounter !== enqueuedCounter) return;
      installCanonical(snapshot as LecternSnapshot);
    } finally {
      if (gen === generation) {
        if (forced) {
          forcedRevalidationQueued = false;
        } else {
          lifecycleRevalidationQueued = false;
        }
      }
    }
  }

  function maybeRevalidate(gen: number): void {
    if (!active(gen)) return;
    if (resource.status !== "ready") return;
    if (Date.now() - lastInstallAt < LECTERN_REVALIDATE_MIN_INTERVAL_MS) return;
    if (lifecycleRevalidationQueued) return;
    lifecycleRevalidationQueued = true;
    const enqueuedCounter = installCounter;
    enqueue(() => runRevalidationGet(gen, false, enqueuedCounter));
  }

  function revalidate(): void {
    const gen = generation;
    if (!active(gen) || forcedRevalidationQueued) return;
    forcedRevalidationQueued = true;
    // Capture after all earlier FIFO work, immediately before this GET starts.
    enqueue(() => runRevalidationGet(gen, true, installCounter));
  }

  function enqueueLecternMutation(
    gen: number,
    command: LecternCommand,
    presented: LecternSnapshot,
    unknownObservation?: {
      signal: AbortSignal;
      onUnknown: (error: ApiError) => void;
    },
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
        unknownObservation,
      ),
    );
    return deferred.promise;
  }

  function enqueueConsumptionMutation(
    gen: number,
    command: ConsumptionCommand,
    presented: LecternSnapshot,
    unreadMediaIds: readonly MediaId[] = [],
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
          const progressState = result.progressState;
          if (command.kind === "ResetProgress") {
            if (
              progressState.kind !== "Present" ||
              progressState.value.mediaId !== command.mediaId
            ) {
              // justify-defect: a ResetProgress replay is required to return
              // one installable state for its exact semantic target.
              throw new Error("ResetProgress returned no canonical progress state (defect).");
            }
          } else if (progressState.kind === "Present") {
            // justify-defect: the singular progress-state event has one
            // producer. Accepting it for another command would reintroduce
            // the removed cross-command install path.
            throw new Error("Only ResetProgress may return a progress state (defect).");
          }
          installCanonical(result.lectern, unreadMediaIds);
          if (progressState.kind === "Present") {
            emit({ kind: "progressState", state: progressState.value });
          }
        },
        deferred,
      ),
    );
    return deferred.promise;
  }

  // --- Public capability -----------------------------------------------------

  function placeItems(input: {
    mediaIds: MediaId[];
    placement: Placement;
    unknownObservation?: {
      signal: AbortSignal;
      onUnknown: (error: ApiError) => void;
    };
  }): Promise<LecternResult> {
    const snapshot = requireReadySnapshot();
    const command: LecternCommand = {
      kind: "PlaceItems",
      clientMutationId: crypto.randomUUID(),
      mediaIds: input.mediaIds,
      placement: input.placement,
    };
    return enqueueLecternMutation(
      generation,
      command,
      snapshot,
      input.unknownObservation,
    );
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

  // The player passes its pre-minted CompletionAttempt id so the completion FIFO
  // freezes one logical id/body across retries (spec §6 CompletionAttempt); the
  // provider still mints when a caller supplies none.
  function ensureMediaFinished(
    mediaId: MediaId,
    options?: { clientMutationId?: string },
  ): Promise<ConsumptionResult> {
    const snapshot = requireReadySnapshot();
    const command: ConsumptionCommand = {
      kind: "EnsureMediaFinished",
      clientMutationId: options?.clientMutationId ?? crypto.randomUUID(),
      mediaId,
    };
    return enqueueConsumptionMutation(generation, command, snapshot);
  }

  function finishLecternItem(input: {
    mediaId: MediaId;
    itemId: LecternItemId;
    nextCapability: NextCapability;
    clientMutationId?: string;
  }): Promise<ConsumptionResult> {
    const snapshot = requireReadySnapshot();
    const command: ConsumptionCommand = {
      kind: "FinishLecternItem",
      clientMutationId: input.clientMutationId ?? crypto.randomUUID(),
      mediaId: input.mediaId,
      itemId: input.itemId,
      nextCapability: input.nextCapability,
    };
    return enqueueConsumptionMutation(generation, command, snapshot);
  }

  // Run every registered pre-command hook to completion. Drains are best-effort:
  // a hook failure must not block reset; the server tombstone/fences reject any
  // stale write that escapes locally.
  async function runBeforeProgressReset(mediaId: MediaId): Promise<void> {
    const hooks = [...beforeProgressResetHooks];
    if (hooks.length === 0) return;
    await Promise.allSettled(hooks.map((hook) => hook(mediaId)));
  }

  function setUnread(mediaId: MediaId): Promise<ConsumptionResult> {
    const snapshot = requireReadySnapshot();
    const command: ConsumptionCommand = {
      kind: "SetUnread",
      clientMutationId: crypto.randomUUID(),
      mediaId,
    };
    return enqueueConsumptionMutation(generation, command, snapshot, [mediaId]);
  }

  function resetProgress(mediaId: MediaId): Promise<ConsumptionResult> {
    const snapshot = requireReadySnapshot();
    const gen = generation;
    const command: ConsumptionCommand = {
      kind: "ResetProgress",
      clientMutationId: crypto.randomUUID(),
      mediaId,
    };
    return runBeforeProgressReset(mediaId).then(() => {
      if (!active(gen)) throw makeAbortError();
      return enqueueConsumptionMutation(gen, command, snapshot);
    });
  }

  function undoCompletion(
    completionHandle: CompletionHandle,
    options: { unreadMediaId: MediaId },
  ): Promise<ConsumptionResult> {
    const snapshot = requireReadySnapshot();
    const command: ConsumptionCommand = {
      kind: "UndoCompletion",
      clientMutationId: crypto.randomUUID(),
      completionHandle,
    };
    return enqueueConsumptionMutation(generation, command, snapshot, [options.unreadMediaId]);
  }

  function setBatchState(input: {
    mediaIds: MediaId[];
    state: "Finished" | "Unread";
  }): Promise<ConsumptionResult> {
    const snapshot = requireReadySnapshot();
    // Snapshot the exact target list at submission time. The local annotation
    // must describe the command that is sent, not a caller-owned array later
    // mutated while the FIFO is waiting.
    const mediaIds = [...input.mediaIds];
    const command: ConsumptionCommand = {
      kind: "SetBatchState",
      clientMutationId: crypto.randomUUID(),
      mediaIds,
      state: input.state,
    };
    return enqueueConsumptionMutation(
      generation,
      command,
      snapshot,
      input.state === "Unread" ? mediaIds : [],
    );
  }

  function onCanonicalInstall(listener: (event: CanonicalInstallEvent) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function registerBeforeProgressReset(hook: (mediaId: MediaId) => Promise<void>): () => void {
    beforeProgressResetHooks.add(hook);
    return () => {
      beforeProgressResetHooks.delete(hook);
    };
  }

  function getCanonicalSnapshot(): LecternSnapshot | undefined {
    return resource.status === "ready" ? resource.data : undefined;
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
    lifecycleRevalidationQueued = false;
    forcedRevalidationQueued = false;
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
    resetProgress,
    undoCompletion,
    setBatchState,
    revalidate,
    onCanonicalInstall,
    registerBeforeProgressReset,
    getCanonicalSnapshot,
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
      resetProgress: engine.resetProgress,
      undoCompletion: engine.undoCompletion,
      setBatchState: engine.setBatchState,
      revalidate: engine.revalidate,
      onCanonicalInstall: engine.onCanonicalInstall,
      registerBeforeProgressReset: engine.registerBeforeProgressReset,
      getCanonicalSnapshot: engine.getCanonicalSnapshot,
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
