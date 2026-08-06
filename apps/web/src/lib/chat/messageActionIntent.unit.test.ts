import { describe, expect, it, vi } from "vitest";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { CommittingMessageActionIntent } from "./messageActionIntent";
import { settleMessageActionMutation } from "./messageActionIntent";

const REF = assumeCanonicalResourceRef(
  "message:11111111-1111-4111-8111-111111111111",
);

function intent({
  onCommitted = vi.fn(async () => {}),
  onAborted = vi.fn(),
}: {
  onCommitted?: () => Promise<void>;
  onAborted?: () => void;
} = {}): CommittingMessageActionIntent {
  return {
    kind: "DeleteMessage",
    ref: REF,
    activation: {
      resourceRef: REF,
      kind: "route",
      href: "/conversations/example",
      unresolvedReason: null,
    },
    settleDeletionCommand: async (command) => {
      await command();
      return { kind: "Committed", evidence: "Acknowledged" };
    },
    settleDeletedConversation: vi.fn(async () => {}),
    onCommitted,
    onAborted,
  };
}

describe("message action mutation settlement", () => {
  it("commits once after authoritative success", async () => {
    const onCommitted = vi.fn(async () => {});
    const onAborted = vi.fn();

    await settleMessageActionMutation(
      intent({ onCommitted, onAborted }),
      async () => "Committed",
    );

    expect(onCommitted).toHaveBeenCalledOnce();
    expect(onAborted).not.toHaveBeenCalled();
  });

  it("aborts once after a modeled mutation failure", async () => {
    const onCommitted = vi.fn(async () => {});
    const onAborted = vi.fn();

    await settleMessageActionMutation(
      intent({ onCommitted, onAborted }),
      async () => "Failed",
    );

    expect(onCommitted).not.toHaveBeenCalled();
    expect(onAborted).toHaveBeenCalledOnce();
  });

  it("aborts once and propagates unexpected mutation rejection", async () => {
    const onCommitted = vi.fn(async () => {});
    const onAborted = vi.fn();
    const failure = new Error("mutation defect");

    await expect(
      settleMessageActionMutation(intent({ onCommitted, onAborted }), () =>
        Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    expect(onCommitted).not.toHaveBeenCalled();
    expect(onAborted).toHaveBeenCalledOnce();
  });

  it("does not abort after the committed callback has begun", async () => {
    const failure = new Error("reconciliation defect");
    const onCommitted = vi.fn(() => Promise.reject(failure));
    const onAborted = vi.fn();

    await expect(
      settleMessageActionMutation(
        intent({ onCommitted, onAborted }),
        async () => "Committed",
      ),
    ).rejects.toBe(failure);
    expect(onCommitted).toHaveBeenCalledOnce();
    expect(onAborted).not.toHaveBeenCalled();
  });
});
