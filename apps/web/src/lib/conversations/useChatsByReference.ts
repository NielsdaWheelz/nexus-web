"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ConversationListItem } from "@/lib/conversations/types";

interface ChatsByReferenceResponse {
  data: {
    conversations: ConversationListItem[];
    next_offset: number | null;
  };
}

interface ChatsByReference {
  conversations: ConversationListItem[];
  nextOffset: number | null;
  isLoading: boolean;
}

export function useChatsByReference(resourceUri: string | null): ChatsByReference {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!resourceUri) {
      setConversations([]);
      setNextOffset(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    apiFetch<ChatsByReferenceResponse>(
      `/api/conversations?has_reference=${encodeURIComponent(resourceUri)}`,
    )
      .then((response) => {
        if (cancelled) return;
        setConversations(response.data.conversations);
        setNextOffset(response.data.next_offset);
      })
      .catch(() => {
        if (cancelled) return;
        setConversations([]);
        setNextOffset(null);
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resourceUri]);

  return { conversations, nextOffset, isLoading };
}
