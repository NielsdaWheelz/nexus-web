import { describe, expect, it } from "vitest";
import { chatDraftKeyFor } from "./chatDraftKey";

describe("chatDraftKeyFor", () => {
  it("uses path:new when no path target exists", () => {
    expect(chatDraftKeyFor({ kind: "path", pathTargetId: null })).toBe("path:new");
  });

  it("uses the path target when one exists", () => {
    expect(
      chatDraftKeyFor({ kind: "path", pathTargetId: "assistant-current" }),
    ).toBe("path:assistant-current");
  });

  it("keys assistant-message branch drafts by parent message", () => {
    expect(
      chatDraftKeyFor({
        kind: "branch",
        branchDraft: {
          parentMessageId: "assistant-1",
          parentMessageSeq: 2,
          parentMessagePreview: "answer",
          anchor: { kind: "assistant_message", message_id: "assistant-1" },
        },
      }),
    ).toBe("branch:assistant-1:message");
  });

  it("keys assistant-selection branch drafts by parent message and selection id", () => {
    expect(
      chatDraftKeyFor({
        kind: "branch",
        branchDraft: {
          parentMessageId: "assistant-1",
          parentMessageSeq: 2,
          parentMessagePreview: "answer",
          anchor: {
            kind: "assistant_selection",
            message_id: "assistant-1",
            exact: "selected",
            prefix: null,
            suffix: null,
            offset_status: "unmapped",
            client_selection_id: "selection-1",
          },
        },
      }),
    ).toBe("branch:assistant-1:selection:selection-1");
  });
});
