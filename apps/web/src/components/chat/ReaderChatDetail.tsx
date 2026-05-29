"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import ChatComposer from "@/components/ChatComposer";
import ChatSurface from "@/components/chat/ChatSurface";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { apiFetch } from "@/lib/api/client";
import type {
  ChatRunResponse,
  ConversationMessage,
  ConversationMessagesResponse,
} from "@/lib/conversations/types";
import { useStringIdSet } from "@/lib/useStringIdSet";
import styles from "./ReaderChatDetail.module.css";

const MESSAGE_PAGE_SIZE = 30;

interface ReaderChatDetailProps {
  /** Existing conversation, or null for a chat not yet created (created on first send). */
  conversationId: string | null;
  mediaId: string;
  /** A highlight URI to attach to the conversation when the user sends. */
  pendingQuoteUri?: string | null;
  onBack: () => void;
  onOpenFullChat: (conversationId: string) => void;
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
}

/**
 * A conversation rendered inline inside the reader's document-chat sidecar: full chat
 * history + composer, plus a link out to the full conversation pane. Composes
 * the same primitives as the full pane (ChatSurface + ChatComposer +
 * useChatRunTail) without the pane's branching/chrome.
 *
 * The conversation and any pending quote are created/attached on the first send
 * (via the composer's onResolveConversation), never eagerly.
 */
export default function ReaderChatDetail({
  conversationId,
  mediaId,
  pendingQuoteUri = null,
  onBack,
  onOpenFullChat,
  onReaderSourceActivate,
}: ReaderChatDetailProps) {
  const scrollportRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);
  const locallyCreatedConversationIdsRef = useRef<Set<string>>(new Set());

  const [activeConversationId, setActiveConversationId] =
    useState(conversationId);
  const [title, setTitle] = useState("New chat");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(
    Boolean(conversationId),
  );
  const [loadError, setLoadError] = useState<FeedbackContent | null>(null);
  const [pendingReferences, setPendingReferences] = useState<
    Array<{ uri: string; label: string }>
  >(() =>
    pendingQuoteUri ? [{ uri: pendingQuoteUri, label: "Selected quote" }] : [],
  );
  const retryingAssistantMessageIds = useStringIdSet();

  const activeReplyParentMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && message.status === "complete") {
        return message.id;
      }
    }
    return null;
  }, [messages]);

  const { abortAll, tailChatRun } = useChatRunTail({
    setMessages,
    shouldScrollRef,
  });

  useEffect(() => {
    if (!activeConversationId) return;
    let cancelled = false;
    apiFetch<{ data: { title: string } }>(
      `/api/conversations/${activeConversationId}`,
    )
      .then((response) => {
        if (!cancelled) setTitle(response.data.title);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  // Load history for an existing conversation. Skip locally-created ones — their
  // messages were seeded optimistically on send.
  useEffect(() => {
    if (
      !activeConversationId ||
      locallyCreatedConversationIdsRef.current.has(activeConversationId)
    ) {
      setLoadingMessages(false);
      return;
    }
    let cancelled = false;
    setLoadingMessages(true);
    setLoadError(null);
    apiFetch<ConversationMessagesResponse>(
      `/api/conversations/${activeConversationId}/messages?limit=${MESSAGE_PAGE_SIZE}`,
    )
      .then((response) => {
        if (cancelled) return;
        setMessages(response.data);
        setOlderCursor(response.page.next_cursor);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(
          toFeedback(err, { fallback: "Failed to load chat history" }),
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  const loadOlder = useCallback(async () => {
    if (!activeConversationId || !olderCursor) return;
    const params = new URLSearchParams({
      limit: String(MESSAGE_PAGE_SIZE),
      cursor: olderCursor,
    });
    const response = await apiFetch<ConversationMessagesResponse>(
      `/api/conversations/${activeConversationId}/messages?${params}`,
    );
    setMessages((prev) => {
      const existingIds = new Set(prev.map((m) => m.id));
      const next = response.data.filter((m) => !existingIds.has(m.id));
      return [...next, ...prev];
    });
    setOlderCursor(response.page.next_cursor);
    shouldScrollRef.current = false;
  }, [activeConversationId, olderCursor]);

  // Commit pending references and resolve the conversation to send to: attach to
  // the existing conversation, or create one referencing the document + quote.
  const resolveConversation = useCallback(async (): Promise<string> => {
    const refUris = pendingReferences.map((ref) => ref.uri);
    if (activeConversationId) {
      for (const uri of refUris) {
        await apiFetch(`/api/conversations/${activeConversationId}/references`, {
          method: "POST",
          body: JSON.stringify({ resource_uri: uri }),
        });
      }
      setPendingReferences([]);
      return activeConversationId;
    }
    const created = await apiFetch<{ data: { id: string } }>(
      "/api/conversations",
      {
        method: "POST",
        body: JSON.stringify({
          initial_references: [`media:${mediaId}`, ...refUris],
        }),
      },
    );
    locallyCreatedConversationIdsRef.current.add(created.data.id);
    setActiveConversationId(created.data.id);
    setPendingReferences([]);
    return created.data.id;
  }, [activeConversationId, mediaId, pendingReferences]);

  const handleChatRunCreated = useCallback(
    (runData: ChatRunResponse["data"]) => {
      shouldScrollRef.current = true;
      locallyCreatedConversationIdsRef.current.add(runData.conversation.id);
      setActiveConversationId(runData.conversation.id);
      if (!runData.user_message.parent_message_id) {
        setMessages([runData.user_message, runData.assistant_message]);
      }
      abortAll();
      void tailChatRun(runData);
    },
    [abortAll, tailChatRun],
  );

  const handleRetryAssistantResponse = useCallback(
    async (assistantMessageId: string) => {
      if (retryingAssistantMessageIds.has(assistantMessageId)) return;
      retryingAssistantMessageIds.add(assistantMessageId);
      try {
        const response = await apiFetch<ChatRunResponse>(
          `/api/messages/${assistantMessageId}/retry`,
          { method: "POST" },
        );
        handleChatRunCreated(response.data);
      } finally {
        retryingAssistantMessageIds.remove(assistantMessageId);
      }
    },
    [handleChatRunCreated, retryingAssistantMessageIds],
  );

  return (
    <section className={styles.pane} role="region" aria-label="Chat detail">
      <header className={styles.header}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          onClick={onBack}
          aria-label="Back to chats"
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </Button>
        <h2 className={styles.title}>{title}</h2>
        {activeConversationId ? (
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<ExternalLink size={14} aria-hidden="true" />}
            onClick={() => onOpenFullChat(activeConversationId)}
          >
            Open in full chat
          </Button>
        ) : (
          <span className={styles.headerSpacer} />
        )}
      </header>

      {loadError ? (
        <div className={styles.status}>
          <FeedbackNotice feedback={loadError} />
        </div>
      ) : null}

      <ChatSurface
        messages={messages}
        scrollportRef={scrollportRef}
        olderCursor={olderCursor}
        onLoadOlder={loadOlder}
        onRetryAssistantResponse={handleRetryAssistantResponse}
        retryingAssistantMessageIds={retryingAssistantMessageIds.ids}
        onReaderSourceActivate={onReaderSourceActivate}
        emptyState={
          loadingMessages ? (
            <FeedbackNotice severity="info" title="Loading chat history..." />
          ) : null
        }
        composer={
          <ChatComposer
            conversationId={activeConversationId}
            parentMessageId={activeReplyParentMessageId}
            readerContext={{ media_id: mediaId, library_id: null }}
            pendingReferences={pendingReferences}
            onRemovePendingReference={(uri) =>
              setPendingReferences((prev) =>
                prev.filter((ref) => ref.uri !== uri),
              )
            }
            onResolveConversation={resolveConversation}
            onChatRunCreated={handleChatRunCreated}
            autoFocus
          />
        }
      />
    </section>
  );
}
