"use client";

import { apiFetch, type ApiPath } from "@/lib/api/client";
import {
  decodeCollectionRevision,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { publishConversationIndexChange } from "@/lib/conversations/indexRevision";
import {
  expectBoolean,
  expectCanonicalUuid,
  expectExactRecord,
} from "@/lib/validation";

export interface MessageDeleteReceipt {
  readonly conversationId: string;
  readonly conversationDeleted: boolean;
  readonly collectionRevision: CollectionRevision;
}

function decodeMessageDeleteReceipt(
  raw: unknown,
  expectedConversationId: string,
): MessageDeleteReceipt {
  const envelope = expectExactRecord(raw, ["data"], "delete Message response");
  const data = expectExactRecord(
    envelope.data,
    ["conversationId", "conversationDeleted", "collectionRevision"],
    "delete Message response.data",
  );
  const conversationId = expectCanonicalUuid(
    data.conversationId,
    "delete Message response.data.conversationId",
  );
  if (conversationId !== expectedConversationId) {
    throw new TypeError(
      "delete Message response conversation identity does not match request",
    );
  }
  return {
    conversationId,
    conversationDeleted: expectBoolean(
      data.conversationDeleted,
      "delete Message response.data.conversationDeleted",
    ),
    collectionRevision: decodeCollectionRevision(data.collectionRevision),
  };
}

/** Delete one Message and publish its acknowledged Conversation-index receipt. */
export async function deleteConversationMessage(input: {
  readonly messageId: string;
  readonly conversationId: string;
}): Promise<MessageDeleteReceipt> {
  const receipt = decodeMessageDeleteReceipt(
    await apiFetch<unknown>(
      `/api/messages/${encodeURIComponent(input.messageId)}` as ApiPath,
      { method: "DELETE" },
    ),
    input.conversationId,
  );
  publishConversationIndexChange();
  return receipt;
}
