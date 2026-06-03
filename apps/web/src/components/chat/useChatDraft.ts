/**
 * useChatDraft - keeps a per-target draft so in-flight text survives branch/path
 * switches without leaking between contexts.
 *
 * The active draft key encodes the send target (branch selection, branch message,
 * or active path). When it changes the current text is stashed under the previous
 * key and the stored draft for the new key is restored. An explicit `initialContent`
 * change (a user action seeding the composer) overwrites the active draft.
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { chatDraftKeyFor } from "@/lib/conversations/chatDraftKey";
import type { BranchDraft } from "@/lib/conversations/types";

interface UseChatDraft {
  content: string;
  setContent: (value: string) => void;
  activeDraftKey: string;
  clearDraft: () => void;
}

export function useChatDraft({
  draftKey,
  branchDraft = null,
  parentMessageId = null,
  conversationId = null,
  initialContent = "",
}: {
  draftKey?: string;
  branchDraft?: BranchDraft | null;
  parentMessageId?: string | null;
  conversationId?: string | null;
  initialContent?: string;
}): UseChatDraft {
  const [content, setContent] = useState(initialContent);
  const draftsByKeyRef = useRef<Map<string, string>>(new Map());
  const initialContentRef = useRef(initialContent);

  const activeDraftKey = useMemo(() => {
    if (draftKey) {
      return draftKey;
    }
    if (branchDraft) {
      return chatDraftKeyFor({ kind: "branch", branchDraft });
    }
    return chatDraftKeyFor({
      kind: "path",
      pathTargetId: parentMessageId ?? conversationId,
    });
  }, [branchDraft, conversationId, draftKey, parentMessageId]);

  const activeDraftKeyRef = useRef(activeDraftKey);

  useEffect(() => {
    if (activeDraftKeyRef.current === activeDraftKey) return;

    draftsByKeyRef.current.set(activeDraftKeyRef.current, content);
    activeDraftKeyRef.current = activeDraftKey;
    setContent(draftsByKeyRef.current.get(activeDraftKey) ?? "");
  }, [activeDraftKey, content]);

  useEffect(() => {
    if (initialContentRef.current === initialContent) return;

    initialContentRef.current = initialContent;
    draftsByKeyRef.current.set(activeDraftKey, initialContent);
    setContent(initialContent);
  }, [activeDraftKey, initialContent]);

  const clearDraft = () => {
    draftsByKeyRef.current.delete(activeDraftKey);
    setContent("");
  };

  return { content, setContent, activeDraftKey, clearDraft };
}
