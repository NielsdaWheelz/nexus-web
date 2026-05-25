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
  mergeContextItems,
  parseConversationScopeFromUrl,
  setConversationScopeParam,
} from "@/lib/conversations/attachedContext";
import ChatComposer from "@/components/ChatComposer";
import ChatContextDrawer from "@/components/chat/ChatContextDrawer";
import ChatSurface from "@/components/chat/ChatSurface";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
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
import { createRandomId } from "@/lib/createRandomId";
import {
  buildQuoteSelector,
  getLocatorQuoteParts,
} from "@/lib/highlights/quoteText";
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
  const resolveGenerationRef = useRef(0);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [contextRailExpanded, setContextRailExpanded] = useState(true);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [resolvingScopedConversation, setResolvingScopedConversation] =
    useState(false);
  const [resolveError, setResolveError] = useState<FeedbackContent | null>(
    null,
  );
  const [scopedContinuationBlocked, setScopedContinuationBlocked] =
    useState(false);
  const conversationScope = parseConversationScopeFromUrl(searchParams);
  const conversationScopeKey = getConversationScopeSignature(conversationScope);
  const scopeType = conversationScope.type;
  const scopeMediaId =
    scopeType === "media" ? conversationScope.media_id : null;
  const scopeLibraryId =
    scopeType === "library" ? conversationScope.library_id : null;
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
    setAttachedContexts,
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
    const generation = resolveGenerationRef.current + 1;
    resolveGenerationRef.current = generation;
    let cancelled = false;
    const isCurrentResolution = () =>
      !cancelled && resolveGenerationRef.current === generation;

    setMessages([]);
    setActiveConversationId(null);
    setResolveError(null);
    setScopedContinuationBlocked(false);

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
        if (!isCurrentResolution() || response.data.message_count === 0) return;
        const messagesResponse = await apiFetch<ConversationMessagesResponse>(
          `/api/conversations/${response.data.id}/messages?limit=30`,
        );
        if (!isCurrentResolution()) return;
        setMessages(messagesResponse.data);
        if (
          messagesResponse.data.some(
            (message) =>
              message.role === "assistant" && message.status === "complete",
          )
        ) {
          setActiveConversationId(response.data.id);
          setScopedContinuationBlocked(false);
        } else {
          setScopedContinuationBlocked(true);
          setResolveError({
            severity: "warning",
            title: "Scoped chat cannot be continued yet.",
          });
        }
      })
      .catch((err) => {
        if (!isCurrentResolution()) return;
        setResolveError(
          toFeedback(err, { fallback: "Failed to load scoped chat" }),
        );
      })
      .finally(() => {
        if (isCurrentResolution()) {
          setResolvingScopedConversation(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [conversationScopeKey, scopeLibraryId, scopeMediaId, scopeType]);

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
      resolveGenerationRef.current += 1;
      setResolvingScopedConversation(false);
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
    const cleaned = setConversationScopeParam(searchParams, {
      type: "general",
    });
    const qs = cleaned.toString();
    router.replace(qs ? `/conversations/new?${qs}` : `/conversations/new`);
  }, [router, searchParams]);

  const handleReaderSourceActivate = useCallback(
    (target: ReaderSourceTarget) => {
      router.push(target.href || `/media/${target.media_id}`);
    },
    [router],
  );

  const handleAskAboutSource = useCallback(
    (target: ReaderSourceTarget) => {
      const exact = target.snippet?.trim();
      if (!exact) {
        handleReaderSourceActivate(target);
        return;
      }
      const locator = target.locator;
      const selector = buildQuoteSelector({
        exact,
        ...getLocatorQuoteParts(locator),
      });
      setAttachedContexts((current) =>
        mergeContextItems(current, [
          {
            kind: "reader_selection",
            client_context_id: createRandomId(),
            media_id: target.media_id,
            media_kind:
              locator.type === "pdf_page_geometry"
                ? "pdf"
                : locator.type === "transcript_time_range"
                  ? "transcript"
                  : locator.type === "epub_fragment_offsets"
                    ? "epub"
                    : "web_article",
            media_title: target.label ?? "Source",
            ...selector,
            preview: exact.slice(0, 120),
            locator: target.locator,
            source_version: target.source_version,
            color: "yellow",
          },
        ]),
      );
    },
    [handleReaderSourceActivate, setAttachedContexts],
  );

  const handleSaveSourceQuote = useCallback(
    async (target: ReaderSourceTarget) => {
      const locator = target.locator;
      try {
        if (
          (locator.type === "epub_fragment_offsets" ||
            locator.type === "web_text_offsets") &&
          typeof locator.fragment_id === "string" &&
          typeof locator.start_offset === "number" &&
          typeof locator.end_offset === "number" &&
          locator.end_offset > locator.start_offset
        ) {
          await apiFetch(`/api/fragments/${locator.fragment_id}/highlights`, {
            method: "POST",
            body: JSON.stringify({
              start_offset: locator.start_offset,
              end_offset: locator.end_offset,
              color: "yellow",
            }),
          });
          return;
        }
        if (
          locator.type === "pdf_page_geometry" &&
          typeof locator.page_number === "number" &&
          Array.isArray(locator.quads) &&
          locator.quads.length > 0
        ) {
          await apiFetch(`/api/media/${target.media_id}/pdf-highlights`, {
            method: "POST",
            body: JSON.stringify({
              page_number: locator.page_number,
              quads: locator.quads,
              exact:
                (typeof locator.exact === "string" && locator.exact) ||
                target.snippet ||
                "",
              color: "yellow",
            }),
          });
        }
      } catch (err) {
        setResolveError(toFeedback(err, { fallback: "Failed to save quote" }));
      }
    },
    [],
  );
  const composerConversationId =
    conversationScope.type === "general" ? activeConversationId : null;
  const composerDisabledReason = scopedContinuationBlocked
    ? "Scoped chat cannot be continued yet."
    : undefined;

  return (
    <>
      <div className={styles.chatSplitLayout}>
        <div className={styles.chatPrimaryColumn}>
          <div className={styles.paneContentChat}>
            <ChatSurface
              messages={messages}
              scope={conversationScope}
              onReaderSourceActivate={handleReaderSourceActivate}
              onAskAboutSource={handleAskAboutSource}
              onSaveSourceQuote={handleSaveSourceQuote}
              scrollportRef={scrollportRef}
              onScroll={handleChatScroll}
              composer={
                <ChatComposer
                  conversationId={composerConversationId}
                  conversationScope={conversationScope}
                  attachedContexts={attachedContexts}
                  parentMessageId={activeReplyParentMessageId}
                  onRemoveContext={removeContext}
                  onChatRunCreated={handleChatRunCreated}
                  onMessageSent={clearAttachState}
                  onSendStarted={handleSendStarted}
                  initialContent={draft}
                  draftKey="new-conversation"
                  disabledReason={composerDisabledReason}
                  onClearScope={
                    conversationScope.type === "general"
                      ? undefined
                      : clearConversationScope
                  }
                />
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
