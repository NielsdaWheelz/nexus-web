/**
 * New conversation page — fresh chat composer with optional attached context.
 *
 * Opened by quote-to-chat flows. Reads attach_* search params to pre-populate
 * context chips. On first message send the backend creates the conversation and
 * we navigate to /conversations/:id.
 */

"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import type { ContextItem } from "@/lib/api/sse";
import {
  parseAttachContext,
  stripAttachParams,
} from "@/lib/conversations/attachedContext";
import { hydrateContextItems } from "@/lib/conversations/hydrateContextItems";
import ChatComposer from "@/components/ChatComposer";
import ConversationContextPane from "@/components/ConversationContextPane";
import {
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import styles from "../page.module.css";

// ============================================================================
// Component
// ============================================================================

export default function ConversationNewPaneBody() {
  const router = usePaneRouter();
  const searchParams = usePaneSearchParams();
  useSetPaneTitle("New chat");

  const initialAttach = useMemo(
    () => parseAttachContext(searchParams),
    [searchParams],
  );
  const [attachedContexts, setAttachedContexts] =
    useState<ContextItem[]>(initialAttach);

  useEffect(() => {
    setAttachedContexts(initialAttach);
  }, [initialAttach]);

  // Hydrate context items with full data from API
  useEffect(() => {
    if (attachedContexts.length === 0) return;
    if (attachedContexts.every((c) => c.hydrated)) return;
    let cancelled = false;
    hydrateContextItems(attachedContexts)
      .then((hydrated) => {
        if (!cancelled) setAttachedContexts(hydrated);
      })
      .catch(() => {
        // Hydration is best-effort; URL-param data serves as fallback
      });
    return () => {
      cancelled = true;
    };
  }, [attachedContexts]);

  const handleRemoveContext = useCallback((index: number) => {
    setAttachedContexts((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleConversationCreated = useCallback(
    (conversationId: string) => {
      const cleaned = stripAttachParams(searchParams);
      const qs = cleaned.toString();
      router.replace(
        qs
          ? `/conversations/${conversationId}?${qs}`
          : `/conversations/${conversationId}`,
      );
    },
    [router, searchParams],
  );

  const clearAttachState = useCallback(() => {
    setAttachedContexts([]);
  }, []);

  const paneMode = searchParams.get("pane");
  if (paneMode === "context") {
    return (
      <ConversationContextPane
        contexts={attachedContexts}
        onRemoveContext={handleRemoveContext}
      />
    );
  }

  return (
    <div className={styles.paneContentChat}>
      <div className={styles.chatContainer}>
        <div className={styles.messageList} />
        <ChatComposer
          conversationId={null}
          attachedContexts={attachedContexts}
          onRemoveContext={handleRemoveContext}
          onConversationCreated={handleConversationCreated}
          onMessageSent={clearAttachState}
        />
      </div>
    </div>
  );
}
