"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContextItem } from "@/lib/api/sse";
import {
  getPendingContextSignature,
  parseConversationScopeFromUrl,
  parsePendingContexts,
  stripPendingContextParams,
} from "@/lib/conversations/attachedContext";

export function useAttachedContextsFromUrl(searchParams: URLSearchParams) {
  const initialAttach = useMemo(
    () => parsePendingContexts(searchParams),
    [searchParams],
  );
  const conversationScope = useMemo(
    () => parseConversationScopeFromUrl(searchParams),
    [searchParams],
  );
  const initialAttachSignature = useMemo(
    () => getPendingContextSignature(initialAttach),
    [initialAttach],
  );
  const [attachedContexts, setAttachedContexts] =
    useState<ContextItem[]>(initialAttach);
  const syncedAttachSignatureRef = useRef(initialAttachSignature);

  useEffect(() => {
    if (syncedAttachSignatureRef.current === initialAttachSignature) {
      return;
    }
    syncedAttachSignatureRef.current = initialAttachSignature;
    setAttachedContexts(initialAttach);
  }, [initialAttach, initialAttachSignature]);

  const removeContext = useCallback((index: number) => {
    setAttachedContexts((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearContexts = useCallback(() => {
    setAttachedContexts([]);
  }, []);

  const stripAttachState = useCallback(
    () => stripPendingContextParams(searchParams),
    [searchParams],
  );

  return {
    attachedContexts,
    conversationScope,
    setAttachedContexts,
    removeContext,
    clearContexts,
    stripAttachState,
  };
}
