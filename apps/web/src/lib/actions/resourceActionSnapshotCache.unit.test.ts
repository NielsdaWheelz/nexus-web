import { describe, expect, it, vi } from "vitest";

import {
  createResourceActionSnapshotCache,
  type ResolveSnapshots,
} from "@/lib/actions/resourceActionSnapshotCache";
import type { ResourceActionSnapshot } from "@/lib/actions/resourceActionSnapshot";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

// Independent oracle: the spec's "Opening a menu performs no network request.
// Standing surfaces prefetch their snapshots in a deduplicated batch" contract
// (canonical-resource-action-menu-hard-cutover.md) + DESIGN_CONTRACT.md "Wave 3
// runtime design": register a ref -> coalesce every pending ref within one tick
// into ONE resolve call carrying the unique refs, distribute by ref, and never
// refetch an already-cached ref. Each expectation restates that contract by hand
// against an injected resolver + a manual scheduler; nothing reads the cache's
// internal batching machinery.

function refOf(n: number): CanonicalResourceRef {
  return assumeCanonicalResourceRef(
    `media:0000000${n}-0000-4000-8000-000000000000`,
  );
}

function readySnapshotOf(ref: CanonicalResourceRef): ResourceActionSnapshot {
  return {
    ref,
    activation: {
      resourceRef: ref,
      kind: "route",
      href: `/media/${ref}`,
      unresolvedReason: null,
    },
    missing: false,
    factsRevision: `rev:${ref}`,
    capabilities: [],
  };
}

/**
 * A manual scheduler: it captures the pending flush so a test can run it after
 * registering N refs (mirroring a microtask that fires once at end-of-tick), and
 * returns the flush's promise so the async resolve settles deterministically.
 */
function manualScheduler() {
  let pending: (() => void | Promise<void>) | null = null;
  return {
    schedule: (flush: () => void | Promise<void>) => {
      pending = flush;
    },
    isScheduled: () => pending !== null,
    async runTick(): Promise<void> {
      const flush = pending;
      pending = null;
      if (flush) await flush();
    },
  };
}

describe("createResourceActionSnapshotCache batch coalescing", () => {
  it("coalesces every ref registered within one tick into ONE deduplicated resolve call", async () => {
    const a = refOf(1);
    const b = refOf(2);
    const resolve = vi.fn<ResolveSnapshots>((refs) =>
      Promise.resolve(refs.map(readySnapshotOf)),
    );
    const scheduler = manualScheduler();
    const cache = createResourceActionSnapshotCache({
      resolve,
      schedule: scheduler.schedule,
    });

    cache.register(a);
    cache.register(b);
    cache.register(a); // duplicate registration within the same tick

    // Zero network before the tick flushes: opening a menu never fetches.
    expect(resolve).not.toHaveBeenCalled();
    expect(cache.peek(a)).toEqual({ status: "pending" });

    await scheduler.runTick();

    // Exactly one batch call carrying both unique refs, `a` deduplicated.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toEqual([a, b]);

    // Snapshots distributed back per ref.
    expect(cache.peek(a)).toEqual({
      status: "ready",
      snapshot: readySnapshotOf(a),
    });
    expect(cache.peek(b)).toEqual({
      status: "ready",
      snapshot: readySnapshotOf(b),
    });
  });

  it("never refetches an already-cached ref; only newly-registered refs form the next batch", async () => {
    const a = refOf(1);
    const c = refOf(3);
    const resolve = vi.fn<ResolveSnapshots>((refs) =>
      Promise.resolve(refs.map(readySnapshotOf)),
    );
    const scheduler = manualScheduler();
    const cache = createResourceActionSnapshotCache({
      resolve,
      schedule: scheduler.schedule,
    });

    cache.register(a);
    await scheduler.runTick();
    expect(resolve).toHaveBeenCalledTimes(1);

    // Re-registering the cached ref schedules nothing and issues no fetch.
    cache.register(a);
    expect(scheduler.isScheduled()).toBe(false);

    // A brand-new ref forms the next batch, excluding the cached one.
    cache.register(c);
    expect(scheduler.isScheduled()).toBe(true);
    await scheduler.runTick();

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[1]?.[0]).toEqual([c]);
  });

  it("synthesizes a missing snapshot for a requested ref absent from the response", async () => {
    const a = refOf(1);
    const b = refOf(2);
    // The resolver omits `b` entirely.
    const resolve = vi.fn<ResolveSnapshots>(() =>
      Promise.resolve([readySnapshotOf(a)]),
    );
    const scheduler = manualScheduler();
    const cache = createResourceActionSnapshotCache({
      resolve,
      schedule: scheduler.schedule,
    });

    cache.register(a);
    cache.register(b);
    await scheduler.runTick();

    const entryB = cache.peek(b);
    expect(entryB?.status).toBe("ready");
    if (entryB?.status === "ready") {
      expect(entryB.snapshot.missing).toBe(true);
      expect(entryB.snapshot.capabilities).toEqual([]);
      expect(entryB.snapshot.ref).toBe(b);
    }
  });

  it("reresolve refetches given refs and overwrites their entries", async () => {
    const a = refOf(1);
    let revision = 0;
    const resolve = vi.fn<ResolveSnapshots>((refs) =>
      Promise.resolve(
        refs.map((ref) => ({ ...readySnapshotOf(ref), factsRevision: `rev:${revision}` })),
      ),
    );
    const scheduler = manualScheduler();
    const cache = createResourceActionSnapshotCache({
      resolve,
      schedule: scheduler.schedule,
    });

    cache.register(a);
    await scheduler.runTick();
    const before = cache.peek(a);
    expect(before?.status === "ready" && before.snapshot.factsRevision).toBe("rev:0");

    revision = 1;
    await cache.reresolve([a, a]); // duplicates coalesced
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[1]?.[0]).toEqual([a]);
    const after = cache.peek(a);
    expect(after?.status === "ready" && after.snapshot.factsRevision).toBe("rev:1");
  });

  it("reresolveAll refetches every known ref in one batch (cross-representation AC7 reconcile)", async () => {
    const a = refOf(1);
    const b = refOf(2);
    let revision = 0;
    const resolve = vi.fn<ResolveSnapshots>((refs) =>
      Promise.resolve(
        refs.map((ref) => ({ ...readySnapshotOf(ref), factsRevision: `rev:${revision}` })),
      ),
    );
    const scheduler = manualScheduler();
    const cache = createResourceActionSnapshotCache({
      resolve,
      schedule: scheduler.schedule,
    });

    cache.register(a);
    cache.register(b);
    await scheduler.runTick();
    expect(resolve).toHaveBeenCalledTimes(1);

    // A mutation elsewhere can change a related ref; reresolveAll re-fetches the
    // whole cache in one batch so every mounted representation reconciles.
    revision = 1;
    await cache.reresolveAll();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(new Set(resolve.mock.calls[1]?.[0])).toEqual(new Set([a, b]));
    for (const ref of [a, b]) {
      const entry = cache.peek(ref);
      expect(entry?.status === "ready" && entry.snapshot.factsRevision).toBe("rev:1");
    }
  });

  it("errors an initial load but preserves a ready snapshot across a failed reconcile", async () => {
    const a = refOf(1);
    const b = refOf(2);
    const failure = new Error("resolve failed");
    let mode: "ok" | "fail" = "fail";
    const resolve = vi.fn<ResolveSnapshots>((refs) =>
      mode === "fail"
        ? Promise.reject(failure)
        : Promise.resolve(refs.map(readySnapshotOf)),
    );
    const scheduler = manualScheduler();
    const cache = createResourceActionSnapshotCache({
      resolve,
      schedule: scheduler.schedule,
    });

    // Initial load fails -> error entry (trigger stays unavailable).
    cache.register(a);
    await scheduler.runTick();
    expect(cache.peek(a)).toEqual({ status: "error", error: failure });

    // A ready ref then a failing reconcile keeps the good snapshot.
    mode = "ok";
    cache.register(b);
    await scheduler.runTick();
    expect(cache.peek(b)?.status).toBe("ready");

    mode = "fail";
    await cache.reresolve([b]);
    expect(cache.peek(b)?.status).toBe("ready");
  });
});
