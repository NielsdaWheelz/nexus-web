"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ConversationListItem } from "@/lib/conversations/types";

interface ChatReferencesResponse {
  data: {
    conversations: ConversationListItem[];
    next_offset: number | null;
  };
}

interface DocReferencingChats {
  conversations: ConversationListItem[];
  nextOffset: number | null;
  isLoading: boolean;
}

/**
 * List of non-singleton conversations whose messages reference `mediaId`
 * (§4.6, §7.4). Excludes the viewer's doc-chat singleton for the same media.
 */
export function useDocReferencingChats(mediaId: string): DocReferencingChats {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    apiFetch<ChatReferencesResponse>(
      `/api/chat-references/media/${mediaId}`,
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
  }, [mediaId]);

  return { conversations, nextOffset, isLoading };
}
