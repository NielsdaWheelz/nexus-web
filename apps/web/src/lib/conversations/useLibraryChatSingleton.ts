"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";

interface ChatSingletonStateResponse {
  data: {
    conversation_id: string | null;
    message_count: number;
  };
}

interface LibraryChatSingleton {
  conversationId: string | null;
  messageCount: number;
  isLoading: boolean;
}

/**
 * Read-only state of the viewer's library-chat singleton for `libraryId`.
 * Returns `conversationId: null` until the first chat run lazily materializes
 * the singleton (§4.7, §7.3).
 */
export function useLibraryChatSingleton(libraryId: string): LibraryChatSingleton {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messageCount, setMessageCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    apiFetch<ChatSingletonStateResponse>(
      `/api/chat-singletons/library/${libraryId}`,
    )
      .then((response) => {
        if (cancelled) return;
        setConversationId(response.data.conversation_id);
        setMessageCount(response.data.message_count);
      })
      .catch(() => {
        if (cancelled) return;
        setConversationId(null);
        setMessageCount(0);
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryId]);

  return { conversationId, messageCount, isLoading };
}
