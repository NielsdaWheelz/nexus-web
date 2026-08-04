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
import { type ApiError } from "@/lib/api/client";
import {
  type CollectionCursor,
  type CollectionPage,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import type { Presence } from "@/lib/api/presence";
import { conversationsInitialResource } from "@/lib/api/resource";
import { useExhaustivePagination } from "@/lib/api/useExhaustivePagination";
import { useResource } from "@/lib/api/useResource";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import SectionOpener from "@/components/ui/SectionOpener";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { presentConversation } from "@/lib/collections/presenters/conversation";
import { fetchConversationIndex } from "@/lib/conversations/indexApi";
import type { ConversationListItem } from "@/lib/conversations/types";
import {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneIsActive,
  usePaneReturnReady,
  usePaneVisitData,
} from "@/lib/panes/paneRuntime";
import type { ConversationsPaneSeed } from "@/lib/panes/paneResourceLoaders";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import { isAbortError } from "@/lib/errors";

const CONVERSATIONS_VISIT_DATA = definePaneVisitDataKey<ConversationsPaneSeed>(
  "Conversations.Pagination",
);
const NO_CURSOR: Presence<CollectionCursor> = { kind: "Absent" };
const ZERO_REVISION = 0 as CollectionRevision;
const PAGE_SIZE = 100;

function conversationsErrorMessage(
  error: ApiError,
  operation: "Load" | "Delete",
): FeedbackContent {
  if (operation === "Load") {
    switch (error.code) {
      case "E_NETWORK":
        return {
          tone: "Danger",
          requestId: error.requestId,
          title: "Chats couldn’t be loaded.",
        };
      default:
        throw error;
    }
  }

  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title: "It’s unclear whether the chat was deleted.",
        message: "Refresh your chats before trying again.",
      };
    case "E_CONVERSATION_NOT_FOUND":
      return {
        tone: "Danger",
        requestId: error.requestId,
        title: "This chat couldn’t be deleted.",
      };
    default:
      throw error;
  }
}

interface PendingConversationsRevalidation {
  readonly version: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly removeAbortListener: () => void;
}

function seedFromPage(
  page: CollectionPage<ConversationListItem>,
): ConversationsPaneSeed {
  return {
    conversations: page.items,
    collectionRevision: page.collectionRevision,
    nextCursor: page.nextCursor,
    exhaustion: page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
  };
}

export default function ConversationsPaneBody() {
  const isPaneActive = usePaneIsActive();
  const renderEnvironment = useRenderEnvironment();
  const committedSnapshotRef = useRef<ConversationsPaneSeed | null>(null);
  const captureCommitted = useCallback(() => committedSnapshotRef.current, []);
  const restored = usePaneVisitData(CONVERSATIONS_VISIT_DATA, captureCommitted);
  const allowResourceAdoptionRef = useRef(restored === null);
  const [firstPageVersion, setFirstPageVersion] = useState(0);
  const firstPageVersionRef = useRef(0);
  const pendingConversationsRevalidationRef =
    useRef<PendingConversationsRevalidation | null>(null);
  const completedConversationsRevalidationVersionRef =
    useRef<number | null>(null);
  const [refreshingIndex, setRefreshingIndex] = useState(false);
  const [chainEpoch, setChainEpoch] = useState(0);
  const [controller, setController] = useState<ConversationsPaneSeed | null>(
    restored,
  );
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(null);
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
      setRefreshingIndex(false);
      const pending = pendingConversationsRevalidationRef.current;
      if (pending?.version === firstPageVersion) {
        completedConversationsRevalidationVersionRef.current = pending.version;
      }
      return;
    }
    if (initial.status === "error" && allowResourceAdoptionRef.current) {
      setRefreshingIndex(false);
      try {
        setFeedback(conversationsErrorMessage(initial.error, "Load"));
      } catch (defect) {
        setAsyncDefect({ error: defect });
      }
      const pending = pendingConversationsRevalidationRef.current;
      if (pending?.version === firstPageVersion) {
        pendingConversationsRevalidationRef.current = null;
        completedConversationsRevalidationVersionRef.current = null;
        pending.removeAbortListener();
        pending.reject(initial.error);
      }
    }
  }, [firstPageVersion, initial]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = controller;
    const pending = pendingConversationsRevalidationRef.current;
    if (
      controller === null ||
      pending === null ||
      completedConversationsRevalidationVersionRef.current !== pending.version
    ) {
      return;
    }
    completedConversationsRevalidationVersionRef.current = null;
    pendingConversationsRevalidationRef.current = null;
    pending.removeAbortListener();
    pending.resolve();
  }, [controller]);

  usePaneReturnReady(controller !== null || initial.status === "error");

  const rejectPendingConversationsRevalidation = useCallback(
    (error: unknown) => {
      const pending = pendingConversationsRevalidationRef.current;
      pendingConversationsRevalidationRef.current = null;
      completedConversationsRevalidationVersionRef.current = null;
      if (!pending) return;
      pending.removeAbortListener();
      pending.reject(error);
    },
    [],
  );
  const refreshIndex = useCallback(() => {
    rejectPendingConversationsRevalidation(
      new DOMException("Conversations refresh was superseded.", "AbortError"),
    );
    allowResourceAdoptionRef.current = true;
    clearAllVisitData();
    setFeedback(null);
    setRefreshingIndex(true);
    const version = firstPageVersionRef.current + 1;
    firstPageVersionRef.current = version;
    setFirstPageVersion(version);
  }, [clearAllVisitData, rejectPendingConversationsRevalidation]);
  const revalidateIndex = useCallback(
    (signal: AbortSignal): Promise<void> => {
      if (signal.aborted) {
        return Promise.reject(
          signal.reason ??
            new DOMException(
              "Conversations refresh was aborted.",
              "AbortError",
            ),
        );
      }
      refreshIndex();
      const version = firstPageVersionRef.current;
      return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const pending = pendingConversationsRevalidationRef.current;
          if (pending?.version !== version) return;
          pendingConversationsRevalidationRef.current = null;
          completedConversationsRevalidationVersionRef.current = null;
          pending.removeAbortListener();
          allowResourceAdoptionRef.current = false;
          setRefreshingIndex(false);
          reject(
            signal.reason ??
              new DOMException(
                "Conversations refresh was aborted.",
                "AbortError",
              ),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pendingConversationsRevalidationRef.current = {
          version,
          resolve,
          reject,
          removeAbortListener: () =>
            signal.removeEventListener("abort", onAbort),
        };
        if (signal.aborted) onAbort();
      });
    },
    [refreshIndex],
  );
  useEffect(
    () => () => {
      rejectPendingConversationsRevalidation(
        new DOMException(
          "Conversations refresh source was replaced.",
          "AbortError",
        ),
      );
    },
    [rejectPendingConversationsRevalidation],
  );

  const commitPage = useCallback(
    (page: CollectionPage<ConversationListItem>): number => {
      const current = committedSnapshotRef.current;
      if (
        current === null ||
        current.collectionRevision !== page.collectionRevision
      ) {
        throw new Error(
          "Conversation continuation settled for a stale collection",
        );
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
        exhaustion: page.nextCursor.kind === "Absent" ? "Complete" : "Partial",
      };
      committedSnapshotRef.current = next;
      setController(next);
      return conversations.length;
    },
    [],
  );

  const exhaustion = useExhaustivePagination<ConversationListItem>({
    active: isPaneActive && controller !== null && !refreshingIndex,
    chainKey: `mine:${chainEpoch}`,
    cursor: controller?.nextCursor ?? NO_CURSOR,
    collectionRevision: controller?.collectionRevision ?? ZERO_REVISION,
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

  const rows = useMemo(
    () =>
      (controller?.conversations ?? []).map((conversation) =>
        presentConversation(conversation, renderEnvironment),
      ),
    [controller?.conversations, renderEnvironment],
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
  const getFilterStatus = useCallback(
    (query: string) => {
      const visibleCount = rows.filter((row) =>
        matchesPaneFilterQuery(query, [row.title.text]),
      ).length;
      const unit = { singular: "chat", plural: "chats" };
      return exhaustion.kind === "Complete"
        ? {
            kind: "Complete" as const,
            visibleCount,
            totalCount: rows.length,
            unit,
          }
        : {
            kind: "Partial" as const,
            visibleCount,
            loadedCount: rows.length,
            unit,
          };
    },
    [exhaustion.kind, rows],
  );
  const { query: filterQuery, publication: search } = usePaneFilterRows({
    sourceKey: "Conversations:mine",
    inputLabel: "Filter chats",
    placeholder: "Filter chats",
    getRowStatus: getFilterStatus,
    activeDomainControlCount: 0,
  });
  const filteredRows = useMemo(
    () =>
      rows.filter((row) =>
        matchesPaneFilterQuery(filterQuery, [row.title.text]),
      ),
    [filterQuery, rows],
  );
  const executeRefresh = useCallback(
    async ({ signal }: { readonly signal: AbortSignal }) => {
      try {
        await revalidateIndex(signal);
        return {
          kind: "Complete" as const,
          announcement: "Conversations refreshed",
        };
      } catch (refreshError: unknown) {
        if (isAbortError(refreshError)) throw refreshError;
        return {
          kind: "Failed" as const,
          announcement: "Conversations failed to refresh",
        };
      }
    },
    [revalidateIndex],
  );
  usePanePrimaryChrome({
    search,
    refresh: {
      sourceKey: "Conversations:mine",
      execute: executeRefresh,
    },
    header: {
      kind: "section",
      folio:
        finalCount === null
          ? { kind: "none" }
          : { kind: "count", value: finalCount, unit: "chat" },
      pending:
        status === "loading" ||
        refreshingIndex ||
        exhaustion.kind !== "Complete",
    },
  });

  if (asyncDefect !== null) throw asyncDefect.error;

  return (
    <CollectionView
      returnScope="Conversations.Items"
      rows={filteredRows}
      status={status}
      ariaLabel="Conversations"
      rowChangePresentation={{
        kind: "ImmediateOnKeyChange",
        key: filterQuery.trim(),
      }}
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
        controller !== null && feedback ? (
          <FeedbackNotice content={feedback} announcement="Assertive" />
        ) : controller === null && status === "loading" && filterQuery.trim() ? (
          <FeedbackNotice
            content={{ tone: "Neutral", title: "No matching chat found so far." }}
            announcement="None"
          />
        ) : undefined
      }
      error={
        controller === null && feedback ? (
          <FeedbackNotice content={feedback} announcement="Assertive" />
        ) : undefined
      }
      empty={
        filterQuery.trim() ? (
          <FeedbackNotice
            content={{
              tone: "Neutral",
              title:
                exhaustion.kind === "Complete"
                  ? "No chats match this filter."
                  : "No matching chat found so far.",
            }}
            announcement="None"
          />
        ) : (
          <FeedbackNotice
            content={{
              tone: "Neutral",
              title: "No chats yet.",
              message: "Choose New chat to begin.",
            }}
            announcement="None"
          />
        )
      }
      footer={<CollectionExhaustionNotice state={exhaustion} />}
    />
  );
}
