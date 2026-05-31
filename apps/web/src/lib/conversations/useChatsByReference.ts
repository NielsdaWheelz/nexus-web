"use client";

import { useMemo } from "react";
import type { ApiPath } from "@/lib/api/client";
import { useApiResource } from "@/lib/api/useApiResource";
import type { ConversationListItem } from "@/lib/conversations/types";

interface ChatsByReferenceResponse {
  data: ConversationListItem[];
}

export function useChatsByReference(resourceUri: string | null): {
  conversations: ConversationListItem[];
  isLoading: boolean;
} {
  const conversationsPath = useMemo<ApiPath | null>(
    () =>
      resourceUri
        ? `/api/conversations?has_reference=${encodeURIComponent(resourceUri)}`
        : null,
    [resourceUri],
  );
  const conversationsResource = useApiResource<ChatsByReferenceResponse>({
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
