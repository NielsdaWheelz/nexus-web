"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";

export type ConversationSingletonKind = "media" | "library";

interface ChatSingletonStateResponse {
  data: {
    conversation_id: string | null;
    message_count: number;
  };
}

interface ConversationSingleton {
  conversationId: string | null;
  messageCount: number;
  isLoading: boolean;
}

/**
 * Read-only state of the viewer's singleton conversation for (kind, targetId).
 * Returns conversationId=null until the first chat run lazily materializes the
 * singleton.
 */
export function useConversationSingleton(
  kind: ConversationSingletonKind,
  targetId: string,
): ConversationSingleton {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messageCount, setMessageCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    apiFetch<ChatSingletonStateResponse>(`/api/chat-singletons/${kind}/${targetId}`)
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
  }, [kind, targetId]);

  return { conversationId, messageCount, isLoading };
}
