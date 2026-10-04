import { apiFetch } from "@/lib/api/client";
import {
  type CollectionCursor,
  type CollectionPage,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { conversationsInitialResource } from "@/lib/api/resource";
import type { ApiJson } from "@/lib/api/wire";
import type { Presence } from "@/lib/api/presence";
import type { UpdatedTitleIndexView } from "@/lib/collections/updatedTitleIndexView";
import type { ConversationListItem } from "@/lib/conversations/types";

export interface ConversationIndexPageOptions {
  /** The exact chats view this page belongs to; every page of a chain shares it. */
  readonly view: UpdatedTitleIndexView;
  readonly titleSearch?: string;
  readonly limit?: number;
  readonly cursor?: CollectionCursor;
  readonly collectionRevision?: CollectionRevision;
  readonly signal?: AbortSignal;
}

export function conversationIndexPage(
  response: ApiJson<"/conversations", "get">,
): CollectionPage<ConversationListItem> {
  if ("page" in response) {
    throw new TypeError("Conversation index received a context page");
  }
  // fastapi validates the generated cursor/revision constraints. their local
  // brands mark that accepted wire boundary; they add no row projection.
  return {
    items: response.data.items,
    nextCursor: response.data.nextCursor as Presence<CollectionCursor>,
    collectionRevision: response.data.collectionRevision as CollectionRevision,
  };
}

export async function fetchConversationIndex({
  view,
  titleSearch,
  limit,
  cursor,
  collectionRevision,
  signal,
}: ConversationIndexPageOptions): Promise<
  CollectionPage<ConversationListItem>
> {
  const response = await apiFetch<ApiJson<"/conversations", "get">>(
    conversationsInitialResource.clientPath({
      view,
      titleSearch,
      limit,
      cursor,
      collectionRevision,
    }),
    { cache: "no-store", signal },
  );
  return conversationIndexPage(response);
}
