import type { ResourceActivation } from "@/lib/resources/activation";
import type { CanonicalResourceRef } from "@/lib/sharing/types";
import type { DestructiveActionSettlement } from "@/lib/actions/destructiveActionSettlement";

/** Shared delivery mechanics only; domain modules own every action vocabulary. */
export interface MountedActionIntentBase {
  readonly ref: CanonicalResourceRef;
  readonly activation: ResourceActivation;
}

export interface CommittingMountedActionIntentBase extends MountedActionIntentBase {
  /** Runtime-owned snapshot reconciliation after authoritative domain success. */
  readonly onCommitted: () => Promise<void>;
  /** Terminates the invocation when its mounted interaction closes without a commit. */
  readonly onAborted: () => void;
}

/** Delete-only port supplied by the canonical runtime; no mounted owner retries. */
export interface DestructiveCommittingMountedActionIntentBase extends CommittingMountedActionIntentBase {
  readonly settleDeletionCommand: (
    command: () => Promise<unknown>,
  ) => Promise<DestructiveActionSettlement>;
}

export type DestructiveMountedMutationOutcome =
  | {
      readonly kind: "Committed";
      readonly evidence: "Acknowledged" | "ObservedMissing";
      readonly projectionError?: unknown;
    }
  | { readonly kind: "Unconfirmed" };

/**
 * Keep the authoritative delete and its best-effort mounted projection as two
 * ordered boundaries. A committed delete always crosses canonical
 * reconciliation even when the local refresh fails; an unconfirmed delete has
 * already crossed the runtime's retained-cache barrier before it aborts Busy.
 */
export async function executeDestructiveMountedMutation(
  intent: DestructiveCommittingMountedActionIntentBase,
  command: () => Promise<unknown>,
  projectCommitted: (
    evidence: "Acknowledged" | "ObservedMissing",
  ) => void | Promise<void>,
): Promise<DestructiveMountedMutationOutcome> {
  let settlement: DestructiveActionSettlement;
  try {
    settlement = await intent.settleDeletionCommand(command);
  } catch (error) {
    intent.onAborted();
    throw error;
  }

  switch (settlement.kind) {
    case "NotCommitted":
      intent.onAborted();
      throw settlement.commandError;
    case "Unconfirmed":
      intent.onAborted();
      return { kind: "Unconfirmed" };
    case "Committed": {
      let projectionError: unknown;
      try {
        await projectCommitted(settlement.evidence);
      } catch (error) {
        projectionError = error;
      }
      await intent.onCommitted();
      return {
        kind: "Committed",
        evidence: settlement.evidence,
        ...(projectionError === undefined ? {} : { projectionError }),
      };
    }
  }
}

/**
 * Execute one authoritative mounted mutation and settle its runtime invocation.
 * Mutation rejection aborts; reconciliation rejection cannot retroactively turn
 * an already-committed domain mutation into an abort.
 */
export async function executeCommittingMountedMutation(
  intent: CommittingMountedActionIntentBase,
  mutation: () => Promise<void>,
): Promise<void> {
  try {
    await mutation();
  } catch (error) {
    intent.onAborted();
    throw error;
  }
  await intent.onCommitted();
}

export interface MountedEditorMutationLease {
  /** The authoritative write committed; reconcile and settle the invocation. */
  readonly committed: () => Promise<void>;
  /** The write failed. A mounted editor may retry; an unmounted owner aborts. */
  readonly failed: () => void;
}

export interface MountedEditorIntentController<
  TIntent extends CommittingMountedActionIntentBase,
> {
  /** Accept one interaction while this mounted editor is otherwise idle. */
  readonly accept: (intent: TIntent) => boolean;
  /** Capture the exact accepted intent for one authoritative write attempt. */
  readonly beginMutation: () => MountedEditorMutationLease | null;
  /** Close an accepted edit that has not started an authoritative write. */
  readonly abortEditing: () => boolean;
  /** Release the owner; an already-started write retains settlement ownership. */
  readonly releaseOwner: () => void;
  readonly occupied: () => boolean;
}

interface MountedEditorIntentSlot<
  TIntent extends CommittingMountedActionIntentBase,
> {
  readonly intent: TIntent;
  phase: "Editing" | "Mutating";
  ownerReleased: boolean;
}

/**
 * Lifecycle boundary for an accepted mounted editor action. Unmount aborts an
 * edit that never wrote, but cannot erase responsibility for an in-flight
 * write: late success still reconciles; late failure terminally aborts.
 */
export function createMountedEditorIntentController<
  TIntent extends CommittingMountedActionIntentBase,
>(
  notifyReady: (ref: CanonicalResourceRef) => void,
): MountedEditorIntentController<TIntent> {
  let slot: MountedEditorIntentSlot<TIntent> | null = null;

  const abort = (
    current: MountedEditorIntentSlot<TIntent>,
    notify: boolean,
  ): void => {
    if (slot !== current) return;
    slot = null;
    try {
      current.intent.onAborted();
    } finally {
      if (notify) notifyReady(current.intent.ref);
    }
  };

  return {
    accept(intent) {
      if (slot !== null) return false;
      slot = { intent, phase: "Editing", ownerReleased: false };
      return true;
    },
    beginMutation() {
      if (slot === null || slot.phase === "Mutating") {
        return null;
      }
      const current = slot;
      current.phase = "Mutating";
      let settled = false;
      return {
        async committed() {
          if (settled) return;
          settled = true;
          if (slot !== current) return;
          slot = null;
          try {
            await current.intent.onCommitted();
          } finally {
            if (!current.ownerReleased) notifyReady(current.intent.ref);
          }
        },
        failed() {
          if (settled) return;
          settled = true;
          if (slot !== current) return;
          if (current.ownerReleased) {
            abort(current, false);
          } else {
            current.phase = "Editing";
          }
        },
      };
    },
    abortEditing() {
      if (slot === null || slot.phase !== "Editing") return false;
      abort(slot, true);
      return true;
    },
    releaseOwner() {
      if (slot?.phase === "Editing") {
        abort(slot, false);
      } else if (slot?.phase === "Mutating") {
        slot.ownerReleased = true;
      }
    },
    occupied() {
      return slot !== null;
    },
  };
}

export type MountedActionOwnerDecision =
  { readonly kind: "Accepted" } | { readonly kind: "Deferred" };

export const MOUNTED_ACTION_ACCEPTED: MountedActionOwnerDecision = {
  kind: "Accepted",
};
export const MOUNTED_ACTION_DEFERRED: MountedActionOwnerDecision = {
  kind: "Deferred",
};

export type MountedActionDeliveryOutcome =
  | { readonly kind: "Accepted" }
  | { readonly kind: "Expired" }
  | {
      readonly kind: "Cancelled";
      readonly reason: "ActivationFailed" | "CallerCancelled";
    }
  | { readonly kind: "OwnerDefect"; readonly error: unknown };

export interface MountedActionRequest {
  /** Resolves exactly once; delivery failures are values, never orphaned rejection. */
  readonly outcome: Promise<MountedActionDeliveryOutcome>;
  /** Cancels only while pending. Accepted/terminal requests cannot be recalled. */
  readonly cancel: (reason: "ActivationFailed" | "CallerCancelled") => boolean;
}

interface PendingRequest<TIntent> {
  readonly intent: TIntent;
  readonly settle: (outcome: MountedActionDeliveryOutcome) => void;
  cancelExpiry: () => void;
  pending: boolean;
}

export const MOUNTED_ACTION_DELIVERY_TIMEOUT_MS = 15_000;

interface MountedActionHandoffOptions {
  /** External clock boundary; tests drive it directly without sleeping. */
  readonly scheduleExpiry?: (
    expire: () => void,
    timeoutMs: number,
  ) => () => void;
}

function scheduleMountedActionExpiry(
  expire: () => void,
  timeoutMs: number,
): () => void {
  const timeout = globalThis.setTimeout(expire, timeoutMs);
  return () => globalThis.clearTimeout(timeout);
}

/**
 * A one-shot, in-memory handoff between a global action and its mounted domain
 * owner. Each domain creates a private instance. There is no global registry,
 * string routing, command lookup, or cross-domain dispatch.
 */
export function createMountedActionHandoff<
  TIntent extends MountedActionIntentBase,
>(
  options: MountedActionHandoffOptions = {},
): {
  request(intent: TIntent): MountedActionRequest;
  subscribe(
    ref: CanonicalResourceRef,
    owner: (intent: TIntent) => MountedActionOwnerDecision,
  ): () => void;
  /** Re-offer a deferred head request after an owner becomes available. */
  notifyReady(ref: CanonicalResourceRef): void;
} {
  const scheduleExpiry = options.scheduleExpiry ?? scheduleMountedActionExpiry;
  const pendingByRef = new Map<
    CanonicalResourceRef,
    PendingRequest<TIntent>[]
  >();
  const ownersByRef = new Map<
    CanonicalResourceRef,
    Set<(intent: TIntent) => MountedActionOwnerDecision>
  >();
  const draining = new Set<CanonicalResourceRef>();

  const removePending = (
    ref: CanonicalResourceRef,
    request: PendingRequest<TIntent>,
  ): boolean => {
    if (!request.pending) return false;
    const pending = pendingByRef.get(ref);
    const index = pending?.indexOf(request) ?? -1;
    if (index < 0 || !pending) return false;
    request.pending = false;
    request.cancelExpiry();
    pending.splice(index, 1);
    if (pending.length === 0) pendingByRef.delete(ref);
    return true;
  };

  const drain = (ref: CanonicalResourceRef) => {
    if (draining.has(ref)) return;
    const pending = pendingByRef.get(ref);
    const owners = ownersByRef.get(ref);
    if (!pending?.length || !owners?.size) return;

    draining.add(ref);
    try {
      while (pending.length > 0) {
        const request = pending[0]!;
        let outcome: MountedActionDeliveryOutcome | null = null;
        for (const owner of [...owners]) {
          let decision: MountedActionOwnerDecision;
          try {
            decision = owner(request.intent);
          } catch (error) {
            outcome = { kind: "OwnerDefect", error };
            break;
          }
          if (decision.kind === "Accepted") {
            outcome = { kind: "Accepted" };
            break;
          }
        }
        if (outcome === null) break;
        if (pending[0] === request && removePending(ref, request)) {
          request.settle(outcome);
        }
      }
    } finally {
      draining.delete(ref);
    }
  };

  return {
    request(intent) {
      if (intent.activation.resourceRef !== intent.ref) {
        throw new TypeError(
          "Mounted action activation must identify its canonical ref",
        );
      }
      const retainedIntent = {
        ...intent,
        activation: { ...intent.activation },
      } as TIntent;
      let settle!: (outcome: MountedActionDeliveryOutcome) => void;
      const outcome = new Promise<MountedActionDeliveryOutcome>((resolve) => {
        settle = resolve;
      });
      const request: PendingRequest<TIntent> = {
        intent: retainedIntent,
        settle,
        cancelExpiry: () => {},
        pending: true,
      };
      const pending = pendingByRef.get(intent.ref) ?? [];
      pending.push(request);
      pendingByRef.set(intent.ref, pending);
      const expire = () => {
        if (!removePending(intent.ref, request)) return;
        request.settle({ kind: "Expired" });
        drain(intent.ref);
      };
      request.cancelExpiry = scheduleExpiry(
        expire,
        MOUNTED_ACTION_DELIVERY_TIMEOUT_MS,
      );
      drain(intent.ref);
      return {
        outcome,
        cancel: (reason) => {
          if (!removePending(intent.ref, request)) return false;
          request.settle({ kind: "Cancelled", reason });
          drain(intent.ref);
          return true;
        },
      };
    },
    subscribe(ref, owner) {
      const owners =
        ownersByRef.get(ref) ??
        new Set<(intent: TIntent) => MountedActionOwnerDecision>();
      owners.add(owner);
      ownersByRef.set(ref, owners);
      drain(ref);
      return () => {
        owners.delete(owner);
        if (owners.size === 0) ownersByRef.delete(ref);
        // A different mounted representation may now be the authoritative owner.
        drain(ref);
      };
    },
    notifyReady(ref) {
      drain(ref);
    },
  };
}
