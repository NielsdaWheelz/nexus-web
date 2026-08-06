import { describe, expect, it, vi } from "vitest";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import {
  createMountedEditorIntentController,
  createMountedActionHandoff,
  executeDestructiveMountedMutation,
  MOUNTED_ACTION_ACCEPTED,
  MOUNTED_ACTION_DEFERRED,
  MOUNTED_ACTION_DELIVERY_TIMEOUT_MS,
  type MountedActionIntentBase,
} from "./mountedActionHandoff";
import { ApiError } from "@/lib/api/client";
import type { DestructiveActionSettlement } from "@/lib/actions/destructiveActionSettlement";
import type { PageActionIntent } from "@/lib/notes/actionIntents";
import type { HighlightActionIntent } from "@/lib/highlights/actionIntent";

type TestIntent = MountedActionIntentBase & {
  readonly kind: "Edit";
};

const REF = assumeCanonicalResourceRef(
  "page:11111111-1111-4111-8111-111111111111",
);
const OTHER_REF = assumeCanonicalResourceRef(
  "page:22222222-2222-4222-8222-222222222222",
);

function intent(ref = REF): TestIntent {
  return {
    kind: "Edit",
    ref,
    activation: {
      resourceRef: ref,
      kind: "route",
      href: `/pages/${ref.split(":")[1]}`,
      unresolvedReason: null,
    },
  };
}

function committingIntent<TKind extends "DeletePage" | "DeleteHighlight">(
  kind: TKind,
  ref: typeof REF,
  onCommitted: () => Promise<void>,
  onAborted: () => void,
  settleDeletionCommand: (
    command: () => Promise<unknown>,
  ) => Promise<DestructiveActionSettlement> = async (command) => {
    await command();
    return { kind: "Committed", evidence: "Acknowledged" };
  },
): Extract<PageActionIntent | HighlightActionIntent, { kind: TKind }> {
  return {
    kind,
    ref,
    activation: {
      resourceRef: ref,
      kind: "route",
      href: `/resources/${ref}`,
      unresolvedReason: null,
    },
    settleDeletionCommand,
    onCommitted,
    onAborted,
  } as Extract<PageActionIntent | HighlightActionIntent, { kind: TKind }>;
}

function manualExpiryScheduler() {
  const pending: Array<{ expire: () => void; active: boolean }> = [];
  return {
    scheduleExpiry(expire: () => void, timeoutMs: number) {
      expect(timeoutMs).toBe(MOUNTED_ACTION_DELIVERY_TIMEOUT_MS);
      const entry = { expire, active: true };
      pending.push(entry);
      return () => {
        entry.active = false;
      };
    },
    expireNext() {
      const entry = pending.find((candidate) => candidate.active);
      if (!entry) throw new Error("No pending mounted-action expiry");
      entry.active = false;
      entry.expire();
    },
    activeCount: () => pending.filter((entry) => entry.active).length,
  };
}

describe("mounted action handoff", () => {
  it("notifies an already-mounted accepting owner exactly once", () => {
    const handoff = createMountedActionHandoff<TestIntent>();
    const owner = vi.fn(() => MOUNTED_ACTION_ACCEPTED);
    handoff.subscribe(REF, owner);

    handoff.request(intent());

    expect(owner).toHaveBeenCalledOnce();
    handoff.subscribe(
      REF,
      vi.fn(() => MOUNTED_ACTION_ACCEPTED),
    );
    expect(owner).toHaveBeenCalledOnce();
  });

  it("retains a request by ref until a later owner accepts it", () => {
    const handoff = createMountedActionHandoff<TestIntent>();
    const deferredOwner = vi.fn(() => MOUNTED_ACTION_DEFERRED);
    handoff.subscribe(REF, deferredOwner);
    handoff.request(intent());

    const otherOwner = vi.fn(() => MOUNTED_ACTION_ACCEPTED);
    handoff.subscribe(OTHER_REF, otherOwner);
    expect(otherOwner).not.toHaveBeenCalled();

    const acceptingOwner = vi.fn(() => MOUNTED_ACTION_ACCEPTED);
    handoff.subscribe(REF, acceptingOwner);
    expect(acceptingOwner).toHaveBeenCalledOnce();
    expect(acceptingOwner).toHaveBeenCalledWith(intent());
  });

  it("retains the snapshot activation value instead of its mutable object", () => {
    const handoff = createMountedActionHandoff<TestIntent>();
    const requested = intent();
    handoff.request(requested);
    requested.activation.href = "/pages/mutated";

    const owner = vi.fn(() => MOUNTED_ACTION_ACCEPTED);
    handoff.subscribe(REF, owner);

    const delivered = owner.mock.calls.at(0)?.at(0) as TestIntent | undefined;
    expect(delivered?.activation.href).toBe(
      "/pages/11111111-1111-4111-8111-111111111111",
    );
  });

  it("rejects an activation for a different canonical ref", () => {
    const handoff = createMountedActionHandoff<TestIntent>();

    expect(() =>
      handoff.request({
        ...intent(),
        activation: { ...intent().activation, resourceRef: OTHER_REF },
      }),
    ).toThrow("activation must identify its canonical ref");
  });

  it("commits a mounted page delete after domain success even when local projection fails", async () => {
    const handoff = createMountedActionHandoff<PageActionIntent>();
    const onCommitted = vi.fn(async () => {});
    const onAborted = vi.fn();
    const mutate = vi.fn(async () => {});
    const projectionError = new Error("local refresh failed");
    let completion:
      ReturnType<typeof executeDestructiveMountedMutation> | undefined;
    handoff.subscribe(REF, (delivered) => {
      if (delivered.kind !== "DeletePage") return MOUNTED_ACTION_DEFERRED;
      completion = executeDestructiveMountedMutation(delivered, mutate, () =>
        Promise.reject(projectionError),
      );
      return MOUNTED_ACTION_ACCEPTED;
    });

    handoff.request(
      committingIntent("DeletePage", REF, onCommitted, onAborted),
    );
    await expect(completion).resolves.toEqual({
      kind: "Committed",
      evidence: "Acknowledged",
      projectionError,
    });

    expect(mutate).toHaveBeenCalledOnce();
    expect(onCommitted).toHaveBeenCalledOnce();
    expect(onAborted).not.toHaveBeenCalled();
  });

  it("aborts a mounted highlight delete exactly once when observation proves it did not commit", async () => {
    const handoff = createMountedActionHandoff<HighlightActionIntent>();
    const onCommitted = vi.fn(async () => {});
    const onAborted = vi.fn();
    const failure = new ApiError(0, "E_NETWORK", "response lost");
    let completion:
      ReturnType<typeof executeDestructiveMountedMutation> | undefined;
    handoff.subscribe(REF, (delivered) => {
      if (delivered.kind !== "DeleteHighlight") {
        return MOUNTED_ACTION_DEFERRED;
      }
      completion = executeDestructiveMountedMutation(
        delivered,
        vi.fn(),
        vi.fn(),
      );
      return MOUNTED_ACTION_ACCEPTED;
    });

    handoff.request(
      committingIntent(
        "DeleteHighlight",
        REF,
        onCommitted,
        onAborted,
        async () => ({ kind: "NotCommitted", commandError: failure }),
      ),
    );
    await expect(completion).rejects.toBe(failure);

    expect(onCommitted).not.toHaveBeenCalled();
    expect(onAborted).toHaveBeenCalledOnce();
  });

  it("aborts only after the runtime returns its cache-barrier Unconfirmed outcome", async () => {
    const onCommitted = vi.fn(async () => {});
    const onAborted = vi.fn();
    const commandError = new ApiError(0, "E_NETWORK", "response lost");
    const observationError = new ApiError(
      504,
      "E_UPSTREAM_TIMEOUT",
      "observation lost",
    );
    const intent = committingIntent(
      "DeletePage",
      REF,
      onCommitted,
      onAborted,
      async () => ({
        kind: "Unconfirmed",
        commandError,
        observationError,
      }),
    );

    await expect(
      executeDestructiveMountedMutation(intent, vi.fn(), vi.fn()),
    ).resolves.toEqual({ kind: "Unconfirmed" });
    expect(onCommitted).not.toHaveBeenCalled();
    expect(onAborted).toHaveBeenCalledOnce();
  });

  it("commits an observed-missing delete through the same projection and reconciliation path", async () => {
    const onCommitted = vi.fn(async () => {});
    const onAborted = vi.fn();
    const projectCommitted = vi.fn(async () => {});
    const intent = committingIntent(
      "DeleteHighlight",
      REF,
      onCommitted,
      onAborted,
      async () => ({ kind: "Committed", evidence: "ObservedMissing" }),
    );

    await expect(
      executeDestructiveMountedMutation(intent, vi.fn(), projectCommitted),
    ).resolves.toEqual({
      kind: "Committed",
      evidence: "ObservedMissing",
    });
    expect(projectCommitted).toHaveBeenCalledOnce();
    expect(onCommitted).toHaveBeenCalledOnce();
    expect(onAborted).not.toHaveBeenCalled();
  });

  it("aborts and propagates a destructive settlement defect", async () => {
    const onCommitted = vi.fn(async () => {});
    const onAborted = vi.fn();
    const defect = new TypeError("snapshot identity drift");
    const intent = committingIntent(
      "DeletePage",
      REF,
      onCommitted,
      onAborted,
      async () => Promise.reject(defect),
    );

    await expect(
      executeDestructiveMountedMutation(intent, vi.fn(), vi.fn()),
    ).rejects.toBe(defect);
    expect(onCommitted).not.toHaveBeenCalled();
    expect(onAborted).toHaveBeenCalledOnce();
  });

  it("expires an undelivered request and never delivers it to a late owner", async () => {
    const expiry = manualExpiryScheduler();
    const handoff = createMountedActionHandoff<TestIntent>({
      scheduleExpiry: expiry.scheduleExpiry,
    });
    const request = handoff.request(intent());

    expect(expiry.activeCount()).toBe(1);
    expiry.expireNext();

    await expect(request.outcome).resolves.toEqual({ kind: "Expired" });
    const lateOwner = vi.fn(() => MOUNTED_ACTION_ACCEPTED);
    handoff.subscribe(REF, lateOwner);
    expect(lateOwner).not.toHaveBeenCalled();
    expect(request.cancel("CallerCancelled")).toBe(false);
  });

  it("cancels a pending request exactly once and prevents stale delivery", async () => {
    const expiry = manualExpiryScheduler();
    const handoff = createMountedActionHandoff<TestIntent>({
      scheduleExpiry: expiry.scheduleExpiry,
    });
    const request = handoff.request(intent());

    expect(request.cancel("ActivationFailed")).toBe(true);
    expect(request.cancel("CallerCancelled")).toBe(false);
    await expect(request.outcome).resolves.toEqual({
      kind: "Cancelled",
      reason: "ActivationFailed",
    });
    expect(expiry.activeCount()).toBe(0);

    const lateOwner = vi.fn(() => MOUNTED_ACTION_ACCEPTED);
    handoff.subscribe(REF, lateOwner);
    expect(lateOwner).not.toHaveBeenCalled();
  });

  it("re-offers a temporarily deferred request only when explicitly notified", async () => {
    const handoff = createMountedActionHandoff<TestIntent>();
    let ready = false;
    const owner = vi.fn(() =>
      ready ? MOUNTED_ACTION_ACCEPTED : MOUNTED_ACTION_DEFERRED,
    );
    handoff.subscribe(REF, owner);
    const request = handoff.request(intent());

    expect(owner).toHaveBeenCalledOnce();
    ready = true;
    handoff.notifyReady(REF);

    await expect(request.outcome).resolves.toEqual({ kind: "Accepted" });
    expect(owner).toHaveBeenCalledTimes(2);
  });

  it("reports an owner defect through the request outcome instead of stranding it", async () => {
    const handoff = createMountedActionHandoff<TestIntent>();
    const defect = new Error("owner failed while accepting");
    handoff.subscribe(REF, () => {
      throw defect;
    });

    const request = handoff.request(intent());

    await expect(request.outcome).resolves.toEqual({
      kind: "OwnerDefect",
      error: defect,
    });
  });
});

describe("mounted editor intent settlement", () => {
  function editorIntent() {
    return {
      ...intent(),
      onCommitted: vi.fn(async () => {}),
      onAborted: vi.fn(),
    };
  }

  it("aborts an accepted edit that unmounts before a write starts", () => {
    const notifyReady = vi.fn();
    const controller = createMountedEditorIntentController(notifyReady);
    const accepted = editorIntent();

    expect(controller.accept(accepted)).toBe(true);
    controller.releaseOwner();
    controller.releaseOwner();

    expect(accepted.onAborted).toHaveBeenCalledOnce();
    expect(accepted.onCommitted).not.toHaveBeenCalled();
    expect(notifyReady).not.toHaveBeenCalled();
    expect(controller.occupied()).toBe(false);
  });

  it("reconciles late success after the mounted owner unmounts", async () => {
    const controller = createMountedEditorIntentController(vi.fn());
    const accepted = editorIntent();
    controller.accept(accepted);
    const mutation = controller.beginMutation();

    controller.releaseOwner();
    await mutation?.committed();

    expect(accepted.onCommitted).toHaveBeenCalledOnce();
    expect(accepted.onAborted).not.toHaveBeenCalled();
    expect(controller.occupied()).toBe(false);
  });

  it("aborts late failure after the mounted owner unmounts", () => {
    const controller = createMountedEditorIntentController(vi.fn());
    const accepted = editorIntent();
    controller.accept(accepted);
    const mutation = controller.beginMutation();

    controller.releaseOwner();
    mutation?.failed();

    expect(accepted.onAborted).toHaveBeenCalledOnce();
    expect(accepted.onCommitted).not.toHaveBeenCalled();
    expect(controller.occupied()).toBe(false);
  });

  it("keeps a mounted failed edit accepted for retry, then aborts on close", () => {
    const notifyReady = vi.fn();
    const controller = createMountedEditorIntentController(notifyReady);
    const accepted = editorIntent();
    controller.accept(accepted);

    controller.beginMutation()?.failed();
    expect(controller.occupied()).toBe(true);
    const retry = controller.beginMutation();
    expect(retry).not.toBeNull();
    retry?.failed();
    controller.abortEditing();

    expect(accepted.onAborted).toHaveBeenCalledOnce();
    expect(accepted.onCommitted).not.toHaveBeenCalled();
    expect(notifyReady).toHaveBeenCalledWith(REF);
  });
});
