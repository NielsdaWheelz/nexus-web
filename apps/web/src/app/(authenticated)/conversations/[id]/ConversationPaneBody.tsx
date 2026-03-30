/**
 * Conversation detail page — chat thread + composer.
 *
 * Loads message history (paginated, oldest first), supports streaming send,
 * and handles optimistic message reconciliation per s3_pr07 §5.4.
 */

"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { ContextItem } from "@/lib/api/sse";
import {
  parseAttachContext,
  stripAttachParams,
} from "@/lib/conversations/attachedContext";
import { hydrateContextItems } from "@/lib/conversations/hydrateContextItems";
import ChatComposer from "@/components/ChatComposer";
import ConversationContextPane from "@/components/ConversationContextPane";
import StateMessage from "@/components/ui/StateMessage";
import {
  usePaneParam,
  usePaneRouter,
  usePaneSearchParams,
  useSetPaneTitle,
} from "@/lib/panes/paneRuntime";
import styles from "../page.module.css";

// ============================================================================
// Types
// ============================================================================

export interface Message {
  id: string;
  seq: number;
  role: "user" | "assistant" | "system";
  content: string;
  status: "pending" | "complete" | "error";
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface MessagesResponse {
  data: Message[];
  page: { next_cursor: string | null };
}

interface Conversation {
  id: string;
  title: string;
  sharing: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// ConversationPaneBody — routes between context pane and chat view
// ============================================================================

export default function ConversationPaneBody() {
  const id = usePaneParam("id");
  if (!id) throw new Error("conversation route requires an id");

  const router = usePaneRouter();
  const searchParams = usePaneSearchParams();

  // Attached context state — shared by both branches
  const initialAttach = useMemo(
    () => parseAttachContext(searchParams),
    [searchParams],
  );
  const [attachedContexts, setAttachedContexts] =
    useState<ContextItem[]>(initialAttach);

  useEffect(() => {
    setAttachedContexts(initialAttach);
  }, [initialAttach]);

  // Hydrate context items with full data from API
  useEffect(() => {
    if (attachedContexts.length === 0) return;
    if (attachedContexts.every((c) => c.hydrated)) return;
    let cancelled = false;
    hydrateContextItems(attachedContexts)
      .then((hydrated) => {
        if (!cancelled) setAttachedContexts(hydrated);
      })
      .catch(() => {
        // Hydration is best-effort; URL-param data serves as fallback
      });
    return () => {
      cancelled = true;
    };
  }, [attachedContexts]);

  const handleRemoveContext = useCallback((index: number) => {
    setAttachedContexts((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAttachState = useCallback(() => {
    setAttachedContexts([]);
    const cleaned = stripAttachParams(searchParams);
    const qs = cleaned.toString();
    router.replace(qs ? `/conversations/${id}?${qs}` : `/conversations/${id}`);
  }, [router, searchParams, id]);

  // --- Branch ---
  if (searchParams.get("pane") === "context") {
    return (
      <ConversationContextPane
        contexts={attachedContexts}
        onRemoveContext={handleRemoveContext}
      />
    );
  }

  return (
    <ChatView
      id={id}
      attachedContexts={attachedContexts}
      onRemoveContext={handleRemoveContext}
      onMessageSent={clearAttachState}
    />
  );
}

// ============================================================================
// ChatView — conversation thread + composer
// ============================================================================

function ChatView({
  id,
  attachedContexts,
  onRemoveContext,
  onMessageSent,
}: {
  id: string;
  attachedContexts: ContextItem[];
  onRemoveContext: (index: number) => void;
  onMessageSent: () => void;
}) {
  const router = usePaneRouter();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  useSetPaneTitle(conversation?.title ?? "Chat");

  const messageListRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef(true);

  // --------------------------------------------------------------------------
  // Data fetching
  // --------------------------------------------------------------------------

  useEffect(() => {
    const load = async () => {
      try {
        const [convData, msgsData] = await Promise.all([
          apiFetch<{ data: Conversation }>(`/api/conversations/${id}`),
          apiFetch<MessagesResponse>(`/api/conversations/${id}/messages?limit=50`),
        ]);
        setConversation(convData.data);
        setMessages(msgsData.data);
        setOlderCursor(msgsData.page.next_cursor);
        setError(null);
      } catch (err) {
        if (isApiError(err)) {
          setError(err.message);
        } else {
          setError("Failed to load conversation");
        }
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (shouldScrollRef.current && messageListRef.current) {
      messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
    }
  }, [messages]);

  // --------------------------------------------------------------------------
  // Actions
  // --------------------------------------------------------------------------

  const loadOlder = useCallback(async () => {
    if (!olderCursor) return;
    try {
      const params = new URLSearchParams({
        limit: "50",
        cursor: olderCursor,
      });
      const response = await apiFetch<MessagesResponse>(
        `/api/conversations/${id}/messages?${params}`
      );
      // Prepend older messages, deduplicate by ID
      setMessages((prev) => {
        const existingIds = new Set(prev.map((m) => m.id));
        const newMsgs = response.data.filter((m) => !existingIds.has(m.id));
        return [...newMsgs, ...prev];
      });
      setOlderCursor(response.page.next_cursor);
      shouldScrollRef.current = false;
    } catch (err) {
      console.error("Failed to load older messages:", err);
    }
  }, [id, olderCursor]);

  const handleDeleteConversation = useCallback(async () => {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/conversations/${id}`, { method: "DELETE" });
      router.push("/conversations");
    } catch (err) {
      if (isApiError(err)) {
        setError(err.message);
      } else {
        setError("Failed to delete conversation");
      }
    } finally {
      setDeleting(false);
    }
  }, [id, router]);

  // --------------------------------------------------------------------------
  // Streaming message handlers
  // --------------------------------------------------------------------------

  const handleOptimisticMessages = useCallback(
    (userMsg: Message, assistantMsg: Message) => {
      shouldScrollRef.current = true;
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
    },
    []
  );

  const handleMetaReceived = useCallback(
    (tempUserId: string, realUserId: string, tempAsstId: string, realAsstId: string) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === tempUserId) return { ...m, id: realUserId };
          if (m.id === tempAsstId) return { ...m, id: realAsstId };
          return m;
        })
      );
    },
    []
  );

  const handleDelta = useCallback((assistantId: string, delta: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId ? { ...m, content: m.content + delta } : m
      )
    );
  }, []);

  const handleDone = useCallback(
    (assistantId: string, status: "complete" | "error", errorCode: string | null) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, status, error_code: errorCode }
            : m
        )
      );
    },
    []
  );

  const handleNonStreamMessages = useCallback(
    (userMsg: Message, assistantMsg: Message) => {
      shouldScrollRef.current = true;
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
    },
    []
  );

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  if (loading) {
    return <StateMessage variant="loading">Loading conversation...</StateMessage>;
  }

  if (error || !conversation) {
    return <StateMessage variant="error">{error || "Conversation not found"}</StateMessage>;
  }

  return (
    <div className={styles.paneContentChat}>
      <div className={styles.chatContainer}>
        <div className={styles.chatActions}>
          <span className={styles.chatMeta}>{conversation.message_count} messages</span>
          <button
            type="button"
            className={styles.deleteConversationBtn}
            disabled={deleting}
            onClick={() => {
              void handleDeleteConversation();
            }}
          >
            {deleting ? "Deleting..." : "Delete conversation"}
          </button>
        </div>

        {/* Message thread */}
        <div ref={messageListRef} className={styles.messageList}>
          {olderCursor && (
            <button
              className={styles.loadOlder}
              aria-label="Load older messages"
              onClick={loadOlder}
            >
              Load older messages
            </button>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
        </div>

        <ChatComposer
          conversationId={id}
          attachedContexts={attachedContexts}
          onRemoveContext={onRemoveContext}
          onOptimisticMessages={handleOptimisticMessages}
          onMetaReceived={handleMetaReceived}
          onDelta={handleDelta}
          onDone={handleDone}
          onNonStreamMessages={handleNonStreamMessages}
          onMessageSent={onMessageSent}
        />
      </div>
    </div>
  );
}

// ============================================================================
// MessageBubble
// ============================================================================

function MessageBubble({ message }: { message: Message }) {
  const roleClass =
    message.role === "user"
      ? styles.user
      : message.role === "assistant"
        ? styles.assistant
        : styles.system;

  const statusClass =
    message.status === "error"
      ? styles.error
      : message.status === "pending"
        ? styles.pending
        : "";

  return (
    <div className={`${styles.messageBubble} ${roleClass} ${statusClass}`}>
      {message.content || (message.status === "pending" ? "..." : "")}
      {message.status === "error" && message.error_code && (
        <div className={styles.retryBtn}>
          Error: {message.error_code}
        </div>
      )}
    </div>
  );
}
