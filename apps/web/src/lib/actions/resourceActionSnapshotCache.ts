import { isSameSystemApiDefect } from "@/lib/api/client";
import type { ResourceActionSnapshot } from "@/lib/actions/resourceActionSnapshot";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

export type SnapshotCacheEntry =
  | { readonly status: "Loading" }
  | { readonly status: "Ready"; readonly snapshot: ResourceActionSnapshot }
  | {
      readonly status: "Reconciling";
      readonly snapshot: ResourceActionSnapshot;
    }
  | {
      readonly status: "Error";
      readonly error: unknown;
      readonly lastGoodSnapshot?: ResourceActionSnapshot;
      /** A shared retry/reconciliation read is running against stale facts. */
      readonly retrying?: true;
    };

export type ResourceActionReconciliationScope =
  | { readonly kind: "None" }
  | {
      readonly kind: "Subjects";
      readonly refs: readonly CanonicalResourceRef[];
    }
  | { readonly kind: "AllRetained" };

/** Fetch exactly one ordered snapshot for every requested ref. */
export type ResolveSnapshots = (
  refs: readonly CanonicalResourceRef[],
) => Promise<readonly ResourceActionSnapshot[]>;

/** Defer the first retained-ref batch to the end of the current tick. */
export type ScheduleFlush = (flush: () => void | Promise<void>) => void;

export interface ResourceActionSnapshotCache {
  /** Retain one mounted subject and return an idempotent release. */
  retain(ref: CanonicalResourceRef): () => void;
  /** Read the subject's public cache phase. Reading never starts transport. */
  peek(ref: CanonicalResourceRef): SnapshotCacheEntry | undefined;
  /** Retry the failed first resolve or failed reconciliation for one subject. */
  retry(ref: CanonicalResourceRef): Promise<void>;
  /** Apply an effect's declared, bounded reconciliation scope. */
  reconcile(scope: ResourceActionReconciliationScope): Promise<void>;
  subscribe(listener: () => void): () => void;
}

interface RetainedEntry {
  retainCount: number;
  generation: number;
  inFlightCount: number;
  retryPromise?: Promise<void>;
  /**
   * The latest mutation reconciliation that includes this ref. Overlapping
   * effects join this boundary before starting their own authoritative read,
   * so an older caller cannot release its busy action while a newer read still
   * exposes the shared last-good snapshot.
   */
  reconciliationTail?: Promise<void>;
  state: SnapshotCacheEntry;
}

interface ResolveRequest {
  readonly ref: CanonicalResourceRef;
  readonly entry: RetainedEntry;
  readonly generation: number;
  readonly lastGoodSnapshot?: ResourceActionSnapshot;
}

class SnapshotResolveContractDefect extends TypeError {
  constructor(message: string) {
    // justify-defect: the authenticated server and strict client ship together;
    // an incomplete or reordered response is same-system contract drift.
    super(message);
    this.name = "SnapshotResolveContractDefect";
  }
}

function lastGoodSnapshot(
  state: SnapshotCacheEntry,
): ResourceActionSnapshot | undefined {
  switch (state.status) {
    case "Ready":
    case "Reconciling":
      return state.snapshot;
    case "Error":
      return state.lastGoodSnapshot;
    case "Loading":
      return undefined;
  }
}

function resolvingState(
  snapshot: ResourceActionSnapshot | undefined,
): SnapshotCacheEntry {
  return snapshot === undefined
    ? { status: "Loading" }
    : { status: "Reconciling", snapshot };
}

function validateOrderedResponse(
  refs: readonly CanonicalResourceRef[],
  snapshots: readonly ResourceActionSnapshot[],
): void {
  if (snapshots.length !== refs.length) {
    throw new SnapshotResolveContractDefect(
      `Snapshot resolve returned ${snapshots.length} snapshots for ${refs.length} refs`,
    );
  }
  refs.forEach((ref, index) => {
    if (snapshots[index]?.ref !== ref) {
      throw new SnapshotResolveContractDefect(
        `Snapshot resolve response is not ordered at index ${index}: expected ${ref}`,
      );
    }
  });
}

export function createResourceActionSnapshotCache(deps: {
  readonly resolve: ResolveSnapshots;
  readonly schedule: ScheduleFlush;
}): ResourceActionSnapshotCache {
  const entries = new Map<CanonicalResourceRef, RetainedEntry>();
  const pendingFirstResolve = new Set<CanonicalResourceRef>();
  const listeners = new Set<() => void>();
  let flushScheduled = false;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const maybeEvict = (
    ref: CanonicalResourceRef,
    entry: RetainedEntry,
  ): void => {
    if (entry.retainCount !== 0 || entry.inFlightCount !== 0) return;
    if (entries.get(ref) === entry) entries.delete(ref);
  };

  async function resolveRefs(
    refs: readonly CanonicalResourceRef[],
  ): Promise<void> {
    const requests: ResolveRequest[] = [];
    for (const ref of refs) {
      const entry = entries.get(ref);
      if (!entry || entry.retainCount === 0) continue;
      const previous = lastGoodSnapshot(entry.state);
      const previousState = entry.state;
      entry.generation += 1;
      entry.inFlightCount += 1;
      // A failed post-mutation read means `previous` may contain the stale
      // inverse verb. Keep the public entry in Error for every retrying reader;
      // changing it to Reconciling would briefly re-enable that stale command.
      entry.state =
        previousState.status === "Error"
          ? { ...previousState, retrying: true }
          : resolvingState(previous);
      requests.push({
        ref,
        entry,
        generation: entry.generation,
        ...(previous === undefined ? {} : { lastGoodSnapshot: previous }),
      });
    }
    if (requests.length === 0) return;
    notify();

    const requestedRefs = requests.map(({ ref }) => ref);
    const installFailure = (error: unknown): void => {
      for (const request of requests) {
        if (
          entries.get(request.ref) !== request.entry ||
          request.entry.generation !== request.generation
        ) {
          continue;
        }
        request.entry.state =
          request.lastGoodSnapshot === undefined
            ? { status: "Error", error }
            : {
                status: "Error",
                error,
                lastGoodSnapshot: request.lastGoodSnapshot,
              };
      }
    };
    try {
      let snapshots: readonly ResourceActionSnapshot[];
      try {
        snapshots = await deps.resolve(requestedRefs);
      } catch (error) {
        installFailure(error);
        // Strict decoders and normalized ApiErrors share one same-system defect
        // taxonomy. Preserve public Error/Retry state, but also reject so the
        // runtime raises contract drift instead of presenting an endlessly
        // retryable transport failure.
        if (
          error instanceof TypeError ||
          error instanceof SyntaxError ||
          isSameSystemApiDefect(error)
        ) {
          throw error;
        }
        return;
      }

      try {
        validateOrderedResponse(requestedRefs, snapshots);
      } catch (error) {
        // justify-defect: an ordered same-cardinality response is the cache's
        // foundational identity contract. Preserve a retryable public state,
        // but still reject so a malformed same-system response cannot look
        // like an ordinary successful refresh to its caller.
        installFailure(error);
        throw error;
      }
      requests.forEach((request, index) => {
        if (
          entries.get(request.ref) !== request.entry ||
          request.entry.generation !== request.generation
        ) {
          return;
        }
        request.entry.state = {
          status: "Ready",
          snapshot: snapshots[index]!,
        };
      });
    } finally {
      for (const request of requests) {
        request.entry.inFlightCount -= 1;
        maybeEvict(request.ref, request.entry);
      }
      notify();
    }
  }

  function flush(): Promise<void> {
    flushScheduled = false;
    const refs = [...pendingFirstResolve];
    pendingFirstResolve.clear();
    return resolveRefs(refs);
  }

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    deps.schedule(flush);
  }

  function reconcileRefs(refs: readonly CanonicalResourceRef[]): Promise<void> {
    const uniqueRefs = [...new Set(refs)].filter((ref) => {
      const entry = entries.get(ref);
      return entry !== undefined && entry.retainCount > 0;
    });
    if (uniqueRefs.length === 0) return Promise.resolve();

    const preceding = [
      ...new Set(
        uniqueRefs.flatMap((ref) => {
          const tail = entries.get(ref)?.reconciliationTail;
          return tail === undefined ? [] : [tail];
        }),
      ),
    ];
    const operation =
      preceding.length === 0
        ? resolveRefs(uniqueRefs)
        : Promise.all(
            preceding.map((tail) => tail.catch(() => undefined)),
          ).then(() => resolveRefs(uniqueRefs));

    // Install the shared tail synchronously. A second reconciliation started
    // in this same turn therefore waits instead of racing the first request.
    for (const ref of uniqueRefs) {
      const entry = entries.get(ref);
      if (entry !== undefined && entry.retainCount > 0) {
        entry.reconciliationTail = operation;
      }
    }
    const clearTail = (): void => {
      for (const ref of uniqueRefs) {
        const entry = entries.get(ref);
        if (entry?.reconciliationTail === operation) {
          entry.reconciliationTail = undefined;
        }
      }
    };
    // Observe both terminal paths without creating an unhandled rejecting
    // promise. The original operation remains the caller's error channel.
    void operation.then(clearTail, clearTail);
    return operation;
  }

  return {
    retain(ref) {
      let entry = entries.get(ref);
      if (entry) {
        entry.retainCount += 1;
      } else {
        entry = {
          retainCount: 1,
          generation: 0,
          inFlightCount: 0,
          state: { status: "Loading" },
        };
        entries.set(ref, entry);
        pendingFirstResolve.add(ref);
        scheduleFlush();
      }
      notify();

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const current = entries.get(ref);
        if (current !== entry) return;
        current.retainCount -= 1;
        if (current.retainCount === 0 && current.inFlightCount === 0) {
          pendingFirstResolve.delete(ref);
          entries.delete(ref);
        }
        notify();
      };
    },
    peek(ref) {
      return entries.get(ref)?.state;
    },
    retry(ref) {
      const entry = entries.get(ref);
      if (!entry || entry.retainCount === 0) {
        return Promise.reject(
          new Error(
            `Cannot retry an unretained resource action subject: ${ref}`,
          ),
        );
      }
      if (entry.retryPromise) return entry.retryPromise;
      if (entry.state.status !== "Error") {
        return Promise.reject(
          new Error(
            `Cannot retry resource action snapshot in ${entry.state.status}`,
          ),
        );
      }
      const retryPromise = resolveRefs([ref]);
      entry.retryPromise = retryPromise;
      const clearRetryPromise = () => {
        if (entry.retryPromise === retryPromise) {
          entry.retryPromise = undefined;
        }
      };
      // Observe both terminal paths without creating a second rejecting promise.
      void retryPromise.then(clearRetryPromise, clearRetryPromise);
      return retryPromise;
    },
    reconcile(scope) {
      switch (scope.kind) {
        case "None":
          return Promise.resolve();
        case "Subjects":
          return reconcileRefs(scope.refs);
        case "AllRetained":
          return reconcileRefs(
            [...entries.entries()]
              .filter(([, entry]) => entry.retainCount > 0)
              .map(([ref]) => ref),
          );
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
