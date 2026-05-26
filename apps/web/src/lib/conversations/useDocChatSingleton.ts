"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";

interface ChatSingletonStateResponse {
  data: {
    conversation_id: string | null;
    message_count: number;
  };
}

interface DocChatSingleton {
  conversationId: string | null;
  messageCount: number;
  isLoading: boolean;
}

/**
 * Read-only state of the viewer's doc-chat singleton for `mediaId`. Returns
 * `conversationId: null` until the first chat run lazily materializes the
 * singleton (§4.7, §7.2).
 */
export function useDocChatSingleton(mediaId: string): DocChatSingleton {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messageCount, setMessageCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    apiFetch<ChatSingletonStateResponse>(
      `/api/chat-singletons/media/${mediaId}`,
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
  }, [mediaId]);

  return { conversationId, messageCount, isLoading };
}
