"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import {
  type CollectionCursor,
  type CollectionPage,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import { conversationsInitialResource } from "@/lib/api/resource";
import { useExhaustivePagination } from "@/lib/api/useExhaustivePagination";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice, toFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { RESOURCE_ACTION_CATALOG } from "@/lib/actions/resourceActions";
import { presentConversation } from "@/lib/collections/presenters/conversation";
import {
  deleteConversation,
  fetchConversationIndex,
} from "@/lib/conversations/indexApi";
import type { ConversationListItem } from "@/lib/conversations/types";
import {
  definePaneVisitDataKey,
  requirePaneRuntime,
  useClearAllPaneVisitData,
  usePaneReturnReady,
  usePaneRuntime,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";
import type { ConversationsPaneSeed } from "@/lib/panes/paneResourceLoaders";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import { useStringIdSet } from "@/lib/useStringIdSet";

const CONVERSATIONS_VISIT_DATA =
  definePaneVisitDataKey<ConversationsPaneSeed>("Conversations.Pagination");
const NO_CURSOR: Presence<CollectionCursor> = { kind: "Absent" };
const ZERO_REVISION = 0 as CollectionRevision;
const PAGE_SIZE = 100;

function seedFromPage(
  page: CollectionPage<ConversationListItem>,
): ConversationsPaneSeed {
  return {
    conversations: page.items,
    collectionRevision: page.collectionRevision,
    nextCursor: page.nextCursor,
    exhaustion:
      page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
  };
}

export default function ConversationsPaneBody() {
  const runtime = requirePaneRuntime(
    usePaneRuntime(),
    "ConversationsPaneBody",
  );
  const renderEnvironment = useRenderEnvironment();
  const committedSnapshotRef = useRef<ConversationsPaneSeed | null>(null);
  const captureCommitted = useCallback(
    () => committedSnapshotRef.current,
    [],
  );
  const restored = usePaneVisitData(
    CONVERSATIONS_VISIT_DATA,
    captureCommitted,
  );
  const allowResourceAdoptionRef = useRef(restored === null);
  const [firstPageVersion, setFirstPageVersion] = useState(0);
  const [chainEpoch, setChainEpoch] = useState(0);
  const [controller, setController] =
    useState<ConversationsPaneSeed | null>(restored);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const deletingConversationIds = useStringIdSet();
  const clearAllVisitData = useClearAllPaneVisitData();
  const initial = useResource<ConversationsPaneSeed>({
    cacheKey:
      restored === null || firstPageVersion > 0
        ? firstPageVersion === 0
          ? conversationsInitialResource.cacheKey({})
          : `${conversationsInitialResource.cacheKey({})}:collection:${firstPageVersion}`
        : null,
    load: async (signal) =>
      seedFromPage(
        await fetchConversationIndex({
          limit: PAGE_SIZE,
          signal,
        }),
      ),
  });

  useEffect(() => {
    if (initial.status === "ready" && allowResourceAdoptionRef.current) {
      allowResourceAdoptionRef.current = false;
      committedSnapshotRef.current = initial.data;
      setController(initial.data);
      setChainEpoch((epoch) => epoch + 1);
      setFeedback(null);
      return;
    }
    if (initial.status === "error" && allowResourceAdoptionRef.current) {
      setFeedback(
        toFeedback(initial.error, {
          fallback: "Failed to load conversations",
        }),
      );
    }
  }, [initial]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = controller;
  }, [controller]);

  usePaneReturnReady(
    controller !== null || initial.status === "error",
  );

  const refreshIndex = useCallback(() => {
    allowResourceAdoptionRef.current = true;
    clearAllVisitData();
    setFeedback(null);
    setFirstPageVersion((version) => version + 1);
  }, [clearAllVisitData]);

  const commitPage = useCallback(
    (page: CollectionPage<ConversationListItem>): number => {
      const current = committedSnapshotRef.current;
      if (
        current === null ||
        current.collectionRevision !== page.collectionRevision
      ) {
        throw new Error("Conversation continuation settled for a stale collection");
      }
      const seen = new Set(
        current.conversations.map((conversation) => conversation.id),
      );
      const conversations = [...current.conversations];
      for (const conversation of page.items) {
        if (seen.has(conversation.id)) continue;
        seen.add(conversation.id);
        conversations.push(conversation);
      }
      const next: ConversationsPaneSeed = {
        conversations,
        collectionRevision: page.collectionRevision,
        nextCursor: page.nextCursor,
        exhaustion:
          page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
      };
      committedSnapshotRef.current = next;
      setController(next);
      return conversations.length;
    },
    [],
  );

  const exhaustion = useExhaustivePagination<ConversationListItem>({
    active: runtime.isActive && controller !== null,
    chainKey: `mine:${chainEpoch}`,
    cursor: controller?.nextCursor ?? NO_CURSOR,
    collectionRevision:
      controller?.collectionRevision ?? ZERO_REVISION,
    itemCount: controller?.conversations.length ?? 0,
    loadPage: (cursor, collectionRevision, signal) =>
      fetchConversationIndex({
        cursor,
        collectionRevision,
        limit: PAGE_SIZE,
        signal,
      }),
    commitPage,
    refresh: refreshIndex,
  });

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm("Delete this conversation? This cannot be undone.")) return;
      if (deletingConversationIds.has(id)) return;
      deletingConversationIds.add(id);
      try {
        const collectionRevision = await deleteConversation(id);
        setController((current) => {
          if (current === null) return current;
          const next = {
            ...current,
            conversations: current.conversations.filter(
              (conversation) => conversation.id !== id,
            ),
            collectionRevision,
          };
          committedSnapshotRef.current = next;
          return next;
        });
        setChainEpoch((epoch) => epoch + 1);
        clearAllVisitData();
      } catch (error) {
        if (handleUnauthenticatedApiError(error)) return;
        if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
        setFeedback(
          toFeedback(error, {
            fallback: "Failed to delete conversation",
          }),
        );
      } finally {
        deletingConversationIds.remove(id);
      }
    },
    [clearAllVisitData, deletingConversationIds],
  );

  const rows = useMemo(
    () =>
      (controller?.conversations ?? []).map((conversation) =>
        presentConversation(
          conversation,
          {
            deleteConversation: {
              kind: "Available",
              execute: () => handleDelete(conversation.id),
            },
            busyIds: deletingConversationIds.ids.has(conversation.id)
              ? new Set([RESOURCE_ACTION_CATALOG.DeleteConversation.id])
              : new Set(),
          },
          renderEnvironment,
        ),
      ),
    [
      controller?.conversations,
      deletingConversationIds.ids,
      handleDelete,
      renderEnvironment,
    ],
  );
  const status =
    controller !== null
      ? "ready"
      : initial.status === "error"
        ? "error"
        : "loading";
  const finalCount =
    controller !== null && exhaustion.kind === "Complete"
      ? exhaustion.itemCount
      : null;

  usePanePrimaryChrome({
    header: {
      kind: "section",
      folio:
        finalCount === null
          ? { kind: "none" }
          : { kind: "count", value: finalCount, unit: "chat" },
      pending: status === "loading" || exhaustion.kind === "Draining",
    },
  });

  return (
    <CollectionView
      returnScope="Conversations.Items"
      rows={rows}
      status={status}
      ariaLabel="Conversations"
      collectionBusy={exhaustion.kind === "Draining"}
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
      notice={
        controller !== null && feedback
          ? <FeedbackNotice feedback={feedback} />
          : undefined
      }
      error={
        controller === null && feedback
          ? <FeedbackNotice feedback={feedback} />
          : undefined
      }
      empty={
        <FeedbackNotice
          severity="neutral"
          title="No chats yet."
          message="Choose New chat to begin."
        />
      }
      footer={<CollectionExhaustionNotice state={exhaustion} />}
    />
  );
}
