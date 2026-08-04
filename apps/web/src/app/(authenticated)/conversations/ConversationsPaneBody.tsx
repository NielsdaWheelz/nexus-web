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
import { isApiError, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
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
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import SectionOpener from "@/components/ui/SectionOpener";
import SelectField from "@/components/ui/SelectField";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import { RESOURCE_ACTION_CATALOG } from "@/lib/actions/resourceActions";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import { presentConversation } from "@/lib/collections/presenters/conversation";
import {
  deleteConversation,
  fetchConversationIndex,
} from "@/lib/conversations/indexApi";
import {
  CANONICAL_CONVERSATION_INDEX_VIEW,
  CONVERSATION_SORT_OPTION_IDS,
  conversationSortOptionLabel,
  conversationSortOptionOf,
  conversationViewForSortOption,
  decodeConversationIndexView,
  encodeConversationIndexView,
  type ConversationIndexView,
  type ConversationSortOptionId,
  type DecodedConversationIndexView,
} from "@/lib/conversations/indexView";
import type { ConversationListItem } from "@/lib/conversations/types";
import usePaneScrollRetention from "@/lib/panes/usePaneScrollRetention";
import {
  definePaneVisitDataKey,
  requirePaneRuntime,
  useClearAllPaneVisitData,
  usePaneIsActive,
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

/** The chats index committed as one exact view: rows, revision, and cursor. */
interface CommittedChatsView extends ConversationsPaneSeed {
  readonly view: ConversationIndexView;
}

const CONVERSATIONS_VISIT_DATA = definePaneVisitDataKey<CommittedChatsView>(
  "Conversations.Pagination",
);
const NO_CURSOR: Presence<CollectionCursor> = { kind: "Absent" };
const ZERO_REVISION = 0 as CollectionRevision;

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

// The one code that turns a first-page failure into the "Invalid chats view"
// terminal state: the backend rejects a bad view/cursor with these codes.
function isInvalidViewError(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === "E_INVALID_REQUEST" || error.code === "E_INVALID_CURSOR")
  );
}

export default function ConversationsPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "ConversationsPaneBody");
  const isPaneActive = usePaneIsActive();
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
  // The pane URL owns the chats view through a strict, total codec; `view` is
  // null only for an Invalid URL, a terminal, user-recoverable state.
  const chatsViewCodec = useMemo(
    () => ({
      basePath: "/conversations",
      decode: decodeConversationIndexView,
      encode: (
        decoded: DecodedConversationIndexView,
        current: URLSearchParams,
      ): URLSearchParams =>
        encodeConversationIndexView(
          decoded.kind === "Valid"
            ? decoded.view
            : CANONICAL_CONVERSATION_INDEX_VIEW,
          current,
        ),
      replaceOptions: {
        viewTransition: { kind: "collection-reflow" as const },
      },
    }),
    [],
  );
  const { state: decodedView, setState: setDecodedView } =
    usePaneUrlState(chatsViewCodec);
  const view = decodedView.kind === "Valid" ? decodedView.view : null;
  // Set when the backend rejects the requested view; cleared whenever another
  // view is requested.
  const [viewInvalid, setViewInvalid] = useState(false);
  const invalidView = decodedView.kind === "Invalid" || viewInvalid;
  const listRegionRef = useRef<HTMLDivElement | null>(null);
  const committedSnapshotRef = useRef<CommittedChatsView | null>(null);
  const captureCommitted = useCallback(() => committedSnapshotRef.current, []);
  const restored = usePaneVisitData(CONVERSATIONS_VISIT_DATA, captureCommitted);
  const initialRestored = useRef(restored).current;
  const [firstPageVersion, setFirstPageVersion] = useState(0);
  const firstPageVersionRef = useRef(0);
  const pendingConversationsRevalidationRef =
    useRef<PendingConversationsRevalidation | null>(null);
  const completedConversationsRevalidationVersionRef =
    useRef<number | null>(null);
  const [chainEpoch, setChainEpoch] = useState(0);
  const [controller, setController] = useState<CommittedChatsView | null>(
    initialRestored,
  );
  if (
    committedSnapshotRef.current === null &&
    initialRestored !== null &&
    controller === initialRestored
  ) {
    committedSnapshotRef.current = initialRestored;
  }
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(null);
  const deletingConversationIds = useStringIdSet();
  const clearAllVisitData = useClearAllPaneVisitData();
  const capturePaneScroll = usePaneScrollRetention(listRegionRef, controller);
  // Set by a refresh so the already-committed view refetches once under a new
  // request identity; cleared by the commit that answers it. A view change needs
  // no flag — the requested and committed identities differ on their own.
  const refreshPendingRef = useRef(false);
  const sortSelectRef = useRef<HTMLSelectElement | null>(null);
  // Set before a view replacement the user initiated from the sort control, so
  // the commit that answers it returns focus there.
  const pendingCommitFocusRef = useRef(false);
  const focusPendingSortControl = useCallback(() => {
    if (!pendingCommitFocusRef.current) return;
    pendingCommitFocusRef.current = false;
    const element = sortSelectRef.current;
    if (element === null) return;
    requestAnimationFrame(() => element.focus());
  }, []);
  const setView = useCallback(
    (next: ConversationIndexView) => {
      capturePaneScroll();
      committedSnapshotRef.current = null;
      setDecodedView({ kind: "Valid", view: next });
    },
    [capturePaneScroll, setDecodedView],
  );

  const requestedViewKey =
    view === null ? null : conversationsInitialResource.cacheKey({ view });
  const committedViewKey =
    controller === null
      ? null
      : conversationsInitialResource.cacheKey({ view: controller.view });
  // The canonical first page is the route's server seed; every other exact view
  // and every refresh owns its own request under its own identity.
  const requestsFirstPage =
    view !== null &&
    !viewInvalid &&
    (controller === null ||
      requestedViewKey !== committedViewKey ||
      refreshPendingRef.current);
  const firstPageRequestKey =
    requestsFirstPage && requestedViewKey !== null
      ? firstPageVersion === 0
        ? requestedViewKey
        : `${requestedViewKey}:collection:${firstPageVersion}`
      : null;
  const firstPage = useResource<ConversationsPaneSeed>({
    cacheKey: firstPageRequestKey,
    load: async (signal) => {
      if (view === null) {
        // justify-defect: a non-null request key is built from this exact view.
        throw new Error("Chats index request lost its view identity");
      }
      return seedFromPage(await fetchConversationIndex({ view, signal }));
    },
  });

  // Latest-wins atomic commit: the resource reports a result only for the
  // current request identity, so a superseded view can never install its rows.
  useEffect(() => {
    if (firstPage.status === "ready" && view !== null) {
      refreshPendingRef.current = false;
      const committed: CommittedChatsView = { ...firstPage.data, view };
      committedSnapshotRef.current = committed;
      setController(committed);
      setChainEpoch((epoch) => epoch + 1);
      setFeedback(null);
      focusPendingSortControl();
      const pending = pendingConversationsRevalidationRef.current;
      if (pending?.version === firstPageVersion) {
        completedConversationsRevalidationVersionRef.current = pending.version;
      }
      return;
    }
    if (firstPage.status === "error") {
      if (isInvalidViewError(firstPage.error)) {
        setViewInvalid(true);
      } else {
        try {
          setFeedback(conversationsErrorMessage(firstPage.error, "Load"));
        } catch (defect) {
          setAsyncDefect({ error: defect });
        }
      }
      const pending = pendingConversationsRevalidationRef.current;
      if (pending?.version === firstPageVersion) {
        pendingConversationsRevalidationRef.current = null;
        completedConversationsRevalidationVersionRef.current = null;
        pending.removeAbortListener();
        pending.reject(firstPage.error);
      }
    }
  }, [firstPage, firstPageVersion, focusPendingSortControl, view]);

  // A newly requested view retires the previous view's rejection.
  useEffect(() => setViewInvalid(false), [requestedViewKey]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = requestsFirstPage ? null : controller;
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
  }, [controller, requestsFirstPage]);

  usePaneReturnReady(
    controller !== null || firstPage.status === "error" || invalidView,
  );

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
    capturePaneScroll();
    refreshPendingRef.current = true;
    committedSnapshotRef.current = null;
    clearAllVisitData();
    setFeedback(null);
    const version = firstPageVersionRef.current + 1;
    firstPageVersionRef.current = version;
    setFirstPageVersion(version);
  }, [
    capturePaneScroll,
    clearAllVisitData,
    rejectPendingConversationsRevalidation,
  ]);
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
      const next: CommittedChatsView = {
        ...current,
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

  // Continuation runs only while the committed view is the requested one, and
  // every page of a chain carries that same view.
  const exhaustion = useExhaustivePagination<ConversationListItem>({
    active: isPaneActive && controller !== null && !requestsFirstPage,
    chainKey: `${committedViewKey ?? ""}:${chainEpoch}`,
    cursor: controller?.nextCursor ?? NO_CURSOR,
    collectionRevision: controller?.collectionRevision ?? ZERO_REVISION,
    itemCount: controller?.conversations.length ?? 0,
    loadPage: (cursor, collectionRevision, signal) => {
      if (controller === null) {
        // justify-defect: continuation runs only over a committed exact view.
        throw new Error("Chats continuation lost its committed view");
      }
      return fetchConversationIndex({
        view: controller.view,
        cursor,
        collectionRevision,
        signal,
      });
    },
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
        if (!isApiError(error) || isSameSystemApiDefect(error)) {
          setAsyncDefect({ error });
          return;
        }
        try {
          setFeedback(conversationsErrorMessage(error, "Delete"));
        } catch (defect) {
          setAsyncDefect({ error: defect });
        }
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
      : firstPage.status === "error"
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
  const dismissFilterRowsRef = useRef<() => void>(() => undefined);
  const clearDomainFilters = useCallback(() => {
    dismissFilterRowsRef.current();
    pendingCommitFocusRef.current = true;
    setView(CANONICAL_CONVERSATION_INDEX_VIEW);
  }, [setView]);
  const domainFilterControls = useMemo(
    () =>
      invalidView || view === null ? undefined : (
        <>
          <SelectField
            layout="Stacked"
            label="Sort by"
            ref={sortSelectRef}
            value={conversationSortOptionOf(view)}
            onChange={(event) => {
              pendingCommitFocusRef.current = true;
              setView(
                conversationViewForSortOption(
                  event.target.value as ConversationSortOptionId,
                ),
              );
            }}
          >
            {CONVERSATION_SORT_OPTION_IDS.map((optionId) => (
              <option key={optionId} value={optionId}>
                {conversationSortOptionLabel(optionId)}
              </option>
            ))}
          </SelectField>
          {view.kind === "Canonical" ? null : (
            <Button variant="secondary" size="sm" onClick={clearDomainFilters}>
              Clear filters
            </Button>
          )}
        </>
      ),
    [clearDomainFilters, invalidView, setView, view],
  );
  const { query: filterQuery, publication: search } = usePaneFilterRows({
    sourceKey: "Conversations:mine",
    inputLabel: "Filter chats",
    placeholder: "Filter chats",
    getRowStatus: getFilterStatus,
    // Truthful while the controls are published; an invalid view publishes none.
    activeDomainControlCount:
      invalidView || view === null || view.kind === "Canonical" ? 0 : 1,
    filters: domainFilterControls,
  });
  dismissFilterRowsRef.current = search.onDismiss;
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
        finalCount === null || invalidView
          ? { kind: "none" }
          : { kind: "count", value: finalCount, unit: "chat" },
      pending:
        !invalidView &&
        (status === "loading" ||
          requestsFirstPage ||
          exhaustion.kind !== "Complete"),
    },
  });

  if (asyncDefect !== null) throw asyncDefect.error;

  if (invalidView) {
    return (
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid chats view" }}
        announcement="Assertive"
        actions={[
          {
            label: "Reset view",
            onClick: () => {
              search.onDismiss();
              setDecodedView({
                kind: "Valid",
                view: CANONICAL_CONVERSATION_INDEX_VIEW,
              });
            },
          },
        ]}
      />
    );
  }

  return (
    <div ref={listRegionRef}>
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
    </div>
  );
}
