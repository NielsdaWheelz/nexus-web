import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT_RECORD,
  decodeChatDraftRecord,
  withClearedOperation,
  withReconcileRequired,
  withSubmitting,
  type ChatDraftRecord,
  type ChatSendCommand,
  useChatDraft,
} from "@/components/chat/useChatDraft";
import type { ChatRunCreateRequest } from "@/lib/api/sse/requests";

// Risk: exact send-operation identity + recovery (spec §5.3, AC-4/5/6/7). Oracle:
// the documented operation FSM — one immutable command per idempotency key,
// replayed verbatim on an unknown outcome, consumed on a definite rejection.

const request: ChatRunCreateRequest = {
  destination: {
    kind: "Existing",
    conversation_id: "00000000-0000-4000-8000-000000000001",
    insertion: {
      kind: "Reply",
      parent_message_id: "00000000-0000-4000-8000-000000000002",
      branch_anchor: {
        kind: "assistant_message",
        message_id: "00000000-0000-4000-8000-000000000002",
      },
    },
  },
  content: "why?",
  profile_id: "fast",
  reader_selection: { kind: "Absent" },
};

const command: ChatSendCommand = { idempotencyKey: "key-1", request };

const draft: ChatDraftRecord = {
  text: "why?",
  profile: { profileId: "fast" },
  operation: { kind: "Absent" },
};

function ServerDraftProbe() {
  const draftState = useChatDraft({
    draftKey: { kind: "Path", targetId: "server-render" },
  });
  return createElement("p", null, draftState.content);
}

describe("chat draft rendering boundary", () => {
  it("does not read browser storage during server rendering", () => {
    expect(() => renderToString(createElement(ServerDraftProbe))).not.toThrow();
  });
});

describe("chat send-operation transitions", () => {
  it("withSubmitting persists the exact command and preserves text/profile", () => {
    const next = withSubmitting(draft, command);
    expect(next.operation).toEqual({ kind: "Submitting", command });
    expect(next.text).toBe("why?");
    expect(next.profile).toEqual({ profileId: "fast" });
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
    expect(cleared.profile).toEqual({ profileId: "fast" });
  });
});

describe("decodeChatDraftRecord", () => {
  function storedRequest(value: unknown): string {
    return JSON.stringify({
      ...draft,
      operation: {
        kind: "ReconcileRequired",
        command: { idempotencyKey: "key-1", request: value },
      },
    });
  }

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

  it("decodes every closed destination, anchor, presence, and profile variant", () => {
    const variants: ChatRunCreateRequest[] = [
      {
        destination: { kind: "New" },
        content: "new question",
        profile_id: "balanced",
        reader_selection: { kind: "Absent" },
      },
      {
        destination: {
          kind: "Existing",
          conversation_id: "00000000-0000-4000-8000-000000000003",
          insertion: { kind: "Empty" },
        },
        content: "quoted question",
        profile_id: "deep",
        reader_selection: {
          kind: "Present",
          value: {
            key: {
              media_id: "00000000-0000-4000-8000-000000000004",
              highlight_id: "00000000-0000-4000-8000-000000000005",
            },
            revision: "a".repeat(64),
          },
        },
      },
      {
        destination: {
          kind: "Existing",
          conversation_id: "00000000-0000-4000-8000-000000000006",
          insertion: {
            kind: "Reply",
            parent_message_id: "00000000-0000-4000-8000-000000000007",
            branch_anchor: {
              kind: "assistant_selection",
              message_id: "00000000-0000-4000-8000-000000000007",
              exact: "mapped quote",
              prefix: "before",
              suffix: "after",
              offset_status: "mapped",
              start_offset: 2,
              end_offset: 14,
              client_selection_id: "selection-1",
            },
          },
        },
        content: "mapped branch",
        profile_id: "fast",
        reader_selection: { kind: "Absent" },
      },
      {
        destination: {
          kind: "Existing",
          conversation_id: "00000000-0000-4000-8000-000000000008",
          insertion: {
            kind: "Reply",
            parent_message_id: "00000000-0000-4000-8000-000000000009",
            branch_anchor: {
              kind: "assistant_selection",
              message_id: "00000000-0000-4000-8000-000000000009",
              exact: "unmapped quote",
              prefix: null,
              suffix: null,
              offset_status: "unmapped",
              client_selection_id: "selection-2",
            },
          },
        },
        content: "unmapped branch",
        profile_id: "balanced",
        reader_selection: { kind: "Absent" },
      },
    ];

    for (const variant of variants) {
      const decoded = decodeChatDraftRecord(storedRequest(variant));
      expect(decoded.operation).toEqual({
        kind: "ReconcileRequired",
        command: { idempotencyKey: "key-1", request: variant },
      });
    }
  });

  it("deeply rejects incomplete, widened, or selector-bearing persisted requests", () => {
    const valid = {
      destination: { kind: "New" },
      content: "question",
      profile_id: "fast",
      reader_selection: { kind: "Absent" },
    };
    const invalidRequests: unknown[] = [
      { ...valid, reasoning_option_id: "high" },
      { destination: { kind: "New" }, content: "question", profile_id: "fast" },
      { ...valid, profile_id: "turbo" },
      { ...valid, content: "   " },
      { ...valid, destination: { kind: "New", conversation_id: "surplus" } },
      {
        ...valid,
        destination: {
          kind: "Existing",
          conversation_id: "00000000-0000-4000-8000-000000000010",
          insertion: { kind: "Reply", parent_message_id: "missing-anchor" },
        },
      },
      {
        ...valid,
        destination: {
          kind: "Existing",
          conversation_id: "00000000-0000-4000-8000-000000000010",
          insertion: {
            kind: "Reply",
            parent_message_id: "00000000-0000-4000-8000-000000000011",
            branch_anchor: { kind: "assistant_message" },
          },
        },
      },
      {
        ...valid,
        reader_selection: {
          kind: "Present",
          value: {
            key: {
              media_id: "00000000-0000-4000-8000-000000000012",
              highlight_id: "00000000-0000-4000-8000-000000000013",
              extra: true,
            },
            revision: "a".repeat(64),
          },
        },
      },
      {
        ...valid,
        reader_selection: {
          kind: "Present",
          value: {
            key: {
              media_id: "00000000-0000-4000-8000-000000000012",
              highlight_id: "00000000-0000-4000-8000-000000000013",
            },
            revision: "NOT-A-DIGEST",
          },
        },
      },
      { ...valid, reader_selection: null },
    ];

    for (const invalid of invalidRequests) {
      expect(() => decodeChatDraftRecord(storedRequest(invalid))).toThrow();
    }
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
