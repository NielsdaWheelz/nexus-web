import { describe, expect, it } from "vitest";
import type { ConversationMessage } from "@/lib/conversations/types";
import {
  createConversationFindSnapshot,
  findConversationOccurrences,
} from "@/lib/conversations/conversationFind";

const timestamp = "2026-07-29T00:00:00Z";

function message({
  id,
  seq,
  role,
  blocks,
}: {
  readonly id: string;
  readonly seq: number;
  readonly role: ConversationMessage["role"];
  readonly blocks: readonly string[];
}): ConversationMessage {
  return {
    id,
    seq,
    role,
    message_document: {
      type: "message_document",
      blocks: blocks.map((text) => ({
        type: "text",
        format: role === "assistant" ? "markdown" : "plain",
        text,
      })),
    },
    trust_trail: null,
    status: "complete",
    can_rerun: false,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

describe("Conversation Find", () => {
  it("returns literal non-overlapping occurrences in message, block, and offset order", () => {
    const snapshot = createConversationFindSnapshot({
      conversationId: "conversation-1",
      activeLeafMessageId: "assistant-1",
      messages: [
        message({
          id: "user-1",
          seq: 1,
          role: "user",
          blocks: ["Alpha alpha alpha"],
        }),
        message({
          id: "assistant-1",
          seq: 2,
          role: "assistant",
          blocks: ["alpha", "alpha"],
        }),
      ],
    });

    const result = findConversationOccurrences({
      snapshot,
      query: "alpha",
      matchCase: false,
      wholeWord: false,
    });

    expect(result.kind).toBe("Ready");
    if (result.kind !== "Ready") return;
    expect(
      result.occurrences.map(
        ({ messageId, blockIndex, start, end, row }) => ({
          messageId,
          blockIndex,
          start,
          end,
          context: row.context,
          snippet: row.snippet,
        }),
      ),
    ).toEqual([
      {
        messageId: "user-1",
        blockIndex: 0,
        start: 0,
        end: 5,
        context: ["Your message", "Message 1"],
        snippet: [
          { text: "Alpha", emphasized: true },
          { text: " alpha alpha", emphasized: false },
        ],
      },
      {
        messageId: "user-1",
        blockIndex: 0,
        start: 6,
        end: 11,
        context: ["Your message", "Message 1"],
        snippet: [
          { text: "Alpha ", emphasized: false },
          { text: "alpha", emphasized: true },
          { text: " alpha", emphasized: false },
        ],
      },
      {
        messageId: "user-1",
        blockIndex: 0,
        start: 12,
        end: 17,
        context: ["Your message", "Message 1"],
        snippet: [
          { text: "Alpha alpha ", emphasized: false },
          { text: "alpha", emphasized: true },
        ],
      },
      {
        messageId: "assistant-1",
        blockIndex: 0,
        start: 0,
        end: 5,
        context: ["Assistant response", "Message 2"],
        snippet: [{ text: "alpha", emphasized: true }],
      },
      {
        messageId: "assistant-1",
        blockIndex: 1,
        start: 0,
        end: 5,
        context: ["Assistant response", "Message 2"],
        snippet: [{ text: "alpha", emphasized: true }],
      },
    ]);
    expect(new Set(result.occurrences.map(({ key }) => key)).size).toBe(5);
  });

  it("keeps case, accents, whole-word boundaries, and block boundaries exact", () => {
    const snapshot = createConversationFindSnapshot({
      conversationId: "conversation-1",
      activeLeafMessageId: null,
      messages: [
        message({
          id: "user-1",
          seq: 1,
          role: "user",
          blocks: ["Cat cat scatter café İ", "cat"],
        }),
      ],
    });

    const exactCase = findConversationOccurrences({
      snapshot,
      query: "Cat",
      matchCase: true,
      wholeWord: true,
    });
    const foldedWholeWord = findConversationOccurrences({
      snapshot,
      query: "cat",
      matchCase: false,
      wholeWord: true,
    });
    const accentPreserved = findConversationOccurrences({
      snapshot,
      query: "cafe",
      matchCase: false,
      wholeWord: false,
    });
    const expandingFoldRejected = findConversationOccurrences({
      snapshot,
      query: "i",
      matchCase: false,
      wholeWord: true,
    });

    expect(exactCase.kind === "Ready" && exactCase.occurrences.length).toBe(1);
    expect(
      foldedWholeWord.kind === "Ready" &&
        foldedWholeWord.occurrences.map(
          ({ blockIndex, start }) => `${blockIndex}:${start}`,
        ),
    ).toEqual(["0:0", "0:4", "1:0"]);
    expect(accentPreserved).toEqual({ kind: "NoMatches" });
    expect(expandingFoldRejected).toEqual({ kind: "NoMatches" });
  });

  it("changes the source and result identities with transcript content or active branch", () => {
    const base = [
      message({
        id: "user-1",
        seq: 1,
        role: "user",
        blocks: ["same text"],
      }),
    ];
    const first = createConversationFindSnapshot({
      conversationId: "conversation-1",
      activeLeafMessageId: "leaf-a",
      messages: base,
    });
    const changedBranch = createConversationFindSnapshot({
      conversationId: "conversation-1",
      activeLeafMessageId: "leaf-b",
      messages: base,
    });
    const changedText = createConversationFindSnapshot({
      conversationId: "conversation-1",
      activeLeafMessageId: "leaf-a",
      messages: [
        message({
          id: "user-1",
          seq: 1,
          role: "user",
          blocks: ["same text changed"],
        }),
      ],
    });

    expect(changedBranch.sourceKey).not.toBe(first.sourceKey);
    expect(changedText.sourceKey).not.toBe(first.sourceKey);
    const firstResult = findConversationOccurrences({
      snapshot: first,
      query: "same",
      matchCase: false,
      wholeWord: false,
    });
    const changedResult = findConversationOccurrences({
      snapshot: changedText,
      query: "same",
      matchCase: false,
      wholeWord: false,
    });
    expect(firstResult.kind).toBe("Ready");
    expect(changedResult.kind).toBe("Ready");
    if (firstResult.kind !== "Ready" || changedResult.kind !== "Ready") return;
    expect(changedResult.occurrences[0]!.key).not.toBe(
      firstResult.occurrences[0]!.key,
    );
  });

  it("scopes a result key to its owning message revision, not unrelated transcript text", () => {
    const snapshot = createConversationFindSnapshot({
      conversationId: "conversation-1",
      activeLeafMessageId: "assistant-1",
      messages: [
        message({
          id: "user-1",
          seq: 1,
          role: "user",
          blocks: ["needle"],
        }),
        message({
          id: "assistant-1",
          seq: 2,
          role: "assistant",
          blocks: ["UNRELATED_SECRET_TRANSCRIPT_TEXT"],
        }),
      ],
    });
    const result = findConversationOccurrences({
      snapshot,
      query: "needle",
      matchCase: false,
      wholeWord: false,
    });

    expect(result.kind).toBe("Ready");
    if (result.kind !== "Ready") return;
    expect(result.occurrences[0]!.key).not.toContain(
      "UNRELATED_SECRET_TRANSCRIPT_TEXT",
    );
    expect(result.occurrences[0]!.key).toContain("needle");
  });

  it("includes block format in the frozen source revision", () => {
    const plainMessage = message({
      id: "user-1",
      seq: 1,
      role: "user",
      blocks: ["**needle**"],
    });
    const markdownMessage: ConversationMessage = {
      ...plainMessage,
      message_document: {
        type: "message_document",
        blocks: [
          { type: "text", format: "markdown", text: "**needle**" },
        ],
      },
    };
    const plain = createConversationFindSnapshot({
      conversationId: "conversation-1",
      activeLeafMessageId: null,
      messages: [plainMessage],
    });
    const markdown = createConversationFindSnapshot({
      conversationId: "conversation-1",
      activeLeafMessageId: null,
      messages: [markdownMessage],
    });

    expect(markdown.sourceKey).not.toBe(plain.sourceKey);
  });
});
