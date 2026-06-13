"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiPath } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useResource } from "@/lib/api/useResource";
import { isAbortError } from "@/lib/errors";
import { compareStableString } from "@/lib/display/format";
import {
  listContextRefs,
  removeContextRef,
  type ContextRefOut,
} from "@/lib/resourceGraph/contextRefs";

export function useConversationContextRefs(conversationId: string | null) {
  const [contextRefs, setContextRefs] = useState<ContextRefOut[]>([]);
  const conversationIdRef = useRef(conversationId);
  const refreshSeqRef = useRef(0);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const ignoreResourceForConversationRef = useRef<string | null>(null);
  conversationIdRef.current = conversationId;
  const contextRefsResource = useResource<{ data: ContextRefOut[] }>({
    cacheKey: conversationId,
    path: (id) => `/api/conversations/${id}/context-refs` as ApiPath,
  });

  const refreshContextRefs = useCallback(
    async (nextConversationId: string) => {
      const refreshSeq = refreshSeqRef.current + 1;
      refreshSeqRef.current = refreshSeq;
      refreshControllerRef.current?.abort();
      const controller = new AbortController();
      refreshControllerRef.current = controller;
      ignoreResourceForConversationRef.current = nextConversationId;
      try {
        const data = await listContextRefs(nextConversationId, {
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          refreshSeqRef.current !== refreshSeq ||
          conversationIdRef.current !== nextConversationId
        ) {
          return;
        }
        setContextRefs(data);
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
    await refreshContextRefs(conversationId);
  }, [conversationId, refreshContextRefs]);

  useEffect(() => {
    refreshSeqRef.current += 1;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    ignoreResourceForConversationRef.current = null;
    setContextRefs([]);
  }, [conversationId]);

  useEffect(() => {
    if (
      !conversationId ||
      ignoreResourceForConversationRef.current === conversationId
    ) {
      return;
    }
    if (contextRefsResource.status === "ready") {
      setContextRefs(contextRefsResource.data.data);
      return;
    }
    if (contextRefsResource.status === "error") {
      setContextRefs([]);
    }
  }, [contextRefsResource, conversationId]);

  const removeContextRefById = useCallback(
    async (edgeId: string) => {
      if (!conversationId) return;
      refreshSeqRef.current += 1;
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      ignoreResourceForConversationRef.current = conversationId;
      await removeContextRef(conversationId, edgeId);
      setContextRefs((current) => current.filter((r) => r.id !== edgeId));
    },
    [conversationId],
  );

  const upsertContextRef = useCallback((contextRef: ContextRefOut) => {
    if (conversationIdRef.current) {
      ignoreResourceForConversationRef.current = conversationIdRef.current;
    }
    setContextRefs((current) => {
      const index = current.findIndex((item) => item.id === contextRef.id);
      if (index >= 0) {
        return current.map((item, idx) => (idx === index ? contextRef : item));
      }
      return [...current, contextRef].sort((left, right) => {
        if (left.created_at !== right.created_at) {
          return compareStableString(left.created_at, right.created_at);
        }
        return compareStableString(left.id, right.id);
      });
    });
  }, []);

  return {
    contextRefs,
    isLoading:
      contextRefsResource.status === "loading" &&
      ignoreResourceForConversationRef.current !== conversationId,
    removeContextRef: removeContextRefById,
    mutate,
    upsertContextRef,
  };
}
