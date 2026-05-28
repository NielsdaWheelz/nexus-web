"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ConversationPinnedSource } from "./types";

export function usePinnedSources(conversationId: string | null) {
  const [pinned, setPinned] = useState<ConversationPinnedSource[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!conversationId) {
      setPinned([]);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    apiFetch<{ data: ConversationPinnedSource[] }>(
      `/api/conversations/${conversationId}/pinned-sources`,
    )
      .then((response) => {
        if (!cancelled) setPinned(response.data);
      })
      .catch(() => {
        if (!cancelled) setPinned([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const removePin = useCallback(
    async (ordinal: number) => {
      if (!conversationId) return;
      await apiFetch(
        `/api/conversations/${conversationId}/pinned-sources/${ordinal}`,
        { method: "DELETE" },
      );
      setPinned((current) => current.filter((p) => p.ordinal !== ordinal));
    },
    [conversationId],
  );

  return { pinned, isLoading, removePin };
}
