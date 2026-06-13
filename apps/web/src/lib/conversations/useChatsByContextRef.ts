"use client";

import { useMemo } from "react";
import type { ApiPath } from "@/lib/api/client";
import { useResource } from "@/lib/api/useResource";
import type { ConversationListItem } from "@/lib/conversations/types";

interface ChatsByContextRefResponse {
  data: ConversationListItem[];
}

export function useChatsByContextRef(resourceUri: string | null): {
  conversations: ConversationListItem[];
  isLoading: boolean;
} {
  const conversationsPath = useMemo<ApiPath | null>(
    () =>
      resourceUri
        ? `/api/conversations?has_context_ref=${encodeURIComponent(resourceUri)}`
        : null,
    [resourceUri],
  );
  const conversationsResource = useResource<ChatsByContextRefResponse>({
    cacheKey: conversationsPath,
    path: (path) => path as ApiPath,
  });

  return {
    conversations:
      conversationsResource.status === "ready"
        ? conversationsResource.data.data
        : [],
    isLoading: conversationsResource.status === "loading",
  };
}
