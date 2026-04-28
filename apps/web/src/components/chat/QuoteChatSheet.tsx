"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
} from "react";
import { ExternalLink, X } from "lucide-react";
import ChatComposer from "@/components/ChatComposer";
import ChatSurface from "@/components/chat/ChatSurface";
import { useChatRunTail } from "@/components/chat/useChatRunTail";
import StateMessage from "@/components/ui/StateMessage";
import { apiFetch, isApiError } from "@/lib/api/client";
import { type ContextItem } from "@/lib/api/sse";
import {
  getContextExact,
  getContextMediaTitle,
  truncateText,
} from "@/lib/conversations/display";
import type {
  ChatRunResponse,
  ConversationMessage,
  ConversationMessagesResponse,
} from "@/lib/conversations/types";
import { useFocusTrap } from "@/lib/ui/useFocusTrap";
import styles from "./QuoteChatSheet.module.css";

export default function QuoteChatSheet({
  context,
  conversationId,
  targetLabel,
  onClose,
  onConversationCreated,
  onOpenFullChat,
}: {
  context: ContextItem;
  conversationId: string | null;
  targetLabel?: string;
  onClose: () => void;
  onConversationCreated: (conversationId: string, runId?: string) => void;
  onOpenFullChat: (conversationId: string) => void;
}) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const scrollportRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);
  const pendingScrollRestoreRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const createdInSheetRef = useRef(false);
  const [activeConversationId, setActiveConversationId] = useState(conversationId);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(Boolean(conversationId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingContexts, setPendingContexts] = useState<ContextItem[]>([context]);
  const [composerFocused, setComposerFocused] = useState(false);
  const { activeRunId, abortAll, tailChatRun } = useChatRunTail({
    setMessages,
    shouldScrollRef,
    onConversationAvailable: (nextConversationId, runId) => {
      if (!activeConversationId && !createdInSheetRef.current) {
        createdInSheetRef.current = true;
        setActiveConversationId(nextConversationId);
        onConversationCreated(nextConversationId, runId);
        return;
      }
      setActiveConversationId((current) => current ?? nextConversationId);
    },
  });

  useFocusTrap(sheetRef, true);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleEscape);
      previousFocusRef.current?.focus({ preventScroll: true });
    };
  }, [onClose]);

  useEffect(() => {
    setActiveConversationId(conversationId);
  }, [conversationId]);

  useEffect(() => {
    abortAll();
    setPendingContexts([context]);
    setMessages([]);
    setOlderCursor(null);
    setLoadError(null);
    createdInSheetRef.current = false;
  }, [abortAll, context]);

  useEffect(() => {
    if (!activeConversationId || createdInSheetRef.current) {
      setLoadingMessages(false);
      return;
    }

    let cancelled = false;
    setLoadingMessages(true);
    setLoadError(null);
    apiFetch<ConversationMessagesResponse>(
      `/api/conversations/${activeConversationId}/messages?limit=30`,
    )
      .then((response) => {
        if (cancelled) return;
        setMessages(response.data);
        setOlderCursor(response.page.next_cursor);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(isApiError(err) ? err.message : "Failed to load chat history");
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingMessages(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  useLayoutEffect(() => {
    if (!scrollportRef.current) return;
    if (pendingScrollRestoreRef.current) {
      const restore = pendingScrollRestoreRef.current;
      pendingScrollRestoreRef.current = null;
      scrollportRef.current.scrollTop =
        scrollportRef.current.scrollHeight - restore.scrollHeight + restore.scrollTop;
      shouldScrollRef.current = false;
      return;
    }
    if (shouldScrollRef.current) {
      scrollportRef.current.scrollTop = scrollportRef.current.scrollHeight;
    }
  }, [messages]);

  const handleChatScroll = useCallback(() => {
    const scrollport = scrollportRef.current;
    if (!scrollport) return;
    shouldScrollRef.current =
      scrollport.scrollHeight - scrollport.scrollTop - scrollport.clientHeight <= 48;
  }, []);

  const loadOlder = useCallback(async () => {
    if (!activeConversationId || !olderCursor) return;
    if (scrollportRef.current) {
      pendingScrollRestoreRef.current = {
        scrollHeight: scrollportRef.current.scrollHeight,
        scrollTop: scrollportRef.current.scrollTop,
      };
    }
    const params = new URLSearchParams({ limit: "30", cursor: olderCursor });
    try {
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
    } catch (err) {
      pendingScrollRestoreRef.current = null;
      throw err;
    }
  }, [activeConversationId, olderCursor]);

  const handleMessageSent = useCallback(() => {
    setPendingContexts([]);
  }, []);

  const handleChatRunCreated = useCallback(
    (runData: ChatRunResponse["data"]) => {
      shouldScrollRef.current = true;
      abortAll();
      void tailChatRun(runData);
    },
    [abortAll, tailChatRun],
  );

  const handleFocusCapture = useCallback((event: FocusEvent<HTMLElement>) => {
    if (event.target instanceof HTMLTextAreaElement) {
      setComposerFocused(true);
    }
  }, []);

  const handleBlurCapture = useCallback(() => {
    window.setTimeout(() => {
      if (!sheetRef.current?.contains(document.activeElement)) {
        setComposerFocused(false);
        return;
      }
      if (!(document.activeElement instanceof HTMLTextAreaElement)) {
        setComposerFocused(false);
      }
    }, 0);
  }, []);

  const quoteText = getContextExact(context);
  const mediaTitle = getContextMediaTitle(context);
  const fullChatDisabled = !activeConversationId;
  const fullChatConversationTarget =
    activeConversationId && activeRunId
      ? `${activeConversationId}?run=${encodeURIComponent(activeRunId)}`
      : activeConversationId;

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <aside
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Ask in chat"
        data-composer-focused={composerFocused ? "true" : "false"}
        onClick={(event) => event.stopPropagation()}
        onFocusCapture={handleFocusCapture}
        onBlurCapture={handleBlurCapture}
      >
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <h2 className={styles.title}>Ask in chat</h2>
            <p className={styles.target}>{targetLabel ?? "New chat"}</p>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.openButton}
              disabled={fullChatDisabled}
              onClick={() => {
                if (fullChatConversationTarget) {
                  onOpenFullChat(fullChatConversationTarget);
                }
              }}
            >
              <ExternalLink size={14} aria-hidden="true" />
              <span>Open chat</span>
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              className={styles.closeButton}
              onClick={onClose}
              aria-label="Close"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className={styles.quoteCard} data-color={context.color ?? undefined}>
          <p className={styles.quoteText}>
            {quoteText ? truncateText(quoteText, 220) : "Selected highlight"}
          </p>
          {mediaTitle ? <p className={styles.quoteMeta}>{mediaTitle}</p> : null}
        </div>

        {loadingMessages ? (
          <div className={styles.status}>
            <StateMessage variant="loading">Loading chat...</StateMessage>
          </div>
        ) : loadError ? (
          <div className={styles.status}>
            <StateMessage variant="error">{loadError}</StateMessage>
          </div>
        ) : (
          <ChatSurface
            messages={messages}
            scrollportRef={scrollportRef}
            onScroll={handleChatScroll}
            olderCursor={olderCursor}
            onLoadOlder={loadOlder}
            emptyState={
              <>
                <p className={styles.emptyTitle}>Ask about this quote</p>
                <p className={styles.emptyCopy}>
                  The selected text is attached to your first message.
                </p>
              </>
            }
            composer={
              <ChatComposer
                conversationId={activeConversationId}
                attachedContexts={pendingContexts}
                onRemoveContext={(index) =>
                  setPendingContexts((prev) => prev.filter((_, i) => i !== index))
                }
                onChatRunCreated={handleChatRunCreated}
                onMessageSent={handleMessageSent}
              />
            }
          />
        )}
      </aside>
    </div>
  );
}
