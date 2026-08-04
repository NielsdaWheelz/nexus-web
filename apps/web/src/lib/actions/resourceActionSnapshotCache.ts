import type { ResourceActivation } from "@/lib/resources/activation";
import type { ResourceActionSnapshot } from "@/lib/actions/resourceActionSnapshot";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

// The deduplicated batch snapshot cache. It is the runtime's "zero network on
// menu open" owner: surfaces REGISTER the canonical refs they may act on, the
// cache coalesces every not-yet-cached ref registered within one scheduling
// tick into ONE resolve call, and distributes the snapshots back per ref. The
// menu trigger stays unavailable until the ref's snapshot is `ready`, so opening
// the menu never fetches.
//
// This module is framework-free and dependency-injected (`resolve` + `schedule`)
// so the batch-coalescing contract is unit-testable without a DOM.

export type SnapshotCacheEntry =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly snapshot: ResourceActionSnapshot }
  | { readonly status: "error"; readonly error: unknown };

/** Fetch one snapshot per requested ref (response order is not relied upon). */
export type ResolveSnapshots = (
  refs: readonly CanonicalResourceRef[],
) => Promise<readonly ResourceActionSnapshot[]>;

/**
 * Defer a flush to the end of the current tick. Production passes a microtask
 * scheduler so synchronous registrations coalesce; a test passes a manual
 * scheduler to flush deterministically. The flush may return a promise so a test
 * can await the batch settling.
 */
export type ScheduleFlush = (flush: () => void | Promise<void>) => void;

export interface ResourceActionSnapshotCache {
  /** Track `ref` for prefetch. A ref already known is a no-op — never refetched. */
  register(ref: CanonicalResourceRef): void;
  /** Current cache state for `ref` (stable object identity until it changes). */
  peek(ref: CanonicalResourceRef): SnapshotCacheEntry | undefined;
  /**
   * Force a fresh resolve of `refs` and overwrite their entries (post-mutation
   * reconciliation). The returned promise settles when the entries are updated.
   */
  reresolve(refs: readonly CanonicalResourceRef[]): Promise<void>;
  /**
   * Force a fresh resolve of EVERY known ref. A mutation can change a related
   * resource's snapshot (Unsubscribe changes episode refs, DeleteLibrary changes
   * contained media's LibraryPlacement), so post-mutation reconciliation
   * re-resolves the whole cache in one batch — every simultaneously-mounted
   * representation then agrees (AC7).
   */
  reresolveAll(): Promise<void>;
  /** Subscribe to any entry change (for `useSyncExternalStore`). */
  subscribe(listener: () => void): () => void;
}

const PENDING: SnapshotCacheEntry = { status: "pending" };

/**
 * A missing snapshot the cache synthesizes only when a requested ref is absent
 * from the resolve response. The endpoint already returns an explicit missing
 * snapshot per missing resource, so this is a defensive total-coverage fallback
 * that keeps every registered ref resolvable (the planner returns an empty plan
 * for a missing snapshot).
 */
function missingSnapshot(ref: CanonicalResourceRef): ResourceActionSnapshot {
  const activation: ResourceActivation = {
    resourceRef: ref,
    kind: "none",
    href: null,
    unresolvedReason: null,
  };
  return { ref, activation, missing: true, factsRevision: "", capabilities: [] };
}

export function createResourceActionSnapshotCache(deps: {
  readonly resolve: ResolveSnapshots;
  readonly schedule: ScheduleFlush;
}): ResourceActionSnapshotCache {
  const entries = new Map<CanonicalResourceRef, SnapshotCacheEntry>();
  const pendingBatch = new Set<CanonicalResourceRef>();
  const listeners = new Set<() => void>();
  let flushScheduled = false;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function distribute(
    refs: readonly CanonicalResourceRef[],
    snapshots: readonly ResourceActionSnapshot[],
  ): void {
    const byRef = new Map<CanonicalResourceRef, ResourceActionSnapshot>(
      snapshots.map((snapshot) => [snapshot.ref, snapshot]),
    );
    for (const ref of refs) {
      const snapshot = byRef.get(ref) ?? missingSnapshot(ref);
      entries.set(ref, { status: "ready", snapshot });
    }
  }

  async function fetchInto(refs: readonly CanonicalResourceRef[]): Promise<void> {
    if (refs.length === 0) return;
    try {
      distribute(refs, await deps.resolve(refs));
    } catch (error) {
      // A failed reconcile must not clobber a good snapshot; only initial loads
      // (entries still pending / absent) fall to an error the surface can show.
      for (const ref of refs) {
        const current = entries.get(ref);
        if (current === undefined || current.status === "pending") {
          entries.set(ref, { status: "error", error });
        }
      }
    }
    notify();
  }

  function flush(): Promise<void> {
    flushScheduled = false;
    if (pendingBatch.size === 0) return Promise.resolve();
    const refs = [...pendingBatch];
    pendingBatch.clear();
    return fetchInto(refs);
  }

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    deps.schedule(flush);
  }

  return {
    register(ref) {
      if (entries.has(ref)) return;
      entries.set(ref, PENDING);
      pendingBatch.add(ref);
      scheduleFlush();
      notify();
    },
    peek(ref) {
      return entries.get(ref);
    },
    reresolve(refs) {
      const unique = [...new Set(refs)];
      return fetchInto(unique);
    },
    reresolveAll() {
      return fetchInto([...entries.keys()]);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
