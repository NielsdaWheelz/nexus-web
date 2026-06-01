import { describe, expect, it } from "vitest";
import { buildChatRunBody } from "./chatRunBody";
import type { BranchDraft } from "./types";

const base = {
  conversationId: "conv-1",
  content: "hello",
  modelId: "model-1",
  reasoning: "default" as const,
  onlyUseMyKeys: false,
  branchDraft: null,
  parentMessageId: null,
  readerContext: null,
};

describe("buildChatRunBody", () => {
  it("sends no anchor and no parent for a fresh first turn", () => {
    const body = buildChatRunBody(base);
    expect(body.branch_anchor).toEqual({ kind: "none" });
    expect("parent_message_id" in body).toBe(false);
    expect(body.key_mode).toBe("auto");
    expect(body.conversation_id).toBe("conv-1");
    expect(body.reader_context).toBeNull();
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
  });

  it("sets key_mode to byok_only when the user pins their own keys", () => {
    expect(buildChatRunBody({ ...base, onlyUseMyKeys: true }).key_mode).toBe(
      "byok_only",
    );
  });

  it("forwards the reader context hint", () => {
    const body = buildChatRunBody({
      ...base,
      readerContext: { media_id: "m-1", library_id: null },
    });
    expect(body.reader_context).toEqual({ media_id: "m-1", library_id: null });
  });

  it("forwards the reader selection anchor when present", () => {
    const readerSelection = {
      exact: "selected text",
      media_id: "media-1",
      highlight_id: "highlight-1",
    };
    const body = buildChatRunBody({ ...base, readerSelection });
    expect(body.reader_selection).toEqual(readerSelection);
  });
});
