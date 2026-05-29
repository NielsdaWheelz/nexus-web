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
import type { ReaderContextHintInput } from "@/lib/api/sse/requests";
import type {
  ChatRunResponse,
  ConversationMessage,
  ConversationMessagesResponse,
} from "@/lib/conversations/types";
import { useStringIdSet } from "@/lib/useStringIdSet";
import styles from "./ReaderChatDetail.module.css";

const MESSAGE_PAGE_SIZE = 30;

interface ReaderChatDetailProps {
  conversationId: string;
  readerContext: ReaderContextHintInput;
  onBack: () => void;
  onOpenFullChat: () => void;
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
}

/**
 * A conversation rendered inline inside the reader's secondary rail: full chat
 * history + composer, plus a link out to the full conversation pane. Composes
 * the same primitives as the full pane (ChatSurface + ChatComposer +
 * useChatRunTail) without the pane's branching/chrome.
 */
export default function ReaderChatDetail({
  conversationId,
  readerContext,
  onBack,
  onOpenFullChat,
  onReaderSourceActivate,
}: ReaderChatDetailProps) {
  const scrollportRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);

  const [title, setTitle] = useState("Chat");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [loadError, setLoadError] = useState<FeedbackContent | null>(null);
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
    let cancelled = false;
    apiFetch<{ data: { title: string } }>(`/api/conversations/${conversationId}`)
      .then((response) => {
        if (!cancelled) setTitle(response.data.title);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    abortAll();
    setMessages([]);
    setOlderCursor(null);
    setLoadError(null);
    setLoadingMessages(true);

    let cancelled = false;
    apiFetch<ConversationMessagesResponse>(
      `/api/conversations/${conversationId}/messages?limit=${MESSAGE_PAGE_SIZE}`,
    )
      .then((response) => {
        if (cancelled) return;
        setMessages(response.data);
        setOlderCursor(response.page.next_cursor);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(toFeedback(err, { fallback: "Failed to load chat history" }));
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });

    return () => {
      cancelled = true;
    };
  }, [abortAll, conversationId]);

  const loadOlder = useCallback(async () => {
    if (!olderCursor) return;
    const params = new URLSearchParams({
      limit: String(MESSAGE_PAGE_SIZE),
      cursor: olderCursor,
    });
    const response = await apiFetch<ConversationMessagesResponse>(
      `/api/conversations/${conversationId}/messages?${params}`,
    );
    setMessages((prev) => {
      const existingIds = new Set(prev.map((m) => m.id));
      const next = response.data.filter((m) => !existingIds.has(m.id));
      return [...next, ...prev];
    });
    setOlderCursor(response.page.next_cursor);
    shouldScrollRef.current = false;
  }, [conversationId, olderCursor]);

  const handleChatRunCreated = useCallback(
    (runData: ChatRunResponse["data"]) => {
      shouldScrollRef.current = true;
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
        <Button
          variant="secondary"
          size="sm"
          leadingIcon={<ExternalLink size={14} aria-hidden="true" />}
          onClick={onOpenFullChat}
        >
          Open in full chat
        </Button>
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
            conversationId={conversationId}
            parentMessageId={activeReplyParentMessageId}
            readerContext={readerContext}
            onChatRunCreated={handleChatRunCreated}
            autoFocus
          />
        }
      />
    </section>
  );
}
