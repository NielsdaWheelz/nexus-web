"use client";

import { Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import SelectField from "@/components/ui/SelectField";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import PaneCollectionBar from "@/components/workspace/PaneCollectionBar";
import usePaneCollectionInput from "@/components/workspace/usePaneCollectionInput";
import { NO_CURSOR, ZERO_REVISION } from "@/lib/api/collectionPage";
import { conversationsInitialResource } from "@/lib/api/resource";
import { useExhaustivePagination } from "@/lib/api/useExhaustivePagination";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import { useResource } from "@/lib/api/useResource";
import {
  fetchConversationIndex,
  useConversationIndexRevision,
  type ConversationListItem,
} from "@/lib/chat/conversationIndex";
import { presentConversation } from "@/lib/collections/presenters/conversation";
import {
  CANONICAL_UPDATED_TITLE_INDEX_VIEW as CANONICAL,
  decodeUpdatedTitleIndexView,
  encodeUpdatedTitleIndexView,
  UPDATED_TITLE_SORT_OPTION_IDS,
  updatedTitleSortOptionLabel,
  updatedTitleSortOptionOf,
  updatedTitleViewForSortOption,
  type DecodedUpdatedTitleIndexView,
  type UpdatedTitleIndexView,
  type UpdatedTitleSortOptionId,
} from "@/lib/collections/updatedTitleIndexView";
import { isAbortError } from "@/lib/errors";
import type { ConversationsPaneSeed } from "@/lib/panes/paneResourceLoaders";
import {
  requirePaneRuntime,
  usePaneIsActive,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { PaneHeaderAction } from "@/lib/ui/actionDescriptor";
import {
  definePaneVisitDataKey,
  useClearAllPaneVisitData,
  usePaneReturnReady,
  usePaneScrollRetention,
  usePaneVisitData,
} from "@/lib/workspace/paneReturnMemento";

/** The committed index: one exact view's rows, revision and cursor, per refresh. */
type Committed = ConversationsPaneSeed & {
  readonly view: UpdatedTitleIndexView;
  readonly version: number;
};

const VISIT_DATA = definePaneVisitDataKey<Committed>(
  "Conversations.Pagination",
);
const NEW_CHAT: readonly PaneHeaderAction[] = [
  {
    kind: "link",
    id: "Conversations.New",
    label: "New chat",
    icon: <Plus size={16} aria-hidden="true" />,
    href: "/conversations/new",
  },
];
// The pane URL owns the sort (`?sort=&direction=`); canonical has no keys.
const VIEW_CODEC = {
  basePath: "/conversations",
  decode: decodeUpdatedTitleIndexView,
  encode: (decoded: DecodedUpdatedTitleIndexView, current: URLSearchParams) =>
    encodeUpdatedTitleIndexView(
      decoded.kind === "Valid" ? decoded.view : CANONICAL,
      current,
    ),
  replaceOptions: { viewTransition: { kind: "collection-reflow" as const } },
};
const keyOf = (view: UpdatedTitleIndexView) =>
  conversationsInitialResource.cacheKey({ view });

/** The Chats index in one sortable view: filter, drain every page, count. */
export default function ConversationsPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "ConversationsPaneBody");
  const isPaneActive = usePaneIsActive();
  const environment = useRenderEnvironment();
  const { state: decoded, setState: setDecoded } = usePaneUrlState(VIEW_CODEC);
  const view = decoded.kind === "Valid" ? decoded.view : CANONICAL;
  const viewKey = keyOf(view);
  const invalid = decoded.kind === "Invalid";
  const sortRef = useRef<HTMLSelectElement | null>(null);
  const indexRevision = useConversationIndexRevision().revision;
  const committedRef = useRef<Committed | null>(null);
  const restored = usePaneVisitData(
    VISIT_DATA,
    useCallback(() => committedRef.current, []),
  );
  const [committed, setCommitted] = useState<Committed | null>(restored);
  const commit = useCallback((next: Committed) => {
    committedRef.current = next;
    setCommitted(next);
  }, []);
  const [version, setVersion] = useState(restored?.version ?? 0);
  const captureScroll = usePaneScrollRetention(committed);
  const clearVisitData = useClearAllPaneVisitData();
  const stale =
    committed?.version !== version || keyOf(committed.view) !== viewKey;

  const firstPage = useResource<ConversationsPaneSeed>({
    // the canonical first version reads the route's server seed
    cacheKey:
      stale && !invalid ? `${viewKey}${version ? `:${version}` : ""}` : null,
    load: async (signal) => {
      const page = await fetchConversationIndex({ view, signal });
      const { items: conversations, collectionRevision, nextCursor } = page;
      return { conversations, collectionRevision, nextCursor };
    },
  });
  // a refresh resolves once its first page commits, or fails
  const settle = useRef<{ resolve(): void; reject(error: unknown): void }>(
    null,
  );
  useEffect(() => {
    if (firstPage.status === "ready") {
      commit({ ...firstPage.data, view, version });
      settle.current?.resolve();
    }
    if (firstPage.status === "error") settle.current?.reject(firstPage.error);
    if (firstPage.status === "ready" || firstPage.status === "error")
      settle.current = null;
  }, [firstPage, view, version, commit]);
  usePaneReturnReady(
    committed !== null || firstPage.status === "error" || invalid,
  );
  const setView = useCallback(
    (next: UpdatedTitleIndexView) => {
      captureScroll();
      setDecoded({ kind: "Valid", view: next });
    },
    [captureScroll, setDecoded],
  );

  const refresh = useCallback(() => {
    captureScroll();
    clearVisitData();
    setVersion((value) => value + 1);
  }, [captureScroll, clearVisitData]);
  const seenRevision = useRef(indexRevision);
  useEffect(() => {
    if (indexRevision === seenRevision.current) return;
    seenRevision.current = indexRevision;
    refresh();
  }, [indexRevision, refresh]);

  const exhaustion = useExhaustivePagination<ConversationListItem>({
    active: isPaneActive && !stale,
    chainKey: `${committed?.version}:${committed && keyOf(committed.view)}`,
    cursor: committed?.nextCursor ?? NO_CURSOR,
    collectionRevision: committed?.collectionRevision ?? ZERO_REVISION,
    itemCount: committed?.conversations.length ?? 0,
    loadPage: (cursor, collectionRevision, signal) =>
      fetchConversationIndex({
        view: committed?.view ?? CANONICAL,
        cursor,
        collectionRevision,
        signal,
      }),
    commitPage: (page) => {
      const current = committedRef.current;
      if (current?.collectionRevision !== page.collectionRevision)
        throw new Error(
          "Conversation continuation settled for a stale collection",
        );
      const seen = new Set(current.conversations.map((item) => item.id));
      const added = page.items.filter((item) => !seen.has(item.id));
      const conversations = [...current.conversations, ...added];
      commit({ ...current, conversations, nextCursor: page.nextCursor });
      return conversations.length;
    },
    refresh,
  });

  const rows = useMemo(
    () =>
      (committed?.conversations ?? []).map((item) =>
        presentConversation(item, environment),
      ),
    [committed?.conversations, environment],
  );
  const failed = firstPage.status === "error" ? firstPage.error : null;
  const getRowStatus = useCallback(
    (query: string) => {
      const visibleCount = rows.filter((row) =>
        matchesPaneFilterQuery(query, [row.title.text]),
      ).length;
      const unit = { singular: "chat", plural: "chats" };
      const counts = { visibleCount, loadedCount: rows.length, unit };
      const lost =
        exhaustion.kind === "ResumeFailed" ||
        exhaustion.kind === "RefreshRequired";
      if (committed && stale)
        return {
          kind: "Retained" as const,
          ...counts,
          cause: failed ? ("Failed" as const) : ("Updating" as const),
        };
      if ((!committed && failed) || lost)
        return { kind: "Failed" as const, ...counts };
      return exhaustion.kind === "Complete"
        ? { kind: "Complete" as const, ...counts, totalCount: rows.length }
        : { kind: "Partial" as const, ...counts };
    },
    [committed, exhaustion.kind, failed, rows, stale],
  );
  const { query, onQueryChange, clearQuery, rowStatus } = usePaneFilterRows({
    sourceKey: "Conversations:mine",
    getRowStatus,
  });
  const { inputRef, focusInput } = usePaneCollectionInput();
  const reset = useCallback(() => {
    clearQuery();
    setView(CANONICAL);
    requestAnimationFrame(() =>
      sortRef.current?.focus({ preventScroll: true }),
    );
  }, [clearQuery, setView]);
  const collection = useMemo(
    () =>
      invalid
        ? undefined
        : {
            label: "Filter chats",
            focusInput,
            content: (
              <PaneCollectionBar
                inputRef={inputRef}
                inputLabel="Filter chats"
                placeholder="Filter chats"
                query={query}
                onQueryChange={onQueryChange}
                onClearQuery={clearQuery}
                rowStatus={rowStatus}
                filters={
                  <SelectField
                    layout="Inline"
                    label="Sort chats"
                    size="sm"
                    ref={sortRef}
                    value={updatedTitleSortOptionOf(view)}
                    onChange={(event) =>
                      setView(
                        updatedTitleViewForSortOption(
                          // justify-type-assertion: the options are exactly the ids
                          event.target.value as UpdatedTitleSortOptionId,
                        ),
                      )
                    }
                  >
                    {UPDATED_TITLE_SORT_OPTION_IDS.map((id) => (
                      <option key={id} value={id}>
                        {updatedTitleSortOptionLabel(id)}
                      </option>
                    ))}
                  </SelectField>
                }
                controls={
                  view.kind === "Canonical" ? undefined : (
                    <Button variant="ghost" size="sm" onClick={reset}>
                      Reset view
                    </Button>
                  )
                }
              />
            ),
          },
    [
      invalid,
      view,
      setView,
      reset,
      focusInput,
      inputRef,
      query,
      onQueryChange,
      clearQuery,
      rowStatus,
    ],
  );
  const execute = useCallback(
    async ({ signal }: { readonly signal: AbortSignal }) => {
      settle.current?.reject(
        new DOMException("Refresh superseded.", "AbortError"),
      );
      const done = new Promise<void>((resolve, reject) => {
        settle.current = { resolve, reject };
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
      refresh();
      try {
        await done;
        return {
          kind: "Complete" as const,
          announcement: "Conversations refreshed",
        };
      } catch (error) {
        if (isAbortError(error)) throw error;
        return {
          kind: "Failed" as const,
          announcement: "Conversations failed to refresh",
        };
      }
    },
    [refresh],
  );
  usePanePrimaryChrome({
    collection,
    refresh: { kind: "Refreshable", sourceKey: "Conversations:mine", execute },
    menuActions: NEW_CHAT,
    header: {
      kind: "Section",
      meta: invalid
        ? { kind: "None" }
        : !stale && exhaustion.kind === "Complete"
          ? { kind: "Count", value: exhaustion.itemCount, unit: "chat" }
          : { kind: "Pending" },
    },
  });

  const filtering = query.trim() !== "";
  const failure = failed ? (
    <FeedbackNotice
      content={{
        tone: "Danger",
        title: "Chats couldn’t be loaded.",
        requestId: failed.requestId,
      }}
      announcement="Assertive"
    />
  ) : undefined;
  if (invalid)
    return (
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid chats view" }}
        announcement="Assertive"
        actions={[{ label: "Reset view", onClick: reset }]}
      />
    );
  return (
    <div>
      <CollectionView
        returnScope="Conversations.Items"
        rows={rows.filter((row) =>
          matchesPaneFilterQuery(query, [row.title.text]),
        )}
        status={committed ? "ready" : failed ? "error" : "loading"}
        ariaLabel="Conversations"
        rowChangePresentation={{
          kind: "ImmediateOnKeyChange",
          key: query.trim(),
        }}
        collectionBusy={exhaustion.kind === "Draining"}
        notice={committed ? failure : undefined}
        error={committed ? undefined : failure}
        empty={
          <FeedbackNotice
            content={{
              tone: "Neutral",
              title: !filtering
                ? "No chats yet."
                : exhaustion.kind === "Complete"
                  ? "No chats match this filter."
                  : "No matching chat found so far.",
            }}
            announcement="None"
            actions={
              filtering
                ? undefined
                : [
                    {
                      label: "New chat",
                      onClick: () => runtime.router.push("/conversations/new"),
                    },
                  ]
            }
          />
        }
        footer={<CollectionExhaustionNotice state={exhaustion} />}
      />
    </div>
  );
}
