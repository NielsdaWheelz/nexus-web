import { describe, expect, it, vi } from "vitest";

import { createResourceActionMutationBoundary } from "@/lib/actions/resourceActionMutation";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("resource action overlay mutation boundary", () => {
  it("holds the exact action busy through the awaited snapshot barrier", async () => {
    const barrier = deferred();
    let globallyBusy = false;
    const markGloballyBusy = vi.fn(() => {
      globallyBusy = true;
    });
    const clearGloballyBusy = vi.fn(() => {
      globallyBusy = false;
    });
    const reconcile = vi.fn(() => barrier.promise);
    const boundary = createResourceActionMutationBoundary({
      isGloballyBusy: () => globallyBusy,
      markGloballyBusy,
      clearGloballyBusy,
      reconcile,
    });

    const lease = boundary.begin();
    expect(lease).not.toBeNull();
    expect(boundary.isActive()).toBe(true);
    expect(globallyBusy).toBe(true);
    expect(boundary.begin()).toBeNull();

    const reconciling = lease!.reconcile({
      kind: "Subjects",
      refs: [
        assumeCanonicalResourceRef(
          "media:11111111-1111-4111-8111-111111111111",
        ),
      ],
    });
    const committing = lease!.commit();
    await Promise.resolve();
    expect(boundary.isActive()).toBe(true);
    expect(clearGloballyBusy).not.toHaveBeenCalled();

    barrier.resolve();
    await reconciling;
    await committing;

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(markGloballyBusy).toHaveBeenCalledTimes(1);
    expect(clearGloballyBusy).toHaveBeenCalledTimes(1);
    expect(boundary.isActive()).toBe(false);
    expect(globallyBusy).toBe(false);
  });

  it("aborts idempotently and permits the next command", () => {
    let globallyBusy = false;
    const clearGloballyBusy = vi.fn(() => {
      globallyBusy = false;
    });
    const boundary = createResourceActionMutationBoundary({
      isGloballyBusy: () => globallyBusy,
      markGloballyBusy: () => {
        globallyBusy = true;
      },
      clearGloballyBusy,
      reconcile: async () => {},
    });

    const first = boundary.begin()!;
    first.abort();
    first.abort();

    expect(clearGloballyBusy).toHaveBeenCalledTimes(1);
    expect(boundary.isActive()).toBe(false);
    expect(boundary.begin()).not.toBeNull();
  });

  it("keeps close/replacement guarded across unknown settlement and owner-read retry", async () => {
    let globallyBusy = false;
    const boundary = createResourceActionMutationBoundary({
      isGloballyBusy: () => globallyBusy,
      markGloballyBusy: () => {
        globallyBusy = true;
      },
      clearGloballyBusy: () => {
        globallyBusy = false;
      },
      reconcile: async () => {},
    });
    const lease = boundary.begin()!;

    // A delivery-unknown command deliberately does not abort. The owning
    // overlay therefore remains mounted and is the only place that can offer
    // its authoritative observation/retry flow.
    expect(boundary.isActive(), "close/replacement guard was released").toBe(
      true,
    );
    await lease.reconcile({ kind: "AllRetained" });

    // A later owner read may still fail transiently after snapshots reconcile;
    // Busy remains exact and active until that read is retried successfully.
    expect(
      boundary.isActive(),
      "owner-read failure released Busy before an authoritative retry",
    ).toBe(true);
    await lease.commit();
    expect(boundary.isActive()).toBe(false);
    expect(globallyBusy).toBe(false);
  });

  it("permits sequential barriers while unknown settlement is resolved", async () => {
    let globallyBusy = false;
    const reconcile = vi.fn(async () => {});
    const boundary = createResourceActionMutationBoundary({
      isGloballyBusy: () => globallyBusy,
      markGloballyBusy: () => {
        globallyBusy = true;
      },
      clearGloballyBusy: () => {
        globallyBusy = false;
      },
      reconcile,
    });
    const lease = boundary.begin()!;

    await lease.reconcile({ kind: "AllRetained" });
    await lease.reconcile({ kind: "AllRetained" });
    await lease.commit();

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(boundary.isActive()).toBe(false);
    expect(globallyBusy).toBe(false);
  });

  it("clears busy when the same-system reconciliation rejects", async () => {
    const defect = new Error("snapshot contract drift");
    let globallyBusy = false;
    const boundary = createResourceActionMutationBoundary({
      isGloballyBusy: () => globallyBusy,
      markGloballyBusy: () => {
        globallyBusy = true;
      },
      clearGloballyBusy: () => {
        globallyBusy = false;
      },
      reconcile: async () => {
        throw defect;
      },
    });
    const lease = boundary.begin()!;

    await expect(
      lease.reconcile({ kind: "AllRetained" }),
    ).rejects.toBe(defect);
    expect(boundary.isActive()).toBe(false);
    expect(globallyBusy).toBe(false);
  });

  it("clears busy when reconciliation throws before returning a promise", async () => {
    const defect = new Error("synchronous snapshot defect");
    let globallyBusy = false;
    const boundary = createResourceActionMutationBoundary({
      isGloballyBusy: () => globallyBusy,
      markGloballyBusy: () => {
        globallyBusy = true;
      },
      clearGloballyBusy: () => {
        globallyBusy = false;
      },
      reconcile: () => {
        throw defect;
      },
    });
    const lease = boundary.begin()!;

    await expect(
      lease.reconcile({ kind: "AllRetained" }),
    ).rejects.toBe(defect);
    expect(boundary.isActive()).toBe(false);
    expect(globallyBusy).toBe(false);
  });

  it("does not acquire while another owner holds the global action key", () => {
    const boundary = createResourceActionMutationBoundary({
      isGloballyBusy: () => true,
      markGloballyBusy: vi.fn(),
      clearGloballyBusy: vi.fn(),
      reconcile: async () => {},
    });

    expect(boundary.begin()).toBeNull();
    expect(boundary.isActive()).toBe(false);
  });

  it("rolls back local and global ownership when busy acquisition defects", () => {
    const defect = new Error("busy listener defect");
    let globallyBusy = false;
    const boundary = createResourceActionMutationBoundary({
      isGloballyBusy: () => globallyBusy,
      markGloballyBusy: () => {
        globallyBusy = true;
        throw defect;
      },
      clearGloballyBusy: () => {
        globallyBusy = false;
      },
      reconcile: async () => {},
    });

    expect(() => boundary.begin()).toThrow(defect);
    expect(boundary.isActive()).toBe(false);
    expect(globallyBusy).toBe(false);
  });
});
