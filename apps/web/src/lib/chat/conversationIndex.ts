"use client";

import { apiCommand204, apiFetch, type ApiPath } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { conversationsInitialResource } from "@/lib/api/resource";
import type { ListPage } from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { UpdatedTitleIndexView } from "@/lib/collections/updatedTitleIndexView";
import { formatDisplayNumber, formatRelativeTime } from "@/lib/display/format";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";

// The Chats index: its pages and its delete. Writers publish "Chats".

export type ConversationListItem = Schema<"ConversationListItemOut">;

export async function fetchConversationIndex(options: {
  view: UpdatedTitleIndexView;
  titleSearch?: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<ListPage<ConversationListItem>> {
  const { signal, ...params } = options;
  const response = await apiFetch<ApiJson<"/conversations", "get">>(
    conversationsInitialResource.clientPath(params),
    { cache: "no-store", signal },
  );
  return response.data;
}

export async function deleteConversation(
  conversationId: string,
): Promise<void> {
  await apiCommand204(
    `/api/conversations/${encodeURIComponent(conversationId)}` as ApiPath,
    {
      method: "DELETE",
    },
  );
  publishChange("Chats");
}

const chatsAboutInFlight = new Set<string>();

/**
 * A new chat seeded with `ref`; resolves its id. A second request for the same
 * ref while one is in flight resolves null. No client id yet: a retry after an
 * unknown outcome can leave an extra empty chat (docs/issues/conversation-create-has-no-client-id.md).
 */
export async function createConversationAbout(
  ref: string,
): Promise<string | null> {
  if (chatsAboutInFlight.has(ref)) return null;
  chatsAboutInFlight.add(ref);
  try {
    const response = await apiFetch<ApiJson<"/conversations", "post">>(
      "/api/conversations",
      {
        method: "POST",
        body: JSON.stringify({ initial_context_refs: [ref] }),
      },
    );
    return response.data.id;
  } finally {
    chatsAboutInFlight.delete(ref);
  }
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
