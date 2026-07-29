import { describe, expect, it } from "vitest";
import { absent, present } from "@/lib/api/presence";
import {
  decodeChatRunData,
  decodeConversationMessage,
  decodeReaderSelectionPresence,
} from "@/lib/conversations/messageWire";
import type { ReaderSelectionOut } from "@/lib/conversations/readerSelection";
import type {
  ChatRunResponse,
  ConversationMessage,
} from "@/lib/conversations/types";

// The snake_case snapshot exactly as the server wire speaks it.
const wireSnapshot = {
  key: {
    media_id: "22222222-2222-4222-8222-222222222222",
    highlight_id: "33333333-3333-4333-8333-333333333333",
  },
  source_label: "The Source",
  exact: "quoted text",
  prefix: "before ",
  suffix: " after",
  locator: {
    type: "epub_fragment_offsets",
    media_id: "22222222-2222-4222-8222-222222222222",
    fragment_id: "frag-1",
    start_offset: 0,
    end_offset: 11,
  },
  activation: {
    resource_ref: "media:22222222-2222-4222-8222-222222222222",
    kind: "route",
    href: "/media/22222222-2222-4222-8222-222222222222",
    unresolved_reason: null,
  },
};

const decodedSnapshot: ReaderSelectionOut = {
  key: {
    mediaId: "22222222-2222-4222-8222-222222222222",
    highlightId: "33333333-3333-4333-8333-333333333333",
  },
  sourceLabel: "The Source",
  exact: "quoted text",
  prefix: "before ",
  suffix: " after",
  locator: {
    type: "epub_fragment_offsets",
    media_id: "22222222-2222-4222-8222-222222222222",
    fragment_id: "frag-1",
    start_offset: 0,
    end_offset: 11,
  },
  activation: {
    resourceRef: "media:22222222-2222-4222-8222-222222222222",
    kind: "route",
    href: "/media/22222222-2222-4222-8222-222222222222",
    unresolvedReason: null,
  },
};

const userMessageBase = {
  seq: 1,
  role: "user" as const,
  status: "complete" as const,
  can_rerun: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  trust_trail: null,
};

const wireCitation = {
  ordinal: 1,
  role: "supports",
  target_ref: {
    type: "media",
    id: "22222222-2222-4222-8222-222222222222",
  },
  activation: {
    resource_ref: "media:22222222-2222-4222-8222-222222222222",
    kind: "route",
    href: "/media/22222222-2222-4222-8222-222222222222",
    unresolved_reason: null,
  },
  media_id: "22222222-2222-4222-8222-222222222222",
  locator: null,
  deep_link: "/media/22222222-2222-4222-8222-222222222222",
  snapshot: null,
};

describe("decodeReaderSelectionPresence", () => {
  it("decodes a Present wire snapshot into the owned camelCase value", () => {
    const raw = { kind: "Present", value: wireSnapshot };
    expect(decodeReaderSelectionPresence(raw)).toEqual(
      present(decodedSnapshot),
    );
  });

  it("passes an explicit Absent through", () => {
    expect(decodeReaderSelectionPresence({ kind: "Absent" })).toEqual(absent());
  });

  it("treats a missing field (older wire) as Absent", () => {
    expect(decodeReaderSelectionPresence(undefined)).toEqual(absent());
    expect(decodeReaderSelectionPresence(null)).toEqual(absent());
  });

  it("throws on a malformed Present snapshot", () => {
    expect(() =>
      decodeReaderSelectionPresence({ kind: "Present", value: { key: {} } }),
    ).toThrow();
  });
});

describe("decodeConversationMessage", () => {
  it("decodes a quoted user message's reader_selection and preserves other fields", () => {
    const wire = {
      ...userMessageBase,
      id: "u1",
      reader_selection: { kind: "Present", value: wireSnapshot },
    } as unknown as ConversationMessage;
    const decoded = decodeConversationMessage(wire);
    expect(decoded.reader_selection).toEqual(present(decodedSnapshot));
    expect(decoded.id).toBe("u1");
  });

  it("sets Absent when the field is missing from the wire", () => {
    const wire = { ...userMessageBase, id: "u1" } as ConversationMessage;
    expect(decodeConversationMessage(wire).reader_selection).toEqual(absent());
  });

  it("normalizes nested citation activations at the message boundary", () => {
    const wire = {
      ...userMessageBase,
      id: "a1",
      role: "assistant",
      citations: [wireCitation],
    } as unknown as ConversationMessage;
    expect(decodeConversationMessage(wire).citations?.[0]?.activation).toEqual({
      resourceRef: "media:22222222-2222-4222-8222-222222222222",
      kind: "route",
      href: "/media/22222222-2222-4222-8222-222222222222",
      unresolvedReason: null,
    });
  });

  it("normalizes completed trust-trail context activations at the message boundary", () => {
    const wire = {
      ...userMessageBase,
      id: "a1",
      role: "assistant",
      trust_trail: {
        schema_version: "assistant_trust_trail.v1",
        assistant_message_id: "a1",
        conversation_id: "c1",
        chat_run_id: "r1",
        status: "complete",
        run: null,
        prompt: null,
        tool_calls: [],
        citations: [],
        context_refs_added: [
          {
            chat_run_event_seq: 10,
            id: "context-edge-1",
            conversation_id: "c1",
            resource_ref:
              "message:11111111-1111-4111-8111-111111111111",
            activation: {
              resource_ref:
                "message:11111111-1111-4111-8111-111111111111",
              kind: "route",
              href: "/conversations/c1?message=11111111-1111-4111-8111-111111111111",
              unresolved_reason: null,
            },
            label: "Message",
            summary: "Quoted message",
            missing: false,
            created_at: "2026-01-01T00:00:00Z",
            citation_edge_id: "citation-edge-1",
          },
        ],
        integrity_notices: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    } as unknown as ConversationMessage;

    expect(
      decodeConversationMessage(wire).trust_trail?.context_refs_added[0]
        ?.activation,
    ).toEqual({
      resourceRef: "message:11111111-1111-4111-8111-111111111111",
      kind: "route",
      href: "/conversations/c1?message=11111111-1111-4111-8111-111111111111",
      unresolvedReason: null,
    });
  });
});

describe("decodeChatRunData", () => {
  it("decodes the user_message snapshot and leaves the assistant Absent", () => {
    const runData = {
      run: {},
      conversation: {},
      user_message: {
        ...userMessageBase,
        id: "u1",
        reader_selection: { kind: "Present", value: wireSnapshot },
      },
      assistant_message: {
        ...userMessageBase,
        id: "a1",
        role: "assistant",
      },
      stream_state: {},
    } as unknown as ChatRunResponse["data"];
    const decoded = decodeChatRunData(runData);
    expect(decoded.user_message.reader_selection).toEqual(
      present(decodedSnapshot),
    );
    expect(decoded.assistant_message.reader_selection).toEqual(absent());
  });
});
