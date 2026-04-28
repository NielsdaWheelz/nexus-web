"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import StateMessage from "@/components/ui/StateMessage";
import StatusPill from "@/components/ui/StatusPill";
import { AppList, AppListItem } from "@/components/ui/AppList";
import {
  formatConversationScopeBadge,
  formatConversationScopeLabel,
} from "@/lib/conversations/display";
import type { ConversationSummary } from "@/lib/conversations/types";
import styles from "./ConversationsPaneBody.module.css";

// ============================================================================
// Types
// ============================================================================

type Conversation = ConversationSummary;

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
    <div className={styles.body} data-testid="conversations-pane-body">
      {loading && <StateMessage variant="loading">Loading...</StateMessage>}
      {error && <StateMessage variant="error">{error}</StateMessage>}

      {!loading && !error && conversations.length === 0 && (
        <StateMessage variant="empty">No conversations yet.</StateMessage>
      )}

      {conversations.length > 0 && (
        <AppList>
          {conversations.map((conv) => (
            <ConversationListItem
              key={conv.id}
              conversation={conv}
              onDelete={handleDelete}
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
  );
}

function ConversationListItem({
  conversation,
  onDelete,
}: {
  conversation: Conversation;
  onDelete: (conversationId: string) => Promise<void>;
}) {
  const scope = conversation.scope;
  const description =
    scope.type === "general"
      ? `${conversation.message_count} messages`
      : `${formatConversationScopeLabel(scope)} - ${conversation.message_count} messages`;

  return (
    <AppListItem
      href={`/conversations/${conversation.id}`}
      title={conversation.title}
      paneTitleHint={conversation.title}
      description={description}
      meta={new Date(conversation.updated_at).toLocaleDateString()}
      trailing={
        <StatusPill variant={scope.type === "general" ? "neutral" : "info"}>
          {formatConversationScopeBadge(scope)}
        </StatusPill>
      }
      options={[
        {
          id: "delete",
          label: "Delete",
          tone: "danger",
          onSelect: () => void onDelete(conversation.id),
        },
      ]}
    />
  );
}
