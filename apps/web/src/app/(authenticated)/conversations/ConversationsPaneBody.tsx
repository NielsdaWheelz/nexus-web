"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  conversationsInitialResource,
  type NoResourceParams,
} from "@/lib/api/resource";
import { useResource } from "@/lib/api/useResource";
import { conversationResourceOptions } from "@/lib/actions/resourceActions";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import Button from "@/components/ui/Button";
import { AppList, AppListItem } from "@/components/ui/AppList";
import type { ConversationSummary } from "@/lib/conversations/types";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import styles from "./ConversationsPaneBody.module.css";

interface ConversationsResponse {
  data: ConversationSummary[];
  page: { next_cursor: string | null };
}

export default function ConversationsPaneBody() {
  const initialConversations = useResource<
    ConversationsResponse,
    NoResourceParams
  >({
    descriptor: conversationsInitialResource,
    params: {},
  });
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const display = useRenderEnvironment();

  useEffect(() => {
    if (initialConversations.status === "ready") {
      setConversations(initialConversations.data.data);
      setNextCursor(initialConversations.data.page.next_cursor);
      setError(null);
    } else if (initialConversations.status === "error") {
      setError(
        toFeedback(initialConversations.error, {
          fallback: "Failed to load conversations",
        }),
      );
    }
  }, [initialConversations]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: "50", cursor: nextCursor });
      const response = await apiFetch<ConversationsResponse>(
        `/api/conversations?${params}`,
      );
      setConversations((prev) => [...prev, ...response.data]);
      setNextCursor(response.page.next_cursor);
      setError(null);
    } catch (err) {
      if (handleUnauthenticatedApiError(err)) return;
      setError(toFeedback(err, { fallback: "Failed to load conversations" }));
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor]);

  const handleDelete = useCallback(
    async (convId: string) => {
      if (!confirm("Delete this conversation? This cannot be undone.")) return;
      try {
        await apiFetch(`/api/conversations/${convId}`, { method: "DELETE" });
        setConversations((prev) => prev.filter((c) => c.id !== convId));
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        setError(toFeedback(err, { fallback: "Failed to delete conversation" }));
      }
    },
    []
  );

  return (
    <div className={styles.body}>
      {initialConversations.status === "loading" && <PaneLoadingState />}
      {error ? <FeedbackNotice feedback={error} /> : null}

      {initialConversations.status !== "loading" &&
        !error &&
        conversations.length === 0 && (
        <FeedbackNotice severity="neutral">No conversations yet.</FeedbackNotice>
        )}

      {conversations.length > 0 && (
        <AppList>
          {conversations.map((conv) => (
            <ConversationListItem
              key={conv.id}
              conversation={conv}
              display={display}
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
          loading={loadingMore}
          onClick={() => void loadMore()}
        >
          Load more
        </Button>
      )}
    </div>
  );
}

function ConversationListItem({
  conversation,
  display,
  onDelete,
}: {
  conversation: ConversationSummary;
  display: RenderEnvironment;
  onDelete: (conversationId: string) => Promise<void>;
}) {
  return (
    <AppListItem
      href={`/conversations/${conversation.id}`}
      title={conversation.title}
      paneTitleHint={conversation.title}
      meta={formatDisplayDate(conversation.updated_at, display) ?? ""}
      options={conversationResourceOptions({
        onDelete: () => void onDelete(conversation.id),
      })}
    />
  );
}
