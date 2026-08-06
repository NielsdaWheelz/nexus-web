import { describe, expect, it, vi } from "vitest";

import { commitCompletionUndoStep } from "@/lib/lectern/useCompletionUndo";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

describe("completion Undo commit barrier", () => {
  it("orders mutation before reconciliation and settles only after both", async () => {
    const order: string[] = [];
    const reconciliation = deferred();
    let settled = false;

    const outcome = commitCompletionUndoStep({
      mutate: async () => {
        order.push("mutate");
      },
      reconcile: async () => {
        order.push("reconcile");
        await reconciliation.promise;
      },
    }).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => expect(order).toEqual(["mutate", "reconcile"]));
    expect(settled).toBe(false);

    reconciliation.resolve();
    await expect(outcome).resolves.toEqual({ kind: "Ready" });
    expect(settled).toBe(true);
  });

  it("does not reconcile when the mutation fails", async () => {
    const failure = new Error("mutation failed");
    const reconcile = vi.fn(async () => {});

    await expect(
      commitCompletionUndoStep({
        mutate: () => Promise.reject(failure),
        reconcile,
      }),
    ).resolves.toEqual({ kind: "MutationFailed", error: failure });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("distinguishes reconciliation failure after the mutation commits", async () => {
    const failure = new Error("reconciliation failed");
    const mutate = vi.fn(async () => {});

    await expect(
      commitCompletionUndoStep({
        mutate,
        reconcile: () => Promise.reject(failure),
      }),
    ).resolves.toEqual({ kind: "ReconciliationFailed", error: failure });
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("preserves both unread and restore barriers in exact command order", async () => {
    const order: string[] = [];
    const run = (mutation: string, reconciliation: string) =>
      commitCompletionUndoStep({
        mutate: async () => {
          order.push(mutation);
        },
        reconcile: async () => {
          order.push(reconciliation);
        },
      });

    await expect(run("mark-unread", "reconcile-unread")).resolves.toEqual({
      kind: "Ready",
    });
    await expect(run("restore-lectern", "reconcile-lectern")).resolves.toEqual(
      { kind: "Ready" },
    );

    expect(order).toEqual([
      "mark-unread",
      "reconcile-unread",
      "restore-lectern",
      "reconcile-lectern",
    ]);
  });
});
