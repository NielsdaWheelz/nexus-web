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
import ChatComposer from "@/components/ChatComposer";
import ConversationContextPane from "@/components/ConversationContextPane";
import {
  usePaneRouter,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import { SplitSurface } from "@/components/workspace";
import SurfaceHeader from "@/components/ui/SurfaceHeader";
import styles from "../page.module.css";

// ============================================================================
// Component
// ============================================================================

export default function NewConversationPage() {
  const router = usePaneRouter();
  const searchParams = usePaneSearchParams();

  const initialAttach = useMemo(
    () => parseAttachContext(searchParams),
    [searchParams],
  );
  const [attachedContexts, setAttachedContexts] =
    useState<ContextItem[]>(initialAttach);

  useEffect(() => {
    setAttachedContexts(initialAttach);
  }, [initialAttach]);

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

  return (
    <SplitSurface
      primary={
        <div className={styles.container}>
          <div className={styles.main}>
            <SurfaceHeader
              title="New chat"
              className={styles.mainHeaderChrome}
            />
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
        </div>
      }
      secondary={
        <ConversationContextPane
          title="Linked items"
          contexts={attachedContexts}
          onRemoveContext={handleRemoveContext}
        />
      }
      secondaryTitle="Linked items"
      secondaryFabLabel="Context"
    />
  );
}
