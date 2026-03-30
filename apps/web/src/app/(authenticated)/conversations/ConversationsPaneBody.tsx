/**
 * Conversations list page.
 *
 * Shows a list of conversations only.
 * Selecting a conversation navigates to `/conversations/[id]`.
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import SectionCard from "@/components/ui/SectionCard";
import styles from "./page.module.css";

// ============================================================================
// Types
// ============================================================================

interface Conversation {
  id: string;
  title: string;
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

export default function ConversationsPaneBody() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

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

  const handleDelete = useCallback(
    async (convId: string) => {
      if (!confirm("Delete this conversation? This cannot be undone.")) return;
      try {
        await apiFetch(`/api/conversations/${convId}`, { method: "DELETE" });
        setConversations((prev) => prev.filter((c) => c.id !== convId));
      } catch (err) {
        if (isApiError(err)) {
          setError(err.message);
        } else {
          setError("Failed to delete conversation");
        }
      }
    },
    []
  );

  return (
    <SectionCard title="Chats">
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
                  title={conv.title}
                  paneTitleHint={conv.title}
                  paneResourceRef={`conversation:${conv.id}`}
                  description={`${conv.message_count} messages`}
                  meta={new Date(conv.updated_at).toLocaleDateString()}
                  options={[
                    {
                      id: "delete",
                      label: "Delete",
                      tone: "danger",
                      onSelect: () => void handleDelete(conv.id),
                    },
                  ]}
                />
              ))}
            </AppList>
          )}

          {nextCursor && (
            <button
              className={styles.loadMore}
              aria-label="Load more conversations"
              onClick={() => fetchConversations(nextCursor)}
            >
              Load more
            </button>
          )}
        </div>
    </SectionCard>
  );
}
