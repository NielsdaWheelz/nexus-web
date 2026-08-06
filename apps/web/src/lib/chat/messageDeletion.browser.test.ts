import { afterEach, describe, expect, it, vi } from "vitest";

import { conversationIndexSnapshot } from "@/lib/conversations/indexRevision";
import { deleteConversationMessage } from "@/lib/chat/messageDeletion";

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => vi.unstubAllGlobals());

describe("Message deletion receipt", () => {
  it("strictly decodes the owning Conversation receipt then publishes once", async () => {
    const revisionBefore = conversationIndexSnapshot().revision;
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          conversationId: CONVERSATION_ID,
          conversationDeleted: true,
          collectionRevision: 29,
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      deleteConversationMessage({
        messageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
      }),
    ).resolves.toEqual({
      conversationId: CONVERSATION_ID,
      conversationDeleted: true,
      collectionRevision: 29,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(conversationIndexSnapshot().revision).toBe(revisionBefore + 1);
  });

  it("does not publish a mismatched same-system Conversation identity", async () => {
    const revisionBefore = conversationIndexSnapshot().revision;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          data: {
            conversationId: "33333333-3333-4333-8333-333333333333",
            conversationDeleted: false,
            collectionRevision: 30,
          },
        }),
      ),
    );

    await expect(
      deleteConversationMessage({
        messageId: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
      }),
    ).rejects.toThrow("conversation identity does not match request");
    expect(conversationIndexSnapshot().revision).toBe(revisionBefore);
  });
});
