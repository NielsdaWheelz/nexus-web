import { afterEach, describe, expect, it, vi } from "vitest";

import { conversationIndexSnapshot } from "@/lib/conversations/indexRevision";
import { deleteConversation } from "@/lib/conversations/indexMutation";

describe("Conversation index mutation completion", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("publishes one index change after the delete revision decodes", async () => {
    const before = conversationIndexSnapshot().revision;
    const conversationId = "01988c00-91d0-7499-a0a6-b8798dc08c68";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(`/api/conversations/${conversationId}`);
        expect(init?.method).toBe("DELETE");
        return Response.json({ data: { collectionRevision: 17 } });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteConversation(conversationId)).resolves.toBe(17);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(conversationIndexSnapshot().revision).toBe(before + 1);
  });
});
