/**
 * Conversations list page.
 *
 * Shows a sidebar of conversations and an empty state or new-chat composer.
 * Selecting a conversation navigates to `/conversations/[id]`.
 */

"use client";

import { Suspense, useEffect, useState, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { ContextItem } from "@/lib/api/sse";
import {
  parseAttachContext,
  stripAttachParams,
} from "@/lib/conversations/attachedContext";
import ChatComposer from "@/components/ChatComposer";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
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
  return (
    <Suspense fallback={<StateMessage variant="loading">Loading...</StateMessage>}>
      <ConversationsPageInner />
    </Suspense>
  );
}

function ConversationsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [showNewChat, setShowNewChat] = useState(false);

  const initialAttach = useMemo(
    () => parseAttachContext(searchParams),
    [searchParams],
  );
  const [attachedContexts, setAttachedContexts] =
    useState<ContextItem[]>(initialAttach);

  useEffect(() => {
    if (initialAttach.length > 0) {
      setAttachedContexts(initialAttach);
      setShowNewChat(true);
    }
  }, [initialAttach]);

  const handleRemoveContext = useCallback((index: number) => {
    setAttachedContexts((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearAttachState = useCallback(() => {
    setAttachedContexts([]);
    const cleaned = stripAttachParams(searchParams);
    const qs = cleaned.toString();
    router.replace(qs ? `/conversations?${qs}` : "/conversations");
  }, [router, searchParams]);

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
      clearAttachState();
      router.push(`/conversations/${conversationId}`);
    },
    [router, clearAttachState]
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
          {loading && <StateMessage variant="loading">Loading...</StateMessage>}
          {error && <StateMessage variant="error">{error}</StateMessage>}

          {!loading && !error && conversations.length === 0 && (
            <StateMessage variant="empty">No conversations yet.</StateMessage>
          )}

          {conversations.length > 0 && (
            <AppList>
              {conversations.map((conv) => (
                <AppListItem
                  key={conv.id}
                  href={`/conversations/${conv.id}`}
                  title={`${conv.id.slice(0, 8)}...`}
                  description={`${conv.message_count} messages`}
                  meta={new Date(conv.updated_at).toLocaleDateString()}
                />
              ))}
            </AppList>
          )}

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
              attachedContexts={attachedContexts}
              onRemoveContext={handleRemoveContext}
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
