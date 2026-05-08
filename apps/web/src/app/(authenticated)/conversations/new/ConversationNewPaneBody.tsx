/**
 * New conversation page — fresh chat composer with optional attached context.
 *
 * Opened by quote-to-chat flows. Reads typed context ids from search params.
 * On first message send the backend creates the conversation, the pane streams
 * locally immediately, then the URL is replaced with /conversations/:id.
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
import {
  getConversationScopeSignature,
  parseConversationScopeFromUrl,
  setConversationScopeParam,
} from "@/lib/conversations/attachedContext";
import ChatComposer from "@/components/ChatComposer";
import ChatContextDrawer from "@/components/chat/ChatContextDrawer";
import ChatSurface from "@/components/chat/ChatSurface";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import ConversationContextPane from "@/components/ConversationContextPane";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import SecondaryRail from "@/components/secondaryRail/SecondaryRail";
import Button from "@/components/ui/Button";
import { apiFetch } from "@/lib/api/client";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import type {
  ChatRunResponse,
  ConversationMessage,
  ConversationMessagesResponse,
  ConversationSummary,
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
  const [contextRailExpanded, setContextRailExpanded] = useState(true);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [resolvingScopedConversation, setResolvingScopedConversation] = useState(false);
  const [resolveError, setResolveError] = useState<FeedbackContent | null>(null);
  const conversationScope = parseConversationScopeFromUrl(searchParams);
  const conversationScopeKey = getConversationScopeSignature(conversationScope);
  const scopeType = conversationScope.type;
  const scopeMediaId = scopeType === "media" ? conversationScope.media_id : null;
  const scopeLibraryId = scopeType === "library" ? conversationScope.library_id : null;
  const activeReplyParentMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && message.status === "complete") {
        return message.id;
      }
    }
    return null;
  }, [messages]);
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

  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setActiveConversationId(null);
    setResolveError(null);

    if (scopeType === "general") {
      setResolvingScopedConversation(false);
      return;
    }
    if (
      (scopeType === "media" && !scopeMediaId) ||
      (scopeType === "library" && !scopeLibraryId)
    ) {
      setResolvingScopedConversation(false);
      return;
    }

    setResolvingScopedConversation(true);
    apiFetch<{ data: ConversationSummary }>("/api/conversations/resolve", {
      method: "POST",
      body: JSON.stringify(
        scopeType === "media"
          ? { type: "media", media_id: scopeMediaId }
          : { type: "library", library_id: scopeLibraryId },
      ),
    })
      .then(async (response) => {
        if (cancelled || response.data.message_count === 0) return;
        const messagesResponse = await apiFetch<ConversationMessagesResponse>(
          `/api/conversations/${response.data.id}/messages?limit=30`,
        );
        if (cancelled) return;
        setMessages(messagesResponse.data);
        if (
          messagesResponse.data.some(
            (message) => message.role === "assistant" && message.status === "complete",
          )
        ) {
          setActiveConversationId(response.data.id);
        } else {
          setResolveError({
            severity: "warning",
            title: "Scoped chat cannot be continued yet.",
          });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setResolveError(toFeedback(err, { fallback: "Failed to load scoped chat" }));
      })
      .finally(() => {
        if (!cancelled) {
          setResolvingScopedConversation(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [conversationScopeKey, scopeLibraryId, scopeMediaId, scopeType]);

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
                resolvingScopedConversation || resolveError ? null : (
                  <ChatComposer
                    conversationId={activeConversationId}
                    conversationScope={conversationScope}
                    attachedContexts={attachedContexts}
                    parentMessageId={activeReplyParentMessageId}
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
                )
              }
              emptyState={
                resolveError ? (
                  <FeedbackNotice feedback={resolveError} />
                ) : resolvingScopedConversation ? (
                  "Loading scoped chat..."
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
            expandedWidthPx={320}
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
              scope={conversationScope}
              contexts={attachedContexts}
              onRemoveContext={removeContext}
            />
          </SecondaryRail>
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
