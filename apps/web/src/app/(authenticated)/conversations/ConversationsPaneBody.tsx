"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api/client";
import { conversationResourceOptions } from "@/lib/actions/resourceActions";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { AppList, AppListItem } from "@/components/ui/AppList";
import { SINGLETON_KIND_ICONS } from "@/lib/conversations/display";
import type { ConversationSummary } from "@/lib/conversations/types";
import styles from "./ConversationsPaneBody.module.css";

type Conversation = ConversationSummary;

interface ConversationsResponse {
  data: Conversation[];
  page: { next_cursor: string | null };
}

export default function ConversationsPaneBody() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

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
        setError(toFeedback(err, { fallback: "Failed to load conversations" }));
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
        setError(toFeedback(err, { fallback: "Failed to delete conversation" }));
      }
    },
    []
  );

  return (
    <div className={styles.body}>
      {loading && <FeedbackNotice severity="info">Loading...</FeedbackNotice>}
      {error ? <FeedbackNotice feedback={error} /> : null}

      {!loading && !error && conversations.length === 0 && (
        <FeedbackNotice severity="neutral">No conversations yet.</FeedbackNotice>
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
        <Button
          variant="secondary"
          className={styles.loadMore}
          aria-label="Load more conversations"
          onClick={() => fetchConversations(nextCursor)}
        >
          Load more
        </Button>
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
  const singleton = conversation.singleton;
  const Icon = singleton ? SINGLETON_KIND_ICONS[singleton.kind] : null;
  const description = singleton
    ? singleton.target_title
    : `${conversation.message_count} messages`;

  return (
    <AppListItem
      href={`/conversations/${conversation.id}`}
      title={conversation.title}
      paneTitleHint={conversation.title}
      description={description}
      meta={new Date(conversation.updated_at).toLocaleDateString()}
      icon={Icon ? <Icon size={16} aria-hidden="true" /> : undefined}
      options={
        singleton
          ? undefined
          : conversationResourceOptions({
              onDelete: () => void onDelete(conversation.id),
            })
      }
    />
  );
}
