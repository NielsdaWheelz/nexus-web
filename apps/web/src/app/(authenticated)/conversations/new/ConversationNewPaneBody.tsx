/**
 * New conversation page — fresh chat composer with optional attached context.
 *
 * Opened by quote-to-chat flows. Reads attach_* search params to pre-populate
 * context chips. On first message send the backend creates the conversation and
 * we navigate to /conversations/:id.
 */

"use client";

import { useCallback } from "react";
import { useAttachedContextsFromUrl } from "@/lib/conversations/useAttachedContextsFromUrl";
import ChatComposer from "@/components/ChatComposer";
import ChatContextDrawer from "@/components/chat/ChatContextDrawer";
import ChatSurface from "@/components/chat/ChatSurface";
import ConversationContextPane from "@/components/ConversationContextPane";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import type { ChatRunResponse } from "@/lib/conversations/types";
import styles from "../page.module.css";

// ============================================================================
// Component
// ============================================================================

export default function ConversationNewPaneBody() {
  const router = usePaneRouter();
  const searchParams = usePaneSearchParams();
  useSetPaneTitle("New chat");

  const isMobileViewport = useIsMobileViewport();
  const {
    attachedContexts,
    removeContext,
    clearContexts,
    stripAttachState,
  } = useAttachedContextsFromUrl(searchParams);

  const handleChatRunCreated = useCallback(
    (runData: ChatRunResponse["data"]) => {
      const cleaned = stripAttachState();
      cleaned.set("run", runData.run.id);
      const qs = cleaned.toString();
      router.replace(`/conversations/${runData.conversation.id}?${qs}`);
    },
    [router, stripAttachState],
  );

  const clearAttachState = useCallback(() => {
    clearContexts();
  }, [clearContexts]);

  return (
    <>
      <div className={styles.chatSplitLayout}>
        <div className={styles.chatPrimaryColumn}>
          <div className={styles.paneContentChat}>
            <ChatSurface
              messages={[]}
              composer={
                <ChatComposer
                  conversationId={null}
                  attachedContexts={attachedContexts}
                  onRemoveContext={removeContext}
                  onChatRunCreated={handleChatRunCreated}
                  onMessageSent={clearAttachState}
                />
              }
            />
          </div>
        </div>

        {!isMobileViewport ? (
          <aside className={styles.chatContextColumn}>
            <ConversationContextPane
              contexts={attachedContexts}
              onRemoveContext={removeContext}
            />
          </aside>
        ) : null}
      </div>

      {isMobileViewport ? (
        <ChatContextDrawer
          contexts={attachedContexts}
          onRemoveContext={removeContext}
        />
      ) : null}
    </>
  );
}
