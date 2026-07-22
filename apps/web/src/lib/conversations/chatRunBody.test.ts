import { describe, expect, it } from "vitest";
import { buildChatRunBody } from "./chatRunBody";
import type { BranchDraft } from "./types";

const base = {
  conversationId: "conv-1" as string | null,
  content: "hello",
  profileId: "profile-1",
  reasoningOptionId: "reasoning-default",
  branchDraft: null,
  parentMessageId: null,
};

describe("buildChatRunBody", () => {
  it("targets a fresh New conversation when there is no conversation id", () => {
    const body = buildChatRunBody({ ...base, conversationId: null });
    expect(body.destination).toEqual({ kind: "New" });
    expect(body.reader_selection).toEqual({ kind: "Absent" });
    expect(body.profile_id).toBe("profile-1");
    expect(body.reasoning_option_id).toBe("reasoning-default");
  });

  it("targets Existing.Empty for the first message of an existing empty conversation", () => {
    const body = buildChatRunBody(base);
    expect(body.destination).toEqual({
      kind: "Existing",
      conversation_id: "conv-1",
      insertion: { kind: "Empty" },
    });
  });

  it("targets Existing.Reply anchored to the active assistant turn", () => {
    const body = buildChatRunBody({ ...base, parentMessageId: "asst-7" });
    expect(body.destination).toEqual({
      kind: "Existing",
      conversation_id: "conv-1",
      insertion: {
        kind: "Reply",
        parent_message_id: "asst-7",
        branch_anchor: { kind: "assistant_message", message_id: "asst-7" },
      },
    });
  });

  it("uses the branch draft's parent for an assistant_message fork reply", () => {
    const branchDraft: BranchDraft = {
      parentMessageId: "asst-3",
      parentMessageSeq: 4,
      parentMessagePreview: "prior answer",
      anchor: { kind: "assistant_message", message_id: "asst-3" },
    };
    const body = buildChatRunBody({ ...base, branchDraft, parentMessageId: "asst-99" });
    expect(body.destination).toEqual({
      kind: "Existing",
      conversation_id: "conv-1",
      insertion: {
        kind: "Reply",
        parent_message_id: "asst-3",
        branch_anchor: { kind: "assistant_message", message_id: "asst-3" },
      },
    });
  });

  it("passes an assistant_selection anchor through verbatim in the Reply insertion", () => {
    const anchor = {
      kind: "assistant_selection" as const,
      message_id: "asst-5",
      exact: "selected text",
      prefix: null,
      suffix: null,
      offset_status: "mapped" as const,
      start_offset: 0,
      end_offset: 13,
      client_selection_id: "sel-1",
    };
    const branchDraft: BranchDraft = {
      parentMessageId: "asst-5",
      parentMessageSeq: 6,
      parentMessagePreview: "answer",
      anchor,
    };
    const body = buildChatRunBody({ ...base, branchDraft });
    expect(body.destination).toEqual({
      kind: "Existing",
      conversation_id: "conv-1",
      insertion: { kind: "Reply", parent_message_id: "asst-5", branch_anchor: anchor },
    });
    expect(body.reader_selection).toEqual({ kind: "Absent" });
  });

  it("carries a Present reader selection (key + revision) when quoting", () => {
    const readerSelection = {
      key: { media_id: "11111111-1111-1111-1111-111111111111", highlight_id: "22222222-2222-2222-2222-222222222222" },
      revision: "a".repeat(64),
    };
    const body = buildChatRunBody({ ...base, conversationId: null, readerSelection });
    expect(body.reader_selection).toEqual({ kind: "Present", value: readerSelection });
    expect(body.destination).toEqual({ kind: "New" });
  });
});
