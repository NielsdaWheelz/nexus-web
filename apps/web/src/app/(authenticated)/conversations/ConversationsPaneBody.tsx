"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { conversationsInitialResource, type NoResourceParams } from "@/lib/api/resource";
import { useResource } from "@/lib/api/useResource";
import { useCursorPagination, type CursorPage } from "@/lib/api/useCursorPagination";
import { useStringIdSet } from "@/lib/useStringIdSet";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import { presentConversation } from "@/lib/collections/presenters/conversation";
import type { ConversationSummary } from "@/lib/conversations/types";

export default function ConversationsPaneBody() {
  const firstPage = useResource<CursorPage<ConversationSummary>, NoResourceParams>({
    descriptor: conversationsInitialResource,
    params: {},
  });
  const { items, status, error, hasMore, loadingMore, loadMore } =
    useCursorPagination<ConversationSummary>({
      firstPage,
      buildMoreHref: (cursor) =>
        `/api/conversations?${new URLSearchParams({ limit: "50", cursor })}`,
    });
  const removed = useStringIdSet();
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm("Delete this conversation? This cannot be undone.")) return;
      try {
        await apiFetch(`/api/conversations/${id}`, { method: "DELETE" });
        removed.add(id);
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        setFeedback(toFeedback(err, { fallback: "Failed to delete conversation" }));
      }
    },
    [removed],
  );

  const rows = items
    .filter((conversation) => !removed.has(conversation.id))
    .map((conversation) =>
      presentConversation(conversation, {
        onDelete: () => void handleDelete(conversation.id),
      }),
    );

  const loadError = error ? toFeedback(error, { fallback: "Failed to load conversations" }) : null;

  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio: { kind: "count", value: rows.length, unit: "chat" },
      pending: status === "loading",
    },
  });

  return (
    <CollectionView
      rows={rows}
      status={status}
      ariaLabel="Conversations"
      opener={
        <SectionOpener
          heading="Chats"
          actions={
            <Button asChild size="lg">
              <Link href="/conversations/new">New chat</Link>
            </Button>
          }
        />
      }
      notice={feedback ? <FeedbackNotice feedback={feedback} /> : undefined}
      error={loadError ? <FeedbackNotice feedback={loadError} /> : undefined}
      empty={
        <FeedbackNotice
          severity="neutral"
          title="No chats yet."
          message="Choose New chat to begin."
        />
      }
      footer={
        <>
          {status === "ready" && loadError ? <FeedbackNotice feedback={loadError} /> : null}
          <LoadMoreFooter
            hasMore={hasMore}
            loading={loadingMore}
            onLoadMore={loadMore}
            label="Load more conversations"
          />
        </>
      }
    />
  );
}
