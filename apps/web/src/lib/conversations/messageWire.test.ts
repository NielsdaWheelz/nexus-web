import { describe, expect, it } from "vitest";
import { absent, present } from "@/lib/api/presence";
import {
  decodeMessageReaderSelection,
  decodeReaderSelectionPresence,
  decodeRunDataReaderSelection,
} from "@/lib/conversations/messageWire";
import type { ReaderSelectionOut } from "@/lib/conversations/readerSelection";
import type { ChatRunResponse, ConversationMessage } from "@/lib/conversations/types";

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

describe("decodeReaderSelectionPresence", () => {
  it("decodes a Present wire snapshot into the owned camelCase value", () => {
    const raw = { kind: "Present", value: wireSnapshot };
    expect(decodeReaderSelectionPresence(raw)).toEqual(present(decodedSnapshot));
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

describe("decodeMessageReaderSelection", () => {
  it("decodes a quoted user message's reader_selection and preserves other fields", () => {
    const wire = {
      ...userMessageBase,
      id: "u1",
      reader_selection: { kind: "Present", value: wireSnapshot },
    } as unknown as ConversationMessage;
    const decoded = decodeMessageReaderSelection(wire);
    expect(decoded.reader_selection).toEqual(present(decodedSnapshot));
    expect(decoded.id).toBe("u1");
  });

  it("sets Absent when the field is missing from the wire", () => {
    const wire = { ...userMessageBase, id: "u1" } as ConversationMessage;
    expect(decodeMessageReaderSelection(wire).reader_selection).toEqual(absent());
  });
});

describe("decodeRunDataReaderSelection", () => {
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
    const decoded = decodeRunDataReaderSelection(runData);
    expect(decoded.user_message.reader_selection).toEqual(present(decodedSnapshot));
    expect(decoded.assistant_message.reader_selection).toEqual(absent());
  });
});
