"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ConversationListItem } from "@/lib/conversations/types";

interface ChatsByReferenceResponse {
  data: ConversationListItem[];
}

export function useChatsByReference(resourceUri: string | null): {
  conversations: ConversationListItem[];
  isLoading: boolean;
} {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!resourceUri) {
      setConversations([]);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    apiFetch<ChatsByReferenceResponse>(
      `/api/conversations?has_reference=${encodeURIComponent(resourceUri)}`,
    )
      .then((response) => {
        if (cancelled) return;
        setConversations(response.data);
      })
      .catch(() => {
        if (cancelled) return;
        setConversations([]);
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resourceUri]);

  return { conversations, isLoading };
}
