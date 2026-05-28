"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import ChatComposer from "@/components/ChatComposer";
import ChatSurface from "@/components/chat/ChatSurface";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import PinnedSourcesTray from "@/components/chat/PinnedSourcesTray";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { apiFetch } from "@/lib/api/client";
import type {
  ContextItem,
  ReaderContextHintInput,
  SingletonTargetInput,
} from "@/lib/api/sse/requests";
import type {
  ChatRunResponse,
  ConversationMessage,
  ConversationMessagesResponse,
} from "@/lib/conversations/types";
import { mergeContextItems } from "@/lib/conversations/attachedContext";
import { useStringIdSet } from "@/lib/useStringIdSet";
import styles from "./ChatDetailSlideIn.module.css";

const MESSAGE_PAGE_SIZE = 30;

interface ChatDetailSlideInProps {
  title: string;
  conversationId: string | null;
  singletonTarget?: SingletonTargetInput | null;
  readerContext?: ReaderContextHintInput | null;
  attachedContexts?: ContextItem[];
  onBack: () => void;
  onOpenFullChat?: () => void;
  onReaderSourceActivate?: (target: ReaderSourceTarget) => void;
}

export default function ChatDetailSlideIn({
  title,
  conversationId,
  singletonTarget = null,
  readerContext = null,
  attachedContexts,
  onBack,
  onOpenFullChat,
  onReaderSourceActivate,
}: ChatDetailSlideInProps) {
  const scrollportRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);
  const locallyCreatedConversationIdsRef = useRef<Set<string>>(new Set());
  const pendingContextDetailRef = useRef<string | null>(null);
  const detailIdentity = [
    conversationId ?? "",
    singletonTarget?.kind ?? "",
    singletonTarget?.target_id ?? "",
    readerContext?.media_id ?? "",
    readerContext?.library_id ?? "",
  ].join(":");

  const [activeConversationId, setActiveConversationId] = useState(conversationId);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(Boolean(conversationId));
  const [loadError, setLoadError] = useState<FeedbackContent | null>(null);
  const [pendingContexts, setPendingContexts] = useState<ContextItem[]>(
    () => attachedContexts ?? [],
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

  useEffect(() => {
    const nextContexts = attachedContexts ?? [];
    if (pendingContextDetailRef.current !== detailIdentity) {
      pendingContextDetailRef.current = detailIdentity;
      setPendingContexts(nextContexts);
      return;
    }
    if (nextContexts.length === 0) {
      return;
    }
    setPendingContexts((current) =>
      mergeContextItems(current, nextContexts),
    );
  }, [attachedContexts, detailIdentity]);

  const { abortAll, tailChatRun } = useChatRunTail({
    setMessages,
    shouldScrollRef,
    onConversationAvailable: (nextConversationId) => {
      locallyCreatedConversationIdsRef.current.add(nextConversationId);
      setActiveConversationId(nextConversationId);
    },
  });

  useEffect(() => {
    abortAll();
    setActiveConversationId(conversationId);
    setMessages([]);
    setOlderCursor(null);
    setLoadError(null);
    setLoadingMessages(Boolean(conversationId));
  }, [abortAll, conversationId]);

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
        setLoadError(toFeedback(err, { fallback: "Failed to load chat history" }));
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

  const handleChatRunCreated = useCallback(
    (runData: ChatRunResponse["data"]) => {
      shouldScrollRef.current = true;
      locallyCreatedConversationIdsRef.current.add(runData.conversation.id);
      setActiveConversationId(runData.conversation.id);
      if (!runData.user_message.parent_message_id) {
        setMessages([runData.user_message, runData.assistant_message]);
      }
      setPendingContexts([]);
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
    <section
      className={styles.pane}
      role="region"
      aria-label="Chat detail"
    >
      <header className={styles.header}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </Button>
        <h2 className={styles.title}>{title}</h2>
        {onOpenFullChat && activeConversationId ? (
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<ExternalLink size={14} aria-hidden="true" />}
            onClick={onOpenFullChat}
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

      <PinnedSourcesTray conversationId={activeConversationId} />

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
            singletonTarget={activeConversationId ? null : singletonTarget}
            parentMessageId={activeConversationId ? activeReplyParentMessageId : null}
            readerContext={readerContext}
            attachedContexts={pendingContexts}
            onRemoveContext={(index) =>
              setPendingContexts((prev) => prev.filter((_, i) => i !== index))
            }
            onChatRunCreated={handleChatRunCreated}
            autoFocus
          />
        }
      />
    </section>
  );
}
