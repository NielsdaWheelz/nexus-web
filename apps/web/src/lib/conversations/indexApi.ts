import {
  apiFetch,
  type ApiPath,
} from "@/lib/api/client";
import {
  decodeCollectionPage,
  decodeCollectionRevisionOut,
  type CollectionCursor,
  type CollectionPage,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import type { ConversationListItem } from "@/lib/conversations/types";
import {
  expectExactRecord,
  expectNonnegativeInteger,
  expectString,
} from "@/lib/validation";

export type ConversationIndexScope = "mine" | "all" | "shared";

export interface ConversationIndexPageOptions {
  readonly scope?: ConversationIndexScope;
  readonly cursor?: CollectionCursor;
  readonly collectionRevision?: CollectionRevision;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export function decodeConversationIndexItem(
  raw: unknown,
  index = 0,
): ConversationListItem {
  const name = `ConversationIndex.items[${index}]`;
  const item = expectExactRecord(
    raw,
    ["id", "title", "message_count", "updated_at"],
    name,
  );
  const id = expectString(item.id, `${name}.id`);
  const title = expectString(item.title, `${name}.title`);
  const messageCount = expectNonnegativeInteger(
    item.message_count,
    `${name}.message_count`,
  );
  const updatedAt = expectString(item.updated_at, `${name}.updated_at`);
  if (
    id.length === 0 ||
    !Number.isSafeInteger(messageCount) ||
    updatedAt.length === 0 ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    throw new TypeError(`${name} contains invalid row facts`);
  }
  return {
    id,
    title,
    message_count: messageCount,
    updated_at: updatedAt,
  };
}

export async function fetchConversationIndex(
  options: ConversationIndexPageOptions = {},
): Promise<CollectionPage<ConversationListItem>> {
  const params = new URLSearchParams();
  if (options.scope) params.set("scope", options.scope);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.collectionRevision !== undefined) {
    params.set("collection_revision", String(options.collectionRevision));
  }
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const suffix = params.toString();
  const response = await apiFetch<unknown>(
    `/api/conversations${suffix ? `?${suffix}` : ""}` as ApiPath,
    { cache: "no-store", signal: options.signal },
  );
  return decodeCollectionPage(response, decodeConversationIndexItem);
}

export async function deleteConversation(
  conversationId: string,
): Promise<CollectionRevision> {
  const response = await apiFetch<unknown>(
    `/api/conversations/${encodeURIComponent(conversationId)}` as ApiPath,
    { method: "DELETE" },
  );
  return decodeCollectionRevisionOut(response);
}
