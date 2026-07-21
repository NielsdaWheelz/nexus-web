import { describe, expect, it } from "vitest";
import { buildChatRunBody } from "./chatRunBody";
import type { BranchDraft } from "./types";

const base = {
  conversationId: "conv-1",
  content: "hello",
  profileId: "profile-1",
  reasoningOptionId: "reasoning-default",
  branchDraft: null,
  parentMessageId: null,
  chatSubject: null,
};

describe("buildChatRunBody", () => {
  it("sends no anchor and no parent for a fresh first turn", () => {
    const body = buildChatRunBody(base);
    expect(body.branch_anchor).toEqual({ kind: "none" });
    expect("parent_message_id" in body).toBe(false);
    expect(body.profile_id).toBe("profile-1");
    expect(body.reasoning_option_id).toBe("reasoning-default");
    expect(body.conversation_id).toBe("conv-1");
    expect(body).not.toHaveProperty("chat_subject");
  });

  it("anchors a plain continuation to the active assistant turn", () => {
    const body = buildChatRunBody({ ...base, parentMessageId: "asst-7" });
    expect(body.parent_message_id).toBe("asst-7");
    expect(body.branch_anchor).toEqual({
      kind: "assistant_message",
      message_id: "asst-7",
    });
  });

  it("uses the branch draft's parent for an assistant_message fork reply", () => {
    const branchDraft: BranchDraft = {
      parentMessageId: "asst-3",
      parentMessageSeq: 4,
      parentMessagePreview: "prior answer",
      anchor: { kind: "assistant_message", message_id: "asst-3" },
    };
    const body = buildChatRunBody({
      ...base,
      branchDraft,
      parentMessageId: "asst-99",
    });
    // The fork reply wins over the plain continuation parent.
    expect(body.parent_message_id).toBe("asst-3");
    expect(body.branch_anchor).toEqual({
      kind: "assistant_message",
      message_id: "asst-3",
    });
  });

  it("passes an assistant_selection anchor through verbatim", () => {
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
    expect(body.branch_anchor).toEqual(anchor);
    expect(body.parent_message_id).toBe("asst-5");
    expect("reader_selection" in body).toBe(false);
  });

  it("passes an unmapped assistant_selection anchor through without offsets", () => {
    const anchor = {
      kind: "assistant_selection" as const,
      message_id: "asst-5",
      exact: "selected text",
      prefix: null,
      suffix: null,
      offset_status: "unmapped" as const,
      client_selection_id: "sel-1",
    };
    const branchDraft: BranchDraft = {
      parentMessageId: "asst-5",
      parentMessageSeq: 6,
      parentMessagePreview: "answer",
      anchor,
    };
    const body = buildChatRunBody({ ...base, branchDraft });
    expect(body.branch_anchor).toEqual(anchor);
    const branchAnchor = body.branch_anchor;
    expect(branchAnchor).toBeDefined();
    expect("start_offset" in branchAnchor!).toBe(false);
    expect("end_offset" in branchAnchor!).toBe(false);
    expect("reader_selection" in body).toBe(false);
  });

  it("forwards the profile and reasoning-option selection verbatim", () => {
    const body = buildChatRunBody({
      ...base,
      profileId: "profile-9",
      reasoningOptionId: "reasoning-high",
    });
    expect(body.profile_id).toBe("profile-9");
    expect(body.reasoning_option_id).toBe("reasoning-high");
  });

  it("forwards the chat subject when present", () => {
    const body = buildChatRunBody({
      ...base,
      chatSubject: { resource_ref: "media:m-1" },
    });
    expect(body.chat_subject).toEqual({ resource_ref: "media:m-1" });
  });

  it("forwards the reader selection anchor when present", () => {
    const readerSelection = {
      exact: "selected text",
      media_id: "media-1",
      highlight_id: "highlight-1",
    };
    const body = buildChatRunBody({ ...base, readerSelection });
    expect(body.reader_selection).toEqual(readerSelection);
    expect(body.branch_anchor).toEqual({ kind: "none" });
  });
});
