/**
 * Conversations list page.
 *
 * Shows a sidebar of conversations and an empty state or new-chat composer.
 * Selecting a conversation navigates to `/conversations/[id]`.
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch, isApiError } from "@/lib/api/client";
import ChatComposer from "@/components/ChatComposer";
import styles from "./page.module.css";

// ============================================================================
// Types
// ============================================================================

interface Conversation {
  id: string;
  sharing: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

interface ConversationsResponse {
  data: Conversation[];
  page: { next_cursor: string | null };
}

// ============================================================================
// Component
// ============================================================================

export default function ConversationsPage() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [showNewChat, setShowNewChat] = useState(false);

  // Fetch conversations
  const fetchConversations = useCallback(
    async (cursor?: string) => {
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (cursor) params.set("cursor", cursor);

        const response = await apiFetch<ConversationsResponse>(
          `/api/conversations?${params}`
        );
        if (cursor) {
          setConversations((prev) => [...prev, ...response.data]);
        } else {
          setConversations(response.data);
        }
        setNextCursor(response.page.next_cursor);
        setError(null);
      } catch (err) {
        if (isApiError(err)) {
          setError(err.message);
        } else {
          setError("Failed to load conversations");
        }
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const handleNewConversation = useCallback(
    (conversationId: string) => {
      router.push(`/conversations/${conversationId}`);
    },
    [router]
  );

  return (
    <div className={styles.container}>
      {/* Sidebar */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h2 className={styles.sidebarTitle}>Chats</h2>
          <button
            className={styles.newChatBtn}
            onClick={() => setShowNewChat(true)}
          >
            + New
          </button>
        </div>

        <div className={styles.conversationList}>
          {loading && <div className={styles.loading}>Loading...</div>}
          {error && <div className={styles.error}>{error}</div>}

          {conversations.map((conv) => (
            <Link
              key={conv.id}
              href={`/conversations/${conv.id}`}
              className={styles.conversationItem}
            >
              <div className={styles.conversationMeta}>
                <span className={styles.conversationId}>
                  {conv.id.slice(0, 8)}...
                </span>
                <span className={styles.conversationDate}>
                  {conv.message_count} messages ·{" "}
                  {new Date(conv.updated_at).toLocaleDateString()}
                </span>
              </div>
            </Link>
          ))}

          {nextCursor && (
            <button
              className={styles.loadMore}
              onClick={() => fetchConversations(nextCursor)}
            >
              Load more
            </button>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className={styles.main}>
        {showNewChat ? (
          <div className={styles.chatContainer}>
            <div className={styles.messageList}>
              {/* Empty — new conversation */}
            </div>
            <ChatComposer
              conversationId={null}
              onConversationCreated={handleNewConversation}
              onMessageSent={() => fetchConversations()}
            />
          </div>
        ) : (
          <div className={styles.emptyState}>
            <p>Select a conversation or start a new chat</p>
            <p className={styles.emptyHint}>
              Use the &quot;+ New&quot; button to begin
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
