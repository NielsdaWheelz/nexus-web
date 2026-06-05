"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, type ApiPath } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useResource } from "@/lib/api/useResource";
import { isAbortError } from "@/lib/errors";
import { compareStableString } from "@/lib/display/format";
import type { ConversationReference } from "./types";

export function useConversationReferences(conversationId: string | null) {
  const [references, setReferences] = useState<ConversationReference[]>([]);
  const conversationIdRef = useRef(conversationId);
  const refreshSeqRef = useRef(0);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const ignoreResourceForConversationRef = useRef<string | null>(null);
  conversationIdRef.current = conversationId;
  const referencesResource = useResource<{ data: ConversationReference[] }>({
    cacheKey: conversationId,
    path: (id) => `/api/conversations/${id}/references` as ApiPath,
  });

  const refreshReferences = useCallback(
    async (nextConversationId: string) => {
      const refreshSeq = refreshSeqRef.current + 1;
      refreshSeqRef.current = refreshSeq;
      refreshControllerRef.current?.abort();
      const controller = new AbortController();
      refreshControllerRef.current = controller;
      ignoreResourceForConversationRef.current = nextConversationId;
      try {
        const response = await apiFetch<{ data: ConversationReference[] }>(
          `/api/conversations/${nextConversationId}/references`,
          { signal: controller.signal },
        );
        if (
          controller.signal.aborted ||
          refreshSeqRef.current !== refreshSeq ||
          conversationIdRef.current !== nextConversationId
        ) {
          return;
        }
        setReferences(response.data);
      } catch (err) {
        if (
          isAbortError(err) ||
          controller.signal.aborted ||
          refreshSeqRef.current !== refreshSeq ||
          conversationIdRef.current !== nextConversationId
        ) {
          return;
        }
        handleUnauthenticatedApiError(err);
      } finally {
        if (refreshControllerRef.current === controller) {
          refreshControllerRef.current = null;
        }
      }
    },
    [],
  );

  const mutate = useCallback(async () => {
    if (!conversationId) return;
    await refreshReferences(conversationId);
  }, [conversationId, refreshReferences]);

  useEffect(() => {
    refreshSeqRef.current += 1;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    ignoreResourceForConversationRef.current = null;
    setReferences([]);
  }, [conversationId]);

  useEffect(() => {
    if (
      !conversationId ||
      ignoreResourceForConversationRef.current === conversationId
    ) {
      return;
    }
    if (referencesResource.status === "ready") {
      setReferences(referencesResource.data.data);
      return;
    }
    if (referencesResource.status === "error") {
      setReferences([]);
    }
  }, [conversationId, referencesResource]);

  const removeReference = useCallback(
    async (referenceId: string) => {
      if (!conversationId) return;
      refreshSeqRef.current += 1;
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      ignoreResourceForConversationRef.current = conversationId;
      await apiFetch(
        `/api/conversations/${conversationId}/references/${referenceId}`,
        { method: "DELETE" },
      );
      setReferences((current) => current.filter((r) => r.id !== referenceId));
    },
    [conversationId],
  );

  const upsertReference = useCallback((reference: ConversationReference) => {
    if (conversationIdRef.current) {
      ignoreResourceForConversationRef.current = conversationIdRef.current;
    }
    setReferences((current) => {
      const index = current.findIndex((item) => item.id === reference.id);
      if (index >= 0) {
        return current.map((item, idx) => (idx === index ? reference : item));
      }
      return [...current, reference].sort((left, right) => {
        if (left.created_at !== right.created_at) {
          return compareStableString(left.created_at, right.created_at);
        }
        return compareStableString(left.id, right.id);
      });
    });
  }, []);

  return {
    references,
    isLoading:
      referencesResource.status === "loading" &&
      ignoreResourceForConversationRef.current !== conversationId,
    removeReference,
    mutate,
    upsertReference,
  };
}
