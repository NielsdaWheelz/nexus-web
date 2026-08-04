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
import { conversationsInitialResource } from "@/lib/api/resource";
import type { ConversationIndexView } from "@/lib/conversations/indexView";
import type { ConversationListItem } from "@/lib/conversations/types";
import {
  expectExactRecord,
  expectNonnegativeInteger,
  expectString,
} from "@/lib/validation";

export interface ConversationIndexPageOptions {
  /** The exact chats view this page belongs to; every page of a chain shares it. */
  readonly view: ConversationIndexView;
  readonly cursor?: CollectionCursor;
  readonly collectionRevision?: CollectionRevision;
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

export async function fetchConversationIndex({
  view,
  cursor,
  collectionRevision,
  signal,
}: ConversationIndexPageOptions): Promise<
  CollectionPage<ConversationListItem>
> {
  const response = await apiFetch<unknown>(
    conversationsInitialResource.clientPath({ view, cursor, collectionRevision }),
    { cache: "no-store", signal },
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
