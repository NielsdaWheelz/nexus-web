"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { conversationsInitialResource, type NoResourceParams } from "@/lib/api/resource";
import { useResource } from "@/lib/api/useResource";
import type { CursorPage } from "@/lib/api/useCursorPagination";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import { presentConversation } from "@/lib/collections/presenters/conversation";
import type { ConversationSummary } from "@/lib/conversations/types";
import {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneReturnReady,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";

interface ConversationsSnapshot {
  readonly conversations: readonly ConversationSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

const CONVERSATIONS_VISIT_DATA =
  definePaneVisitDataKey<ConversationsSnapshot>("Conversations.Pagination");

export default function ConversationsPaneBody() {
  const committedSnapshotRef = useRef<ConversationsSnapshot | null>(null);
  const captureCommitted = useCallback(
    () => committedSnapshotRef.current,
    [],
  );
  const restored = usePaneVisitData(
    CONVERSATIONS_VISIT_DATA,
    captureCommitted,
  );
  const restoredAtMountRef = useRef(restored !== null);
  const [controller, setController] = useState<ConversationsSnapshot | null>(
    restored,
  );
  const firstPage = useResource<CursorPage<ConversationSummary>, NoResourceParams>({
    descriptor: conversationsInitialResource,
    params: restored === null ? {} : null,
  });
  const clearAllVisitData = useClearAllPaneVisitData();
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<FeedbackContent | null>(null);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  useEffect(() => {
    if (restoredAtMountRef.current || firstPage.status !== "ready") {
      return;
    }
    setController({
      conversations: firstPage.data.data,
      nextCursor: firstPage.data.page.next_cursor,
      hasMore: firstPage.data.page.has_more,
    });
  }, [firstPage]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = controller;
  }, [controller]);

  usePaneReturnReady(
    controller !== null || firstPage.status === "error",
  );

  const loadMore = useCallback(async () => {
    const cursor = controller?.nextCursor ?? null;
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await apiFetch<CursorPage<ConversationSummary>>(
        `/api/conversations?${new URLSearchParams({ limit: "50", cursor })}`,
      );
      setController((current) =>
        current === null
          ? current
          : {
              conversations: [...current.conversations, ...page.data],
              nextCursor: page.page.next_cursor,
              hasMore: page.page.has_more,
            },
      );
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      setMoreError(
        toFeedback(error, { fallback: "Failed to load more conversations" }),
      );
    } finally {
      setLoadingMore(false);
    }
  }, [controller?.nextCursor, loadingMore]);

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm("Delete this conversation? This cannot be undone.")) return;
      try {
        await apiFetch(`/api/conversations/${id}`, { method: "DELETE" });
        setController((current) =>
          current === null
            ? current
            : {
                ...current,
                conversations: current.conversations.filter(
                  (conversation) => conversation.id !== id,
                ),
              },
        );
        clearAllVisitData();
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return;
        setFeedback(toFeedback(err, { fallback: "Failed to delete conversation" }));
      }
    },
    [clearAllVisitData],
  );

  const rows = (controller?.conversations ?? [])
    .map((conversation) =>
      presentConversation(conversation, {
        onDelete: () => void handleDelete(conversation.id),
      }),
    );

  const firstPageError =
    controller === null && firstPage.status === "error"
      ? toFeedback(firstPage.error, {
          fallback: "Failed to load conversations",
        })
      : null;
  const loadError = firstPageError ?? moreError;
  const status =
    controller !== null
      ? "ready"
      : firstPage.status === "error"
        ? "error"
        : "loading";

  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio: { kind: "count", value: rows.length, unit: "chat" },
      pending: status === "loading",
    },
  });

  return (
    <CollectionView
      returnScope="Conversations.Items"
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
            hasMore={controller?.hasMore ?? false}
            loading={loadingMore}
            onLoadMore={loadMore}
            label="Load more conversations"
          />
        </>
      }
    />
  );
}
