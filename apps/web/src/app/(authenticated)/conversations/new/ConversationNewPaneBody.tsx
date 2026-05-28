/**
 * New conversation page — fresh chat composer with optional attached context.
 *
 * Opened by quote-to-chat flows. Reads typed context ids from search params.
 * On first message send the backend creates a general (non-singleton)
 * conversation, the pane streams locally immediately, then the URL is replaced
 * with /conversations/:id. Singleton (doc/library) chats have their own
 * dedicated routes — they never come through here.
 */

"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PanelRightOpen } from "lucide-react";
import { useAttachedContextsFromUrl } from "@/lib/conversations/useAttachedContextsFromUrl";
import ChatComposer from "@/components/ChatComposer";
import ChatContextDrawer from "@/components/chat/ChatContextDrawer";
import ChatSurface from "@/components/chat/ChatSurface";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import ConversationContextPane from "@/components/ConversationContextPane";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import SecondaryRail, {
  SECONDARY_RAIL_COLLAPSED_WIDTH_PX,
} from "@/components/secondaryRail/SecondaryRail";
import Button from "@/components/ui/Button";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import type {
  ChatRunResponse,
  ConversationMessage,
} from "@/lib/conversations/types";
import styles from "../page.module.css";

const CHAT_CONTEXT_RAIL_WIDTH_PX = 320;

// ============================================================================
// Component
// ============================================================================

export default function ConversationNewPaneBody() {
  const router = usePaneRouter();
  const paneRuntime = usePaneRuntime();
  const searchParams = usePaneSearchParams();
  const draft = searchParams.get("draft") ?? "";
  const scrollportRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [contextRailExpanded, setContextRailExpanded] = useState(true);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [resolveError, setResolveError] = useState<FeedbackContent | null>(
    null,
  );
  const activeReplyParentMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && message.status === "complete") {
        return message.id;
      }
    }
    return null;
  }, [messages]);
  useSetPaneTitle("New chat");

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

  const handleSendStarted = useCallback(() => {
    setResolveError(null);
  }, []);

  const handleChatScroll = useCallback(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return;
    shouldScrollRef.current =
      scrollport.scrollHeight -
        scrollport.scrollTop -
        scrollport.clientHeight <=
      48;
  }, []);

  const handleChatRunCreated = useCallback(
    (runData: ChatRunResponse["data"]) => {
      shouldScrollRef.current = true;
      setActiveConversationId(runData.conversation.id);
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

  const handleReaderSourceActivate = useCallback(
    (target: ReaderSourceTarget) => {
      router.push(target.href || `/media/${target.media_id}`);
    },
    [router],
  );

  useEffect(() => {
    if (!paneRuntime) return;
    if (isMobileViewport) {
      paneRuntime.setPaneExtraWidth(0);
      return;
    }
    paneRuntime.setPaneExtraWidth(
      contextRailExpanded
        ? CHAT_CONTEXT_RAIL_WIDTH_PX
        : SECONDARY_RAIL_COLLAPSED_WIDTH_PX
    );
    return () => {
      paneRuntime.setPaneExtraWidth(0);
    };
  }, [contextRailExpanded, isMobileViewport, paneRuntime]);

  return (
    <>
      <div className={styles.chatSplitLayout}>
        <div className={styles.chatPrimaryColumn}>
          <div className={styles.paneContentChat}>
            <ChatSurface
              messages={messages}
              onReaderSourceActivate={handleReaderSourceActivate}
              scrollportRef={scrollportRef}
              onScroll={handleChatScroll}
              composer={
                <ChatComposer
                  conversationId={activeConversationId}
                  attachedContexts={attachedContexts}
                  parentMessageId={activeReplyParentMessageId}
                  onRemoveContext={removeContext}
                  onChatRunCreated={handleChatRunCreated}
                  onMessageSent={clearAttachState}
                  onSendStarted={handleSendStarted}
                  initialContent={draft}
                  draftKey="new-conversation"
                />
              }
              emptyState={
                resolveError ? (
                  <FeedbackNotice feedback={resolveError} />
                ) : undefined
              }
            />
          </div>
        </div>

        {!isMobileViewport ? (
          <SecondaryRail
            ariaLabel="Chat context"
            expanded={contextRailExpanded}
            onExpandedChange={setContextRailExpanded}
            expandedWidthPx={CHAT_CONTEXT_RAIL_WIDTH_PX}
            bodyClassName={styles.chatSecondaryRailBody}
            collapsed={
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                className={styles.chatSecondaryRailCollapsedButton}
                aria-label="Expand chat context"
                onClick={() => setContextRailExpanded(true)}
              >
                <PanelRightOpen size={15} aria-hidden="true" />
              </Button>
            }
          >
            <ConversationContextPane
              contexts={attachedContexts}
              onRemoveContext={removeContext}
            />
          </SecondaryRail>
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
