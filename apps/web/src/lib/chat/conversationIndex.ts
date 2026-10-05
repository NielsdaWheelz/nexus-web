"use client";

import { useSyncExternalStore } from "react";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import type {
  CollectionCursor,
  CollectionPage,
  CollectionRevision,
} from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import { conversationsInitialResource } from "@/lib/api/resource";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { UpdatedTitleIndexView } from "@/lib/collections/updatedTitleIndexView";
import { formatDisplayNumber, formatRelativeTime } from "@/lib/display/format";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";

// The Chats index: its pages, its deletes, and the in-tab signal that a
// committed command changed it.

export type ConversationListItem = Schema<"ConversationListItemOut">;

export function conversationIndexPage(
  response: ApiJson<"/conversations", "get">,
): CollectionPage<ConversationListItem> {
  if ("page" in response)
    throw new TypeError("Conversation index received a context page");
  // the brands mark fastapi's validated cursor and revision; they add no projection.
  return {
    items: response.data.items,
    nextCursor: response.data.nextCursor as Presence<CollectionCursor>,
    collectionRevision: response.data.collectionRevision as CollectionRevision,
  };
}

export async function fetchConversationIndex(options: {
  view: UpdatedTitleIndexView;
  titleSearch?: string;
  limit?: number;
  cursor?: CollectionCursor;
  collectionRevision?: CollectionRevision;
  signal?: AbortSignal;
}): Promise<CollectionPage<ConversationListItem>> {
  const { signal, ...params } = options;
  return conversationIndexPage(
    await apiFetch<ApiJson<"/conversations", "get">>(
      conversationsInitialResource.clientPath(params),
      { cache: "no-store", signal },
    ),
  );
}

export async function deleteConversation(
  conversationId: string,
): Promise<CollectionRevision> {
  const { data } = await apiFetch<
    ApiJson<"/conversations/{conversation_id}", "delete">
  >(`/api/conversations/${encodeURIComponent(conversationId)}` as ApiPath, {
    method: "DELETE",
  });
  publishConversationIndexChange();
  return data.collectionRevision as CollectionRevision;
}

let revision = { revision: 0 };
const listeners = new Set<() => void>();

/** Publish after a committed command changes the viewer's Chats index. */
export function publishConversationIndexChange(): void {
  revision = { revision: revision.revision + 1 };
  for (const listener of listeners) listener();
}

export function useConversationIndexRevision(): { readonly revision: number } {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => revision,
    () => revision,
  );
}

export function presentConversationListItem(
  item: Pick<ConversationListItem, "title" | "message_count" | "updated_at">,
  environment: Pick<RenderEnvironment, "displayLocale" | "currentInstant">,
): { readonly title: string; readonly metadata: string } {
  const count =
    item.message_count === 1
      ? "1 message"
      : `${formatDisplayNumber(item.message_count, environment)} messages`;
  const relative = formatRelativeTime(
    item.updated_at,
    environment,
    new Date(environment.currentInstant),
  );
  return {
    title: item.title.trim() || "Untitled chat",
    metadata: relative ? `${relative} · ${count}` : count,
  };
}
