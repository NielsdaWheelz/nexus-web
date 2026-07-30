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
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
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
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
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
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import { useStringIdSet } from "@/lib/useStringIdSet";
import { findPaneSearchFocusTarget } from "@/lib/workspace/paneDom";
import { isAbortError } from "@/lib/errors";

const CONVERSATIONS_VISIT_DATA = definePaneVisitDataKey<ConversationsPaneSeed>(
  "Conversations.Pagination",
);
const NO_CURSOR: Presence<CollectionCursor> = { kind: "Absent" };
const ZERO_REVISION = 0 as CollectionRevision;
const PAGE_SIZE = 100;

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
  const runtime = requirePaneRuntime(usePaneRuntime(), "ConversationsPaneBody");
  const visibleRowIdsRef = useRef<readonly string[]>([]);
  const pendingFocusNeighborRef = useRef<string | null | undefined>(undefined);
  const pendingFocusRafRef = useRef(0);
  const setFocusNeighbor = useCallback((removedId: string) => {
    const visibleIds = visibleRowIdsRef.current;
    const index = visibleIds.indexOf(removedId);
    pendingFocusNeighborRef.current =
      index < 0
        ? null
        : (visibleIds[index + 1] ?? visibleIds[index - 1] ?? null);
  }, []);
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
      setRefreshingIndex(false);
      const pending = pendingConversationsRevalidationRef.current;
      if (pending?.version === firstPageVersion) {
        completedConversationsRevalidationVersionRef.current = pending.version;
      }
      return;
    }
    if (initial.status === "error" && allowResourceAdoptionRef.current) {
      setRefreshingIndex(false);
      setFeedback(
        toFeedback(initial.error, {
          fallback: "Failed to load conversations",
        }),
      );
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
    active: runtime.isActive && controller !== null && !refreshingIndex,
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

  const handleDelete = useCallback(
    async (id: string, triggerEl: HTMLButtonElement | null) => {
      if (!confirm("Delete this conversation? This cannot be undone.")) return;
      if (deletingConversationIds.has(id)) return;
      deletingConversationIds.add(id);
      try {
        const collectionRevision = await deleteConversation(id);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        const activeElement = document.activeElement;
        if (
          activeElement === document.body ||
          activeElement === triggerEl ||
          (activeElement instanceof HTMLElement && !activeElement.isConnected)
        ) {
          setFocusNeighbor(id);
        }
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
        pendingFocusNeighborRef.current = undefined;
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
    [clearAllVisitData, deletingConversationIds, setFocusNeighbor],
  );

  const rows = useMemo(
    () =>
      (controller?.conversations ?? []).map((conversation) =>
        presentConversation(
          conversation,
          {
            deleteConversation: {
              kind: "Available",
              execute: ({ triggerEl }) =>
                handleDelete(conversation.id, triggerEl),
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
  visibleRowIdsRef.current = filteredRows.map((row) => row.id);
  const visibleRowSignature = visibleRowIdsRef.current.join("\u001f");
  useEffect(() => {
    const neighborId = pendingFocusNeighborRef.current;
    if (neighborId === undefined) return;
    const focus = () => {
      if (pendingFocusNeighborRef.current !== neighborId) return;
      pendingFocusNeighborRef.current = undefined;
      const pane = Array.from(
        document.querySelectorAll<HTMLElement>("[data-pane-id]"),
      ).find((candidate) => candidate.dataset.paneId === runtime.paneId);
      const row =
        neighborId === null
          ? null
          : pane?.querySelector<HTMLElement>(
              `[data-collection-row-id="${CSS.escape(neighborId)}"]`,
            );
      const focusable = row?.querySelector<HTMLElement>(
        'a, button, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable) {
        focusable.focus();
        return;
      }
      findPaneSearchFocusTarget(runtime.paneId)?.focus();
    };
    const outer = requestAnimationFrame(() => {
      pendingFocusRafRef.current = requestAnimationFrame(focus);
    });
    pendingFocusRafRef.current = outer;
    return () => cancelAnimationFrame(pendingFocusRafRef.current);
  }, [runtime.paneId, visibleRowSignature]);

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
          <FeedbackNotice feedback={feedback} />
        ) : controller === null && status === "loading" && filterQuery.trim() ? (
          <FeedbackNotice
            severity="neutral"
            title="No matching chat found so far."
          />
        ) : undefined
      }
      error={
        controller === null && feedback ? (
          <FeedbackNotice feedback={feedback} />
        ) : undefined
      }
      empty={
        filterQuery.trim() ? (
          <FeedbackNotice
            severity="neutral"
            title={
              exhaustion.kind === "Complete"
                ? "No chats match this filter."
                : "No matching chat found so far."
            }
          />
        ) : (
        <FeedbackNotice
          severity="neutral"
          title="No chats yet."
          message="Choose New chat to begin."
        />
        )
      }
      footer={<CollectionExhaustionNotice state={exhaustion} />}
    />
  );
}
