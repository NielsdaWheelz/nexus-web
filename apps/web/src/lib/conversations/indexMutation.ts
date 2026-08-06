"use client";

import { apiFetch, type ApiPath } from "@/lib/api/client";
import {
  decodeCollectionRevisionOut,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { publishConversationIndexChange } from "@/lib/conversations/indexRevision";

/** Delete one chat, then publish only after its collection revision decodes. */
export async function deleteConversation(
  conversationId: string,
): Promise<CollectionRevision> {
  const response = await apiFetch<unknown>(
    `/api/conversations/${encodeURIComponent(conversationId)}` as ApiPath,
    { method: "DELETE" },
  );
  const collectionRevision = decodeCollectionRevisionOut(response);
  publishConversationIndexChange();
  return collectionRevision;
}
