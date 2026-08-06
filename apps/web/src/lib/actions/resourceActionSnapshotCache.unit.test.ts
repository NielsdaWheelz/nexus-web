import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/client";
import {
  createResourceActionSnapshotCache,
  type ResolveSnapshots,
  type ResourceActionSnapshotCache,
} from "@/lib/actions/resourceActionSnapshotCache";
import type { ResourceActionSnapshot } from "@/lib/actions/resourceActionSnapshot";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

// Product oracle: canonical-resource-action-menu-hard-cutover.md, "Runtime and
// UI Rules". The cache is a retained public state machine; these tests exercise
// that public contract without inspecting cache internals.

function refOf(n: number): CanonicalResourceRef {
  return assumeCanonicalResourceRef(
    `media:0000000${n}-0000-4000-8000-000000000000`,
  );
}

function snapshotOf(
  ref: CanonicalResourceRef,
  revision: string,
  capabilities: ResourceActionSnapshot["capabilities"] = [],
): ResourceActionSnapshot {
  return {
    ref,
    activation: {
      resourceRef: ref,
      kind: "route",
      href: `/media/${ref.slice("media:".length)}`,
      unresolvedReason: null,
    },
    missing: false,
    factsRevision: revision,
    capabilities,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function manualScheduler() {
  const pending: Array<() => void | Promise<void>> = [];
  return {
    schedule: (flush: () => void | Promise<void>) => {
      pending.push(flush);
    },
    pendingCount: () => pending.length,
    runNext(): Promise<void> {
      const flush = pending.shift();
      if (!flush) throw new Error("No scheduled cache flush");
      return Promise.resolve(flush());
    },
  };
}

function createRecordedCache(implementation: ResolveSnapshots): {
  readonly cache: ResourceActionSnapshotCache;
  readonly scheduler: ReturnType<typeof manualScheduler>;
  readonly calls: CanonicalResourceRef[][];
} {
  const calls: CanonicalResourceRef[][] = [];
  const scheduler = manualScheduler();
  const resolve: ResolveSnapshots = (refs) => {
    calls.push([...refs]);
    return implementation(refs);
  };
  return {
    cache: createResourceActionSnapshotCache({
      resolve,
      schedule: scheduler.schedule,
    }),
    scheduler,
    calls,
  };
}

describe("resource action snapshot cache retention and batching", () => {
  it("deduplicates retained refs in one tick and reading a ready entry performs no request", async () => {
    const a = refOf(1);
    const b = refOf(2);
    const { cache, scheduler, calls } = createRecordedCache((refs) =>
      Promise.resolve(refs.map((ref) => snapshotOf(ref, "rev:initial"))),
    );

    const releaseAFirst = cache.retain(a);
    const releaseB = cache.retain(b);
    const releaseASecond = cache.retain(a);

    expect(cache.peek(a)).toEqual({ status: "Loading" });
    expect(cache.peek(b)).toEqual({ status: "Loading" });
    expect(calls).toEqual([]);
    expect(scheduler.pendingCount()).toBe(1);

    await scheduler.runNext();

    expect(calls).toEqual([[a, b]]);
    expect(cache.peek(a)).toEqual({
      status: "Ready",
      snapshot: snapshotOf(a, "rev:initial"),
    });

    // A menu/model read consumes the already-retained snapshot. Only retaining
    // a previously absent subject may schedule transport work.
    cache.peek(a);
    cache.peek(a);
    expect(calls).toEqual([[a, b]]);

    releaseAFirst();
    expect(cache.peek(a)?.status).toBe("Ready");
    releaseASecond();
    expect(cache.peek(a)).toBeUndefined();
    releaseB();
    expect(cache.peek(b)).toBeUndefined();
  });

  it("evicts an unretained ref only after its in-flight first resolve settles", async () => {
    const a = refOf(1);
    const first = deferred<readonly ResourceActionSnapshot[]>();
    const { cache, scheduler } = createRecordedCache(() => first.promise);

    const release = cache.retain(a);
    const settling = scheduler.runNext();
    release();

    expect(cache.peek(a)).toEqual({ status: "Loading" });

    first.resolve([snapshotOf(a, "rev:settled")]);
    await settling;

    expect(cache.peek(a)).toBeUndefined();
  });
});

describe("resource action snapshot cache strict resolve contract", () => {
  it("defects instead of reordering a response or synthesizing a missing snapshot", async () => {
    const a = refOf(1);
    const b = refOf(2);

    for (const response of [
      [snapshotOf(b, "rev:b"), snapshotOf(a, "rev:a")],
      [snapshotOf(a, "rev:a")],
    ]) {
      const { cache, scheduler } = createRecordedCache(() =>
        Promise.resolve(response),
      );
      cache.retain(a);
      cache.retain(b);

      await expect(scheduler.runNext()).rejects.toThrow();

      expect(cache.peek(a)).toEqual({
        status: "Error",
        error: expect.any(Error),
      });
      expect(cache.peek(b)).toEqual({
        status: "Error",
        error: expect.any(Error),
      });
    }
  });

  it("surfaces strict decoder defects while retaining an explicit Error state", async () => {
    const a = refOf(1);
    const defect = new TypeError("snapshot wire drift");
    const { cache, scheduler } = createRecordedCache(() =>
      Promise.reject(defect),
    );
    cache.retain(a);

    await expect(scheduler.runNext()).rejects.toBe(defect);
    expect(cache.peek(a)).toEqual({ status: "Error", error: defect });
  });

  it.each(["E_INVALID_RESPONSE", "E_UNKNOWN", "E_INTERNAL"])(
    "surfaces the %s same-system API defect while retaining Error state",
    async (code) => {
      const a = refOf(1);
      const defect = new ApiError(500, code, "snapshot boundary defect");
      const { cache, scheduler } = createRecordedCache(() =>
        Promise.reject(defect),
      );
      cache.retain(a);

      await expect(scheduler.runNext()).rejects.toBe(defect);
      expect(cache.peek(a)).toEqual({ status: "Error", error: defect });
    },
  );

  it("keeps a modeled API transport failure retryable", async () => {
    const a = refOf(1);
    const failure = new ApiError(503, "E_NETWORK", "snapshot unavailable");
    const { cache, scheduler } = createRecordedCache(() =>
      Promise.reject(failure),
    );
    cache.retain(a);

    await expect(scheduler.runNext()).resolves.toBeUndefined();
    expect(cache.peek(a)).toEqual({ status: "Error", error: failure });
  });
});

describe("resource action snapshot cache failure and Retry", () => {
  it("models an initial resolve failure and retries the same retained subject", async () => {
    const a = refOf(1);
    const failure = new Error("snapshot transport failed");
    let attempt = 0;
    const { cache, scheduler, calls } = createRecordedCache((refs) => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(failure)
        : Promise.resolve(refs.map((ref) => snapshotOf(ref, "rev:retry")));
    });

    cache.retain(a);
    await scheduler.runNext();

    expect(cache.peek(a)).toEqual({ status: "Error", error: failure });

    const retrying = cache.retry(a);
    expect(cache.peek(a)).toEqual({
      status: "Error",
      error: failure,
      retrying: true,
    });
    await retrying;

    expect(calls).toEqual([[a], [a]]);
    expect(cache.peek(a)).toEqual({
      status: "Ready",
      snapshot: snapshotOf(a, "rev:retry"),
    });
  });
});

describe("resource action snapshot cache typed reconciliation", () => {
  it("awaits Subjects, treats None as request-free, and bounds AllRetained to live refs", async () => {
    const a = refOf(1);
    const b = refOf(2);
    const reconciliation = deferred<readonly ResourceActionSnapshot[]>();
    let requestNumber = 0;
    const { cache, scheduler, calls } = createRecordedCache((refs) => {
      requestNumber += 1;
      if (requestNumber === 1) {
        return Promise.resolve(refs.map((ref) => snapshotOf(ref, "rev:0")));
      }
      if (requestNumber === 2) return reconciliation.promise;
      return Promise.resolve(refs.map((ref) => snapshotOf(ref, "rev:2")));
    });

    const releaseA = cache.retain(a);
    const releaseB = cache.retain(b);
    await scheduler.runNext();

    await cache.reconcile({ kind: "None" });
    expect(calls).toEqual([[a, b]]);

    let settled = false;
    const reconciling = cache
      .reconcile({ kind: "Subjects", refs: [a, a] })
      .then(() => {
        settled = true;
      });

    expect(cache.peek(a)).toEqual({
      status: "Reconciling",
      snapshot: snapshotOf(a, "rev:0"),
    });
    expect(cache.peek(b)?.status).toBe("Ready");
    expect(settled).toBe(false);

    reconciliation.resolve([snapshotOf(a, "rev:1")]);
    await reconciling;

    expect(settled).toBe(true);
    expect(calls[1]).toEqual([a]);
    expect(cache.peek(a)).toEqual({
      status: "Ready",
      snapshot: snapshotOf(a, "rev:1"),
    });

    releaseB();
    await cache.reconcile({ kind: "AllRetained" });
    expect(calls[2]).toEqual([a]);
    expect(cache.peek(b)).toBeUndefined();

    releaseA();
  });

  it("keeps a failed reconciliation out of Ready until Retry installs authoritative facts", async () => {
    const a = refOf(1);
    const failure = new Error("reconciliation failed");
    let requestNumber = 0;
    const retried = deferred<readonly ResourceActionSnapshot[]>();
    const absent = snapshotOf(a, "rev:absent", [
      {
        kind: "LecternMembership",
        availability: { kind: "Available" },
        state: "Absent",
      },
    ]);
    const present = snapshotOf(a, "rev:present", [
      {
        kind: "LecternMembership",
        availability: { kind: "Available" },
        state: "Present",
        lecternItemId: "33333333-3333-4333-8333-333333333333",
      },
    ]);
    const { cache, scheduler } = createRecordedCache(() => {
      requestNumber += 1;
      if (requestNumber === 1) return Promise.resolve([absent]);
      if (requestNumber === 2) return Promise.reject(failure);
      return retried.promise;
    });

    cache.retain(a);
    await scheduler.runNext();
    await cache.reconcile({ kind: "Subjects", refs: [a] });

    expect(cache.peek(a)).toEqual({
      status: "Error",
      error: failure,
      lastGoodSnapshot: absent,
    });

    const retrying = cache.retry(a);
    const sameRetry = cache.retry(a);
    expect(sameRetry).toBe(retrying);
    expect(cache.peek(a)).toEqual({
      status: "Error",
      error: failure,
      lastGoodSnapshot: absent,
      retrying: true,
    });

    retried.resolve([present]);
    await retrying;

    expect(cache.peek(a)).toEqual({ status: "Ready", snapshot: present });
  });

  it("keeps Retry available after another retryable resolve failure", async () => {
    const a = refOf(1);
    const firstFailure = new Error("initial snapshot failure");
    const retryFailure = new Error("retry snapshot failure");
    let requestNumber = 0;
    const { cache, scheduler, calls } = createRecordedCache((refs) => {
      requestNumber += 1;
      if (requestNumber === 1) return Promise.reject(firstFailure);
      if (requestNumber === 2) return Promise.reject(retryFailure);
      return Promise.resolve(
        refs.map((ref) => snapshotOf(ref, "rev:recovered")),
      );
    });

    cache.retain(a);
    await scheduler.runNext();
    await cache.retry(a);

    expect(cache.peek(a)).toEqual({
      status: "Error",
      error: retryFailure,
    });

    await cache.retry(a);
    expect(calls).toEqual([[a], [a], [a]]);
    expect(cache.peek(a)).toEqual({
      status: "Ready",
      snapshot: snapshotOf(a, "rev:recovered"),
    });
  });
});

describe("resource action snapshot cache reconciliation ordering", () => {
  it("serializes overlapping refs so every caller installs an authoritative read before settling", async () => {
    const a = refOf(1);
    const slow = deferred<readonly ResourceActionSnapshot[]>();
    const fast = deferred<readonly ResourceActionSnapshot[]>();
    let requestNumber = 0;
    const { cache, scheduler } = createRecordedCache(() => {
      requestNumber += 1;
      if (requestNumber === 1) {
        return Promise.resolve([snapshotOf(a, "rev:0")]);
      }
      return requestNumber === 2 ? slow.promise : fast.promise;
    });

    cache.retain(a);
    await scheduler.runNext();

    const older = cache.reconcile({ kind: "Subjects", refs: [a] });
    const newer = cache.reconcile({ kind: "Subjects", refs: [a] });

    // The second request does not start while the same ref's first mutation
    // barrier is unresolved. This keeps the first action busy until rev:1 is
    // authoritative instead of ignoring its response as stale.
    expect(requestNumber).toBe(2);
    slow.resolve([snapshotOf(a, "rev:1")]);
    await older;
    expect(cache.peek(a)).toEqual({
      status: "Ready",
      snapshot: snapshotOf(a, "rev:1"),
    });

    fast.resolve([snapshotOf(a, "rev:2")]);
    await newer;
    expect(requestNumber).toBe(3);
    expect(cache.peek(a)).toEqual({
      status: "Ready",
      snapshot: snapshotOf(a, "rev:2"),
    });
  });

  it("does not serialize reconciliations for unrelated retained refs", async () => {
    const a = refOf(1);
    const b = refOf(2);
    const aRead = deferred<readonly ResourceActionSnapshot[]>();
    const bRead = deferred<readonly ResourceActionSnapshot[]>();
    let requestNumber = 0;
    const { cache, scheduler } = createRecordedCache((refs) => {
      requestNumber += 1;
      if (requestNumber === 1) {
        return Promise.resolve(refs.map((ref) => snapshotOf(ref, "rev:0")));
      }
      return refs[0] === a ? aRead.promise : bRead.promise;
    });

    cache.retain(a);
    cache.retain(b);
    await scheduler.runNext();

    const reconcilingA = cache.reconcile({ kind: "Subjects", refs: [a] });
    const reconcilingB = cache.reconcile({ kind: "Subjects", refs: [b] });
    await Promise.resolve();
    expect(requestNumber).toBe(3);

    bRead.resolve([snapshotOf(b, "rev:b")]);
    await reconcilingB;
    expect(cache.peek(b)).toEqual({
      status: "Ready",
      snapshot: snapshotOf(b, "rev:b"),
    });
    expect(cache.peek(a)?.status).toBe("Reconciling");

    aRead.resolve([snapshotOf(a, "rev:a")]);
    await reconcilingA;
  });
});
