import type { ResourceActionReconciliationScope } from "@/lib/actions/resourceActionSnapshotCache";

/**
 * One active write opened from a canonical resource action overlay.
 *
 * The owning editor performs the domain command, `reconcile` crosses the
 * canonical action-snapshot boundary, and `commit` releases the global action
 * busy state only after that reconciliation has completed. `abort` is the
 * terminal path for cancellation or a command failure.
 */
export interface ResourceActionMutationLease {
  readonly reconcile: (
    scope: ResourceActionReconciliationScope,
  ) => Promise<void>;
  readonly commit: () => Promise<void>;
  readonly abort: () => void;
}

export interface ResourceActionMutationBoundary {
  /** Returns no lease when this exact resource action is already busy. */
  readonly begin: () => ResourceActionMutationLease | null;
  /** Used by the owning controller to reject close/replacement while settling. */
  readonly isActive: () => boolean;
}

/**
 * Resource-action-specific mutation state machine. The app runtime supplies
 * the exact `(ref, actionId)` busy-key operations and its retained snapshot
 * cache; overlay controllers receive only the narrow begin/isActive contract.
 */
export function createResourceActionMutationBoundary(input: {
  readonly isGloballyBusy: () => boolean;
  readonly markGloballyBusy: () => void;
  readonly clearGloballyBusy: () => void;
  readonly reconcile: (
    scope: ResourceActionReconciliationScope,
  ) => Promise<void>;
}): ResourceActionMutationBoundary {
  let activeLease: ResourceActionMutationLease | null = null;

  return {
    begin() {
      if (activeLease !== null || input.isGloballyBusy()) return null;

      let terminal = false;
      let pendingReconciliation: Promise<void> | null = null;
      let hasReconciled = false;

      const finish = (): void => {
        if (terminal) return;
        terminal = true;
        if (activeLease === lease) activeLease = null;
        input.clearGloballyBusy();
      };

      const lease: ResourceActionMutationLease = {
        async reconcile(scope) {
          if (terminal) {
            // justify-defect: a settled lease cannot own a later canonical
            // reconciliation; its caller retained a stale mutation handle.
            throw new Error("Cannot reconcile a settled resource action mutation");
          }
          if (pendingReconciliation !== null) {
            // justify-defect: one overlay command owns one ordered snapshot
            // barrier at a time. Starting another concurrently would make its
            // terminal busy boundary ambiguous.
            throw new Error(
              "Resource action mutation reconciliation is already running",
            );
          }
          let pending: Promise<void>;
          try {
            pending = input.reconcile(scope);
          } catch (error) {
            finish();
            throw error;
          }
          pendingReconciliation = pending;
          try {
            await pending;
            hasReconciled = true;
          } catch (error) {
            finish();
            throw error;
          } finally {
            if (pendingReconciliation === pending) {
              pendingReconciliation = null;
            }
          }
        },
        async commit() {
          if (terminal) {
            // justify-defect: commit is a one-shot terminal transition.
            throw new Error("Resource action mutation already settled");
          }
          if (!hasReconciled && pendingReconciliation === null) {
            // justify-defect: releasing Busy before the typed snapshot barrier
            // completes could re-enable a stale inverse action.
            throw new Error(
              "Resource action mutation committed before reconciliation",
            );
          }
          if (pendingReconciliation !== null) {
            await pendingReconciliation;
          }
          finish();
        },
        abort: finish,
      };
      activeLease = lease;
      try {
        input.markGloballyBusy();
      } catch (error) {
        // Marking and local ownership are one acquisition transition. If a
        // store listener defects synchronously, leave neither half acquired.
        finish();
        throw error;
      }
      return lease;
    },
    isActive: () => activeLease !== null,
  };
}
