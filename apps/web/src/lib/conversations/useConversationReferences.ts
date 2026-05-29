"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ConversationReference } from "./types";

export function useConversationReferences(conversationId: string | null) {
  const [references, setReferences] = useState<ConversationReference[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const mutate = useCallback(async () => {
    if (!conversationId) return;
    try {
      const response = await apiFetch<{ data: ConversationReference[] }>(
        `/api/conversations/${conversationId}/references`,
      );
      setReferences(response.data);
    } catch {
      // Leave previous references in place on transient errors.
    }
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) {
      setReferences([]);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    apiFetch<{ data: ConversationReference[] }>(
      `/api/conversations/${conversationId}/references`,
    )
      .then((response) => {
        if (!cancelled) setReferences(response.data);
      })
      .catch(() => {
        if (!cancelled) setReferences([]);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const removeReference = useCallback(
    async (referenceId: string) => {
      if (!conversationId) return;
      await apiFetch(
        `/api/conversations/${conversationId}/references/${referenceId}`,
        { method: "DELETE" },
      );
      setReferences((current) => current.filter((r) => r.id !== referenceId));
    },
    [conversationId],
  );

  return { references, isLoading, removeReference, mutate };
}
