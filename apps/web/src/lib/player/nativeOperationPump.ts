import type { PlayerError } from "@/lib/player/playerSession";

/**
 * The web-side native operation pump.
 *
 * One `SessionIntent` is in flight at a time; later session intents queue
 * FIFO. Bounded keys (`Dismiss`, `PodcastSettings`, `ListeningProjection`)
 * are latest-wins: a newer dispatch supersedes whatever the key was doing.
 * `Dismiss` is its own key because native exempts it from the pending-receipt
 * barrier: closing the player must not wait behind a parked session intent.
 *
 * An operation that native rejects with `NaturalEndPending` parks on the
 * current receipt barrier and is replayed once that exact receipt is
 * acknowledged. Any other way the barrier ends (the receipt is superseded or
 * cleared) also releases it: a parked operation is never addressed to a
 * receipt that no longer exists. A transport failure parks the operation as a
 * frozen, user-retryable failure; the visible failure is derived from this
 * state, so nothing else can clear it. Stale intents are discarded without
 * blocking the pump.
 *
 * The pump is pure: every transition returns the next state plus the `Run`
 * effects the caller must execute.
 */

export type NativeOperationKey =
  | "SessionIntent"
  | "Dismiss"
  | "PodcastSettings"
  | "ListeningProjection";

export type NativeOperation = {
  key: NativeOperationKey;
  run: () => Promise<void>;
  /**
   * False once a dispatched intent no longer targets live state. Consulted
   * only for replay and pruning of a parked operation — never before an
   * operation's first run, which may itself be what makes it apply.
   */
  stillApplies: () => boolean;
};

export type DispatchedNativeOperation = NativeOperation & {
  sequence: number;
  barrierEpoch: number;
};

export type ParkedReason =
  | { kind: "Barrier"; receiptMutationId: string | null }
  | { kind: "Connection"; error: PlayerError };

export type ParkedNativeOperation = {
  operation: DispatchedNativeOperation;
  reason: ParkedReason;
};

export type NativeOperationPump = {
  readonly nextSequence: number;
  readonly barrierEpoch: number;
  readonly barrierReceiptMutationId: string | null;
  readonly inFlight: DispatchedNativeOperation | null;
  readonly queue: readonly NativeOperation[];
  readonly latest: ReadonlyMap<NativeOperationKey, number>;
  readonly parked: ReadonlyMap<NativeOperationKey, ParkedNativeOperation>;
};

export type PumpStep = {
  pump: NativeOperationPump;
  effects: readonly DispatchedNativeOperation[];
};

export type VisibleConnectionFailure = {
  key: NativeOperationKey;
  error: PlayerError;
};

const FAILURE_PRESENTATION_ORDER: readonly NativeOperationKey[] = [
  "SessionIntent",
  "Dismiss",
  "PodcastSettings",
  "ListeningProjection",
];

export function createNativeOperationPump(): NativeOperationPump {
  return {
    nextSequence: 1,
    barrierEpoch: 0,
    barrierReceiptMutationId: null,
    inFlight: null,
    queue: [],
    latest: new Map(),
    parked: new Map(),
  };
}

/** The frozen transport failure the shell presents, if any. */
export function visibleConnectionFailure(
  pump: NativeOperationPump,
): VisibleConnectionFailure | null {
  for (const key of FAILURE_PRESENTATION_ORDER) {
    const parked = pump.parked.get(key);
    if (parked?.reason.kind === "Connection") {
      return { key, error: parked.reason.error };
    }
  }
  return null;
}

type Draft = {
  nextSequence: number;
  barrierEpoch: number;
  barrierReceiptMutationId: string | null;
  inFlight: DispatchedNativeOperation | null;
  queue: NativeOperation[];
  latest: Map<NativeOperationKey, number>;
  parked: Map<NativeOperationKey, ParkedNativeOperation>;
  effects: DispatchedNativeOperation[];
};

function draft(pump: NativeOperationPump): Draft {
  return {
    nextSequence: pump.nextSequence,
    barrierEpoch: pump.barrierEpoch,
    barrierReceiptMutationId: pump.barrierReceiptMutationId,
    inFlight: pump.inFlight,
    queue: [...pump.queue],
    latest: new Map(pump.latest),
    parked: new Map(pump.parked),
    effects: [],
  };
}

function finish(state: Draft): PumpStep {
  const { effects, ...pump } = state;
  return { pump, effects };
}

function stamp(
  state: Draft,
  operation: NativeOperation,
): DispatchedNativeOperation {
  const dispatched: DispatchedNativeOperation = {
    ...operation,
    sequence: state.nextSequence,
    barrierEpoch: state.barrierEpoch,
  };
  state.nextSequence += 1;
  if (dispatched.key === "SessionIntent") {
    state.inFlight = dispatched;
  } else {
    state.latest.set(dispatched.key, dispatched.sequence);
  }
  state.parked.delete(dispatched.key);
  return dispatched;
}

function run(state: Draft, operation: NativeOperation): void {
  state.effects.push(stamp(state, operation));
}

function drainQueue(state: Draft): void {
  if (state.inFlight !== null) return;
  const next = state.queue.shift();
  if (next !== undefined) run(state, next);
}

function releaseDraft(state: Draft, operation: DispatchedNativeOperation): void {
  if (state.parked.get(operation.key)?.operation.sequence === operation.sequence) {
    state.parked.delete(operation.key);
  }
  if (
    operation.key === "SessionIntent" &&
    state.inFlight?.sequence === operation.sequence
  ) {
    state.inFlight = null;
    drainQueue(state);
  }
}

function resumeOrRelease(state: Draft, operation: DispatchedNativeOperation): void {
  if (operation.stillApplies()) {
    state.parked.delete(operation.key);
    if (operation.key === "SessionIntent") state.inFlight = null;
    run(state, operation);
    return;
  }
  releaseDraft(state, operation);
}

function current(state: Draft, operation: DispatchedNativeOperation): boolean {
  return operation.key === "SessionIntent"
    ? state.inFlight?.sequence === operation.sequence
    : state.latest.get(operation.key) === operation.sequence;
}

function parkedInSequence(
  state: Draft,
  accept: (parked: ParkedNativeOperation) => boolean,
): DispatchedNativeOperation[] {
  return [...state.parked.values()]
    .filter(accept)
    .map((parked) => parked.operation)
    .sort((left, right) => left.sequence - right.sequence);
}

/** Register an operation the caller runs itself; it still owns its key. */
export function stampOperation(
  pump: NativeOperationPump,
  operation: NativeOperation,
): { pump: NativeOperationPump; operation: DispatchedNativeOperation } {
  const state = draft(pump);
  const dispatched = stamp(state, operation);
  return { pump: finish(state).pump, operation: dispatched };
}

export function dispatch(
  pump: NativeOperationPump,
  operation: NativeOperation,
): PumpStep {
  const state = draft(pump);
  if (operation.key === "SessionIntent" && state.inFlight !== null) {
    state.queue.push(operation);
    return finish(state);
  }
  run(state, operation);
  return finish(state);
}

/** The operation is finished with — it succeeded, was cancelled, or became a defect. */
export function settled(
  pump: NativeOperationPump,
  operation: DispatchedNativeOperation,
): PumpStep {
  const state = draft(pump);
  releaseDraft(state, operation);
  return finish(state);
}

/**
 * The runtime invalidated intents (the session changed or the player was
 * dismissed): every parked operation that no longer applies is released so a
 * dead intent cannot hold the queue or present a phantom Retry.
 */
export function pruned(pump: NativeOperationPump): PumpStep {
  const state = draft(pump);
  for (const operation of parkedInSequence(state, () => true)) {
    if (!operation.stillApplies()) releaseDraft(state, operation);
  }
  return finish(state);
}

export function connectionFailed(
  pump: NativeOperationPump,
  operation: DispatchedNativeOperation,
  error: PlayerError,
): PumpStep {
  const state = draft(pump);
  if (!current(state, operation)) return finish(state);
  state.parked.set(operation.key, {
    operation,
    reason: { kind: "Connection", error },
  });
  return finish(state);
}

export function barrierRejected(
  pump: NativeOperationPump,
  operation: DispatchedNativeOperation,
): PumpStep {
  const state = draft(pump);
  if (!current(state, operation)) return finish(state);
  if (operation.barrierEpoch < state.barrierEpoch) {
    // The rejection arrived after its barrier already ended.
    resumeOrRelease(state, operation);
    return finish(state);
  }
  state.parked.set(operation.key, {
    operation,
    reason: {
      kind: "Barrier",
      receiptMutationId: state.barrierReceiptMutationId,
    },
  });
  return finish(state);
}

/** The observed pending receipt changed (arrived, was superseded, or cleared). */
export function barrierChanged(
  pump: NativeOperationPump,
  receiptMutationId: string | null,
): PumpStep {
  const state = draft(pump);
  state.barrierReceiptMutationId = receiptMutationId;
  const released: DispatchedNativeOperation[] = [];
  for (const [key, parked] of state.parked) {
    if (parked.reason.kind !== "Barrier") continue;
    if (parked.reason.receiptMutationId === null && receiptMutationId !== null) {
      state.parked.set(key, {
        operation: parked.operation,
        reason: { kind: "Barrier", receiptMutationId },
      });
    } else if (parked.reason.receiptMutationId !== receiptMutationId) {
      released.push(parked.operation);
    }
  }
  for (const operation of released.sort((a, b) => a.sequence - b.sequence)) {
    resumeOrRelease(state, operation);
  }
  return finish(state);
}

/** Native accepted `AcknowledgeNaturalEnd` for this receipt. */
export function barrierAcknowledged(
  pump: NativeOperationPump,
  receiptMutationId: string,
): PumpStep {
  const state = draft(pump);
  state.barrierEpoch += 1;
  if (state.barrierReceiptMutationId === receiptMutationId) {
    state.barrierReceiptMutationId = null;
  }
  for (const operation of parkedInSequence(
    state,
    (parked) =>
      parked.reason.kind === "Barrier" &&
      (parked.reason.receiptMutationId === receiptMutationId ||
        parked.reason.receiptMutationId === null),
  )) {
    resumeOrRelease(state, operation);
  }
  return finish(state);
}

/** The user retried the presented transport failure. */
export function retry(
  pump: NativeOperationPump,
  key: NativeOperationKey,
): PumpStep {
  const state = draft(pump);
  const parked = state.parked.get(key);
  if (parked?.reason.kind !== "Connection") return finish(state);
  resumeOrRelease(state, parked.operation);
  return finish(state);
}

/**
 * A replacement native controller reconnected with authoritative state. A
 * frozen session intent is ambiguous against that state (it may already have
 * applied on the replaced controller), so it is dropped and the queue drains;
 * frozen bounded operations resume when they still apply.
 */
export function reconnected(pump: NativeOperationPump): PumpStep {
  const state = draft(pump);
  for (const operation of parkedInSequence(
    state,
    (parked) => parked.reason.kind === "Connection",
  )) {
    if (operation.key === "SessionIntent") {
      releaseDraft(state, operation);
    } else {
      resumeOrRelease(state, operation);
    }
  }
  return finish(state);
}
