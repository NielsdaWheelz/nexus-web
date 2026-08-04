import { describe, expect, it } from "vitest";
import { buildChatRunBody } from "@/lib/conversations/chatRunBody";
import type { BranchDraft } from "@/lib/conversations/types";

// Risk: the single request builder (spec §14, AC-13). Oracle: the documented
// destination/insertion/branch-anchor rules. One code path builds the request,
// so a stored command replays byte-for-byte (AC-6).

const scalars = {
  content: "why?",
  profileId: "fast",
  reasoningOptionId: "low",
};

describe("buildChatRunBody", () => {
  it("builds a New destination for a null conversation with no reader selection", () => {
    const body = buildChatRunBody({
      ...scalars,
      conversationId: null,
      branchDraft: null,
      parentMessageId: null,
    });
    expect(body).toEqual({
      destination: { kind: "New" },
      content: "why?",
      profile_id: "fast",
      reasoning_option_id: "low",
      reader_selection: { kind: "Absent" },
    });
  });

  it("builds Existing.Empty for a conversation with no reply parent", () => {
    const body = buildChatRunBody({
      ...scalars,
      conversationId: "conversation-1",
      branchDraft: null,
      parentMessageId: null,
    });
    expect(body.destination).toEqual({
      kind: "Existing",
      conversation_id: "conversation-1",
      insertion: { kind: "Empty" },
    });
  });

  it("builds a plain continuation reply anchored on the active leaf", () => {
    const body = buildChatRunBody({
      ...scalars,
      conversationId: "conversation-1",
      branchDraft: null,
      parentMessageId: "assistant-9",
    });
    expect(body.destination).toEqual({
      kind: "Existing",
      conversation_id: "conversation-1",
      insertion: {
        kind: "Reply",
        parent_message_id: "assistant-9",
        branch_anchor: { kind: "assistant_message", message_id: "assistant-9" },
      },
    });
  });

  it("prefers an explicit branch reply's anchor over a plain continuation", () => {
    const selection: BranchDraft = {
      parentMessageId: "assistant-2",
      parentMessageSeq: 3,
      parentMessagePreview: "prev",
      anchor: {
        kind: "assistant_selection",
        message_id: "assistant-2",
        exact: "quoted",
        prefix: null,
        suffix: null,
        offset_status: "mapped",
        start_offset: 0,
        end_offset: 6,
        client_selection_id: "sel-4",
      },
    };
    const body = buildChatRunBody({
      ...scalars,
      conversationId: "conversation-1",
      branchDraft: selection,
      parentMessageId: "assistant-9",
    });
    expect(body.destination).toEqual({
      kind: "Existing",
      conversation_id: "conversation-1",
      insertion: {
        kind: "Reply",
        parent_message_id: "assistant-2",
        branch_anchor: selection.anchor,
      },
    });
  });

  it("carries a Present reader selection when one rides the send", () => {
    const body = buildChatRunBody({
      ...scalars,
      conversationId: null,
      branchDraft: null,
      parentMessageId: null,
      readerSelection: {
        key: { media_id: "media-1", highlight_id: "highlight-1" },
        revision: "a".repeat(64),
      },
    });
    expect(body.reader_selection).toEqual({
      kind: "Present",
      value: {
        key: { media_id: "media-1", highlight_id: "highlight-1" },
        revision: "a".repeat(64),
      },
    });
  });
});
