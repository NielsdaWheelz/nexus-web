import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT_RECORD,
  decodeChatDraftRecord,
  withClearedOperation,
  withReconcileRequired,
  withSubmitting,
  type ChatDraftRecord,
  type ChatSendCommand,
} from "@/components/chat/useChatDraft";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";

// Risk: exact send-operation identity + recovery (spec §5.3, AC-4/5/6/7). Oracle:
// the documented operation FSM — one immutable command per idempotency key,
// replayed verbatim on an unknown outcome, consumed on a definite rejection.

const request: ChatRunCreateRequest = {
  destination: {
    kind: "Existing",
    conversation_id: "conversation-1",
    insertion: {
      kind: "Reply",
      parent_message_id: "assistant-1",
      branch_anchor: { kind: "assistant_message", message_id: "assistant-1" },
    },
  },
  content: "why?",
  profile_id: "fast",
  reasoning_option_id: "low",
  reader_selection: { kind: "Absent" },
};

const command: ChatSendCommand = { idempotencyKey: "key-1", request };

const draft: ChatDraftRecord = {
  text: "why?",
  profile: { profileId: "fast", reasoningOptionId: "low" },
  operation: { kind: "Absent" },
};

describe("chat send-operation transitions", () => {
  it("withSubmitting persists the exact command and preserves text/profile", () => {
    const next = withSubmitting(draft, command);
    expect(next.operation).toEqual({ kind: "Submitting", command });
    expect(next.text).toBe("why?");
    expect(next.profile).toEqual({ profileId: "fast", reasoningOptionId: "low" });
  });

  it("withReconcileRequired locks the same command for exact replay", () => {
    const reconcile = withReconcileRequired(withSubmitting(draft, command));
    expect(reconcile.operation).toEqual({ kind: "ReconcileRequired", command });
  });

  it("withReconcileRequired rejects a non-Submitting operation as a defect", () => {
    expect(() => withReconcileRequired(draft)).toThrow();
    expect(() =>
      withReconcileRequired(withReconcileRequired(withSubmitting(draft, command))),
    ).toThrow();
  });

  it("withClearedOperation consumes the command but keeps editable text/profile", () => {
    const cleared = withClearedOperation(withSubmitting(draft, command));
    expect(cleared.operation).toEqual({ kind: "Absent" });
    expect(cleared.text).toBe("why?");
    expect(cleared.profile).toEqual({ profileId: "fast", reasoningOptionId: "low" });
  });
});

describe("decodeChatDraftRecord", () => {
  it("promotes a persisted Submitting to ReconcileRequired at ingress", () => {
    const stored = JSON.stringify(withSubmitting(draft, command));
    // AC-4: reloading an in-flight send exposes a locked replay of the same key.
    expect(decodeChatDraftRecord(stored).operation).toEqual({
      kind: "ReconcileRequired",
      command,
    });
  });

  it("round-trips Absent and ReconcileRequired records unchanged", () => {
    expect(decodeChatDraftRecord(JSON.stringify(draft))).toEqual(draft);
    const reconcile = withReconcileRequired(withSubmitting(draft, command));
    expect(decodeChatDraftRecord(JSON.stringify(reconcile))).toEqual(reconcile);
    expect(decodeChatDraftRecord(JSON.stringify(EMPTY_DRAFT_RECORD))).toEqual(
      EMPTY_DRAFT_RECORD,
    );
  });

  it("rejects malformed current data as a defect", () => {
    expect(() => decodeChatDraftRecord("not json")).toThrow();
    expect(() => decodeChatDraftRecord("{}")).toThrow();
    expect(() =>
      decodeChatDraftRecord(JSON.stringify({ text: "x", profile: null })),
    ).toThrow();
    expect(() =>
      decodeChatDraftRecord(
        JSON.stringify({ text: "x", profile: null, operation: { kind: "Submitting" } }),
      ),
    ).toThrow();
    expect(() =>
      decodeChatDraftRecord(
        JSON.stringify({ text: "x", profile: null, operation: { kind: "Bogus" } }),
      ),
    ).toThrow();
    expect(() =>
      decodeChatDraftRecord(
        JSON.stringify({
          text: "x",
          profile: null,
          operation: { kind: "Submitting", command: { idempotencyKey: "k" } },
        }),
      ),
    ).toThrow();
  });
});
