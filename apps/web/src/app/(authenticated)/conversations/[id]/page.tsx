/**
 * Conversation detail page — chat thread + composer.
 *
 * Loads message history (paginated, oldest first), supports streaming send,
 * and handles optimistic message reconciliation per s3_pr07 §5.4.
 */

"use client";

import { useEffect, useState, useCallback, useRef, use } from "react";
import Link from "next/link";
import { apiFetch, isApiError } from "@/lib/api/client";
import ChatComposer from "@/components/ChatComposer";
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
  sharing: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Component
// ============================================================================

export default function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);

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
  // Load older messages
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

  // --------------------------------------------------------------------------
  // Streaming message handlers
  // --------------------------------------------------------------------------

  /**
   * Called by ChatComposer when optimistic messages should be added.
   * The composer manages the streaming lifecycle; we just update state.
   */
  const handleOptimisticMessages = useCallback(
    (userMsg: Message, assistantMsg: Message) => {
      shouldScrollRef.current = true;
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
    },
    []
  );

  /**
   * Called when meta event arrives with real IDs.
   */
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

  /**
   * Called on each delta chunk to append content to assistant message.
   */
  const handleDelta = useCallback((assistantId: string, delta: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantId ? { ...m, content: m.content + delta } : m
      )
    );
  }, []);

  /**
   * Called when stream completes (done event).
   */
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

  /**
   * Called by non-streaming fallback path.
   */
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
    return (
      <div className={styles.container}>
        <div className={styles.main}>
          <div className={styles.loading}>Loading conversation...</div>
        </div>
      </div>
    );
  }

  if (error || !conversation) {
    return (
      <div className={styles.container}>
        <div className={styles.main}>
          <div className={styles.error}>
            <p>{error || "Conversation not found"}</p>
            <Link href="/conversations">← Back to Conversations</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.main}>
        <div className={styles.chatContainer}>
          {/* Message thread */}
          <div ref={messageListRef} className={styles.messageList}>
            {olderCursor && (
              <button className={styles.loadOlder} onClick={loadOlder}>
                Load older messages
              </button>
            )}

            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
          </div>

          {/* Composer */}
          <ChatComposer
            conversationId={id}
            onOptimisticMessages={handleOptimisticMessages}
            onMetaReceived={handleMetaReceived}
            onDelta={handleDelta}
            onDone={handleDone}
            onNonStreamMessages={handleNonStreamMessages}
            onMessageSent={() => {}}
          />
        </div>
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
