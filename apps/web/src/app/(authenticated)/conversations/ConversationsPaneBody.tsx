"use client";

import { Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isInvalidViewError, type ApiError } from "@/lib/api/client";
import {
  type CollectionPage,
  NO_CURSOR,
  ZERO_REVISION,
} from "@/lib/api/collectionPage";
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
import SelectField from "@/components/ui/SelectField";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import PaneCollectionBar from "@/components/workspace/PaneCollectionBar";
import usePaneCollectionInput from "@/components/workspace/usePaneCollectionInput";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import { presentConversation } from "@/lib/collections/presenters/conversation";
import { fetchConversationIndex } from "@/lib/conversations/indexApi";
import { useConversationIndexRevision } from "@/lib/conversations/indexRevision";
import {
  CANONICAL_UPDATED_TITLE_INDEX_VIEW,
  UPDATED_TITLE_SORT_OPTION_IDS,
  decodeUpdatedTitleIndexView,
  encodeUpdatedTitleIndexView,
  type DecodedUpdatedTitleIndexView,
  type UpdatedTitleIndexView,
  type UpdatedTitleSortOptionId,
  updatedTitleSortOptionLabel,
  updatedTitleSortOptionOf,
  updatedTitleViewForSortOption,
} from "@/lib/collections/updatedTitleIndexView";
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
import type { PaneHeaderAction } from "@/lib/ui/actionDescriptor";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import { isAbortError } from "@/lib/errors";
import { useRevalidationSettlement } from "@/lib/panes/useRevalidationSettlement";

/** The chats index committed as one exact view: rows, revision, and cursor. */
interface CommittedChatsView extends ConversationsPaneSeed {
  readonly view: UpdatedTitleIndexView;
}

const CONVERSATIONS_VISIT_DATA = definePaneVisitDataKey<CommittedChatsView>(
  "Conversations.Pagination",
);
// Module-level so the published descriptor keeps one identity: the chrome
// republishes whenever an action's icon element changes.
const NEW_CHAT_ACTIONS: readonly PaneHeaderAction[] = [
  {
    kind: "link",
    id: "Conversations.New",
    label: "New chat",
    icon: <Plus size={16} aria-hidden="true" />,
    href: "/conversations/new",
  },
];

function conversationsErrorMessage(error: ApiError): FeedbackContent {
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
  const isPaneActive = usePaneIsActive();
  const indexChange = useConversationIndexRevision();
  const observedIndexRevisionRef = useRef(indexChange.revision);
  const renderEnvironment = useRenderEnvironment();
  // The pane URL owns the chats view through a strict, total codec; `view` is
  // null only for an Invalid URL, a terminal, user-recoverable state.
  const chatsViewCodec = useMemo(
    () => ({
      basePath: "/conversations",
      decode: decodeUpdatedTitleIndexView,
      encode: (
        decoded: DecodedUpdatedTitleIndexView,
        current: URLSearchParams,
      ): URLSearchParams =>
        encodeUpdatedTitleIndexView(
          decoded.kind === "Valid"
            ? decoded.view
            : CANONICAL_UPDATED_TITLE_INDEX_VIEW,
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
  const revalidation = useRevalidationSettlement();
  const completedConversationsRevalidationVersionRef = useRef<number | null>(
    null,
  );
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
  const [asyncDefect, setAsyncDefect] = useState<{ error: unknown } | null>(
    null,
  );
  const clearAllVisitData = useClearAllPaneVisitData();
  const capturePaneScroll = usePaneScrollRetention(listRegionRef, controller);
  // Set by a refresh so the already-committed view refetches once under a new
  // request identity; cleared by the commit that answers it. A view change needs
  // no flag — the requested and committed identities differ on their own.
  const refreshPendingRef = useRef(false);
  const sortSelectRef = useRef<HTMLSelectElement | null>(null);
  const setView = useCallback(
    (next: UpdatedTitleIndexView) => {
      capturePaneScroll();
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

      if (revalidation.isPending(firstPageVersion)) {
        completedConversationsRevalidationVersionRef.current = firstPageVersion;
      }
      return;
    }
    if (firstPage.status === "error") {
      if (isInvalidViewError(firstPage.error)) {
        setViewInvalid(true);
      } else {
        try {
          setFeedback(conversationsErrorMessage(firstPage.error));
        } catch (defect) {
          setAsyncDefect({ error: defect });
        }
      }

      if (revalidation.isPending(firstPageVersion)) {
        completedConversationsRevalidationVersionRef.current = null;
        revalidation.reject(firstPage.error);
      }
    }
  }, [revalidation, firstPage, firstPageVersion, view]);

  // A newly requested view retires the previous view's rejection.
  useEffect(() => setViewInvalid(false), [requestedViewKey]);

  useLayoutEffect(() => {
    committedSnapshotRef.current = requestsFirstPage ? null : controller;
    const completedVersion = completedConversationsRevalidationVersionRef.current;
    if (
      controller === null ||
      completedVersion === null ||
      !revalidation.isPending(completedVersion)
    ) {
      return;
    }
    completedConversationsRevalidationVersionRef.current = null;
    revalidation.resolve(completedVersion);
  }, [revalidation, controller, requestsFirstPage]);

  usePaneReturnReady(
    controller !== null || firstPage.status === "error" || invalidView,
  );

  const rejectPendingConversationsRevalidation = useCallback((error: unknown) => {
    completedConversationsRevalidationVersionRef.current = null;
    revalidation.reject(error);
  }, [revalidation]);
  const refreshIndex = useCallback(() => {
    rejectPendingConversationsRevalidation(
      new DOMException("Conversations refresh was superseded.", "AbortError"),
    );
    capturePaneScroll();
    refreshPendingRef.current = true;
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
  useEffect(() => {
    if (indexChange.revision === observedIndexRevisionRef.current) return;
    observedIndexRevisionRef.current = indexChange.revision;
    refreshIndex();
  }, [indexChange.revision, refreshIndex]);
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
      return revalidation.wait({
        requestId: version,
        signal,
        onAbort: () => {
          completedConversationsRevalidationVersionRef.current = null;
        },
      });
    },
    [refreshIndex, revalidation],
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
    active:
      isPaneActive && !invalidView && view !== null && controller !== null && !requestsFirstPage,
    chainKey: JSON.stringify([
      requestedViewKey,
      committedViewKey,
      invalidView,
      firstPageVersion,
      chainEpoch,
    ]),
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
      if (controller !== null && requestsFirstPage) {
        return {
          kind: "Retained" as const,
          visibleCount,
          loadedCount: rows.length,
          unit,
          cause: feedback === null ? "Updating" as const : "Failed" as const,
        };
      }
      if (
        (controller === null && firstPage.status === "error") ||
        exhaustion.kind === "ResumeFailed" ||
        exhaustion.kind === "RefreshRequired"
      ) {
        return { kind: "Failed" as const, visibleCount, loadedCount: rows.length, unit };
      }
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
    [controller, exhaustion.kind, feedback, firstPage.status, requestsFirstPage, rows],
  );
  const {
    query: filterQuery,
    onQueryChange,
    clearQuery,
    rowStatus,
  } = usePaneFilterRows({
    sourceKey: "Conversations:mine",
    getRowStatus: getFilterStatus,
  });
  const { inputRef, focusInput } = usePaneCollectionInput();
  const resetView = useCallback(() => {
    clearQuery();
    setView(CANONICAL_UPDATED_TITLE_INDEX_VIEW);
  }, [clearQuery, setView]);
  const domainFilterControls = useMemo(
    () =>
      invalidView || view === null ? undefined : (
        <>
          <SelectField
            layout="Inline"
            label="Sort chats"
            size="sm"
            ref={sortSelectRef}
            value={updatedTitleSortOptionOf(view)}
            onChange={(event) => {
              setView(
                updatedTitleViewForSortOption(
                  event.target.value as UpdatedTitleSortOptionId,
                ),
              );
            }}
          >
            {UPDATED_TITLE_SORT_OPTION_IDS.map((optionId) => (
              <option key={optionId} value={optionId}>
                {updatedTitleSortOptionLabel(optionId)}
              </option>
            ))}
          </SelectField>
        </>
      ),
    [invalidView, setView, view],
  );
  const collection = useMemo(
    () =>
      invalidView || view === null
        ? undefined
        : {
            label: "Filter chats",
            content: (
              <PaneCollectionBar
                inputRef={inputRef}
                inputLabel="Filter chats"
                placeholder="Filter chats"
                query={filterQuery}
                onQueryChange={onQueryChange}
                onClearQuery={clearQuery}
                rowStatus={rowStatus}
                filters={domainFilterControls}
                controls={view.kind !== "Canonical" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      sortSelectRef.current?.focus({ preventScroll: true });
                      resetView();
                    }}
                  >
                    Reset view
                  </Button>
                ) : undefined}
              />
            ),
            focusInput,
          },
    [
      resetView,
      clearQuery,
      domainFilterControls,
      filterQuery,
      focusInput,
      inputRef,
      invalidView,
      onQueryChange,
      rowStatus,
      view,
    ],
  );
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
    collection,
    refresh: {
      kind: "Refreshable",
      sourceKey: "Conversations:mine",
      execute: executeRefresh,
    },
    menuActions: NEW_CHAT_ACTIONS,
    header: {
      kind: "Section",
      meta: invalidView
        ? { kind: "None" }
        : finalCount === null ||
            status === "loading" ||
            requestsFirstPage ||
            exhaustion.kind !== "Complete"
          ? { kind: "Pending" }
          : { kind: "Count", value: finalCount, unit: "chat" },
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
              clearQuery();
              setDecodedView({
                kind: "Valid",
                view: CANONICAL_UPDATED_TITLE_INDEX_VIEW,
              });
              requestAnimationFrame(() => sortSelectRef.current?.focus({ preventScroll: true }));
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
        notice={
          controller !== null && feedback ? (
            <FeedbackNotice content={feedback} announcement="Assertive" />
          ) : controller === null &&
            status === "loading" &&
            filterQuery.trim() ? (
            <FeedbackNotice
              content={{
                tone: "Neutral",
                title: "No matching chat found so far.",
              }}
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
              content={{ tone: "Neutral", title: "No chats yet." }}
              announcement="None"
              actions={[
                {
                  label: "New chat",
                  onClick: () => runtime.router.push("/conversations/new"),
                },
              ]}
            />
          )
        }
        footer={<CollectionExhaustionNotice state={exhaustion} />}
      />
    </div>
  );
}
