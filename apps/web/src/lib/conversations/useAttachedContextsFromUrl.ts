"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContextItem } from "@/lib/api/sse";
import {
  getAttachContextSignature,
  parseAttachContext,
  stripAttachParams,
} from "@/lib/conversations/attachedContext";

export function useAttachedContextsFromUrl(searchParams: URLSearchParams) {
  const initialAttach = useMemo(
    () => parseAttachContext(searchParams),
    [searchParams],
  );
  const initialAttachSignature = useMemo(
    () => getAttachContextSignature(initialAttach),
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
    () => stripAttachParams(searchParams),
    [searchParams],
  );

  return {
    attachedContexts,
    setAttachedContexts,
    removeContext,
    clearContexts,
    stripAttachState,
  };
}
