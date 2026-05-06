/**
 * New conversation page — fresh chat composer with optional attached context.
 *
 * Opened by quote-to-chat flows. Reads typed context ids from search params.
 * On first message send the backend creates the conversation, the pane streams
 * locally immediately, then the URL is replaced with /conversations/:id.
 */

"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useAttachedContextsFromUrl } from "@/lib/conversations/useAttachedContextsFromUrl";
import {
  parseConversationScopeFromUrl,
  setConversationScopeParam,
} from "@/lib/conversations/attachedContext";
import ChatComposer from "@/components/ChatComposer";
import ChatContextDrawer from "@/components/chat/ChatContextDrawer";
import ChatSurface from "@/components/chat/ChatSurface";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import ConversationContextPane from "@/components/ConversationContextPane";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import type {
  ChatRunResponse,
  ConversationMessage,
} from "@/lib/conversations/types";
import styles from "../page.module.css";

// ============================================================================
// Component
// ============================================================================

export default function ConversationNewPaneBody() {
  const router = usePaneRouter();
  const searchParams = usePaneSearchParams();
  const draft = searchParams.get("draft") ?? "";
  const scrollportRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const conversationScope = parseConversationScopeFromUrl(searchParams);
  useSetPaneTitle(
    conversationScope.type === "media"
      ? "Chat: Document"
      : conversationScope.type === "library"
        ? "Chat: Library"
        : "New chat",
  );

  const isMobileViewport = useIsMobileViewport();
  const {
    attachedContexts,
    removeContext,
    clearContexts,
    stripAttachState,
  } = useAttachedContextsFromUrl(searchParams);
  const { tailChatRun } = useChatRunTail({ setMessages, shouldScrollRef });

  useLayoutEffect(() => {
    if (!scrollportRef.current || !shouldScrollRef.current) return;
    scrollportRef.current.scrollTop = scrollportRef.current.scrollHeight;
  }, [messages]);

  const handleChatScroll = useCallback(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return;
    shouldScrollRef.current =
      scrollport.scrollHeight - scrollport.scrollTop - scrollport.clientHeight <= 48;
  }, []);

  const handleChatRunCreated = useCallback(
    (runData: ChatRunResponse["data"]) => {
      shouldScrollRef.current = true;
      void tailChatRun(runData);
      const cleaned = stripAttachState();
      cleaned.delete("draft");
      cleaned.set("run", runData.run.id);
      const qs = cleaned.toString();
      router.replace(`/conversations/${runData.conversation.id}?${qs}`);
    },
    [router, stripAttachState, tailChatRun],
  );

  const clearAttachState = useCallback(() => {
    clearContexts();
  }, [clearContexts]);

  const clearConversationScope = useCallback(() => {
    const cleaned = setConversationScopeParam(searchParams, { type: "general" });
    const qs = cleaned.toString();
    router.replace(qs ? `/conversations/new?${qs}` : `/conversations/new`);
  }, [router, searchParams]);

  return (
    <>
      <div className={styles.chatSplitLayout}>
        <div className={styles.chatPrimaryColumn}>
          <div className={styles.paneContentChat}>
            <ChatSurface
              messages={messages}
              scope={conversationScope}
              scrollportRef={scrollportRef}
              onScroll={handleChatScroll}
              composer={
                <ChatComposer
                  conversationId={null}
                  conversationScope={conversationScope}
                  attachedContexts={attachedContexts}
                  onRemoveContext={removeContext}
                  onChatRunCreated={handleChatRunCreated}
                  onMessageSent={clearAttachState}
                  initialContent={draft}
                  onClearScope={
                    conversationScope.type === "general"
                      ? undefined
                      : clearConversationScope
                  }
                />
              }
            />
          </div>
        </div>

        {!isMobileViewport ? (
          <aside className={styles.chatContextColumn}>
            <ConversationContextPane
              scope={conversationScope}
              contexts={attachedContexts}
              onRemoveContext={removeContext}
            />
          </aside>
        ) : null}
      </div>

      {isMobileViewport ? (
        <ChatContextDrawer
          scope={conversationScope}
          contexts={attachedContexts}
          onRemoveContext={removeContext}
        />
      ) : null}
    </>
  );
}
