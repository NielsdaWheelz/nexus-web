import { describe, expect, it } from "vitest";
import {
  chatDraftKeyFor,
  serializeChatDraftKey,
} from "@/lib/conversations/chatDraftKey";
import type { PaneVisitId } from "@/lib/workspace/schema";
import type { BranchDraft } from "@/lib/conversations/types";

// Risk: new-chat draft identity (spec §5.2, AC-3). Oracle: the documented key
// shapes — a new-chat destination is identified by its pane visit, never route
// text, so two independent new-chat visits get distinct drafts.

const visit = (id: string): PaneVisitId => id as unknown as PaneVisitId;

const messageDraft: BranchDraft = {
  parentMessageId: "assistant-1",
  parentMessageSeq: 4,
  parentMessagePreview: "prev",
  anchor: { kind: "assistant_message", message_id: "assistant-1" },
};

const selectionDraft: BranchDraft = {
  parentMessageId: "assistant-1",
  parentMessageSeq: 4,
  parentMessagePreview: "prev",
  anchor: {
    kind: "assistant_selection",
    message_id: "assistant-1",
    exact: "quoted",
    prefix: null,
    suffix: null,
    offset_status: "mapped",
    start_offset: 0,
    end_offset: 6,
    client_selection_id: "sel-9",
  },
};

describe("chatDraftKeyFor", () => {
  it("keys a new-chat destination by its pane visit, distinctly per visit", () => {
    const first = chatDraftKeyFor({
      kind: "NewConversation",
      visitId: visit("11111111-1111-4111-8111-111111111111"),
    });
    const second = chatDraftKeyFor({
      kind: "NewConversation",
      visitId: visit("22222222-2222-4222-8222-222222222222"),
    });
    expect(first).toEqual({
      kind: "NewConversation",
      visitId: "11111111-1111-4111-8111-111111111111",
    });
    // AC-3: two new-chat pane visits have different structured draft keys.
    expect(serializeChatDraftKey(first)).not.toBe(serializeChatDraftKey(second));
    expect(serializeChatDraftKey(first)).toBe(
      "new:11111111-1111-4111-8111-111111111111",
    );
  });

  it("keys an existing conversation path by its target id", () => {
    const key = chatDraftKeyFor({ kind: "Path", targetId: "conversation-7" });
    expect(key).toEqual({ kind: "Path", targetId: "conversation-7" });
    expect(serializeChatDraftKey(key)).toBe("path:conversation-7");
  });

  it("maps a branch-message anchor to a distinct key from a branch selection", () => {
    const messageKey = chatDraftKeyFor({ kind: "Branch", branchDraft: messageDraft });
    const selectionKey = chatDraftKeyFor({ kind: "Branch", branchDraft: selectionDraft });
    expect(serializeChatDraftKey(messageKey)).toBe("branch:assistant-1:message");
    expect(serializeChatDraftKey(selectionKey)).toBe(
      "branch:assistant-1:selection:sel-9",
    );
  });

  it("gives two selections on the same parent distinct draft keys", () => {
    const other: BranchDraft = {
      parentMessageId: "assistant-1",
      parentMessageSeq: 4,
      parentMessagePreview: "prev",
      anchor: {
        kind: "assistant_selection",
        message_id: "assistant-1",
        exact: "quoted",
        prefix: null,
        suffix: null,
        offset_status: "mapped",
        start_offset: 0,
        end_offset: 6,
        client_selection_id: "sel-10",
      },
    };
    expect(
      serializeChatDraftKey(chatDraftKeyFor({ kind: "Branch", branchDraft: other })),
    ).not.toBe(
      serializeChatDraftKey(
        chatDraftKeyFor({ kind: "Branch", branchDraft: selectionDraft }),
      ),
    );
  });
});
