"use client";

import { Plus } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import SelectField from "@/components/ui/SelectField";
import PaneCollectionBar, {
  usePaneCollectionInput,
} from "@/components/workspace/PaneCollectionBar";
import { useChangeStamp } from "@/lib/api/changes";
import { conversationsInitialResource } from "@/lib/api/resource";
import { useResourceSeed } from "@/lib/api/resourceCache";
import { usePaneUrlState } from "@/lib/api/usePaneUrlState";
import {
  listRowStatus,
  useServerList,
  type ListSnapshot,
} from "@/lib/api/useServerList";
import {
  fetchConversationIndex,
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
import { usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import {
  matchesPaneFilterQuery,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import type { ConversationsPaneSeed } from "@/lib/panes/paneResourceLoaders";
import {
  requirePaneRuntime,
  usePaneIsActive,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
} from "@/lib/workspace/paneReturnMemento";

const VISIT = definePaneVisitDataKey<ListSnapshot<ConversationListItem>>(
  "Conversations.Index",
);
const UNIT = { singular: "chat", plural: "chats" };
const NEW_CHAT: readonly ActionDescriptor[] = [
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

/** The Chats index in one sortable view: filter, load to the end, count. */
export default function ConversationsPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "ConversationsPaneBody");
  const environment = useRenderEnvironment();
  const { state: decoded, setState: setDecoded } = usePaneUrlState(VIEW_CODEC);
  const invalid = decoded.kind === "Invalid";
  const view = decoded.kind === "Valid" ? decoded.view : CANONICAL;
  const seed = useResourceSeed<ConversationsPaneSeed>(keyOf(CANONICAL));
  const list = useServerList<ConversationListItem>({
    key: invalid ? null : keyOf(view),
    stale: useChangeStamp("Chats"),
    pageSize: 100,
    drain: true,
    active: usePaneIsActive(),
    visit: VISIT,
    seed: seed && { key: keyOf(CANONICAL), page: seed },
    id: (item) => item.id,
    fetchPage: (cursor, limit, signal) =>
      fetchConversationIndex({
        view,
        cursor: cursor ?? undefined,
        limit,
        signal,
      }),
  });
  usePaneReturnReady(list.status !== "loading" || invalid);
  const captureScroll = usePaneScrollRetention(list.items);
  const sortRef = useRef<HTMLSelectElement | null>(null);
  const setView = useCallback(
    (next: UpdatedTitleIndexView) => {
      captureScroll();
      setDecoded({ kind: "Valid", view: next });
    },
    [captureScroll, setDecoded],
  );

  const rows = useMemo(
    () => list.items.map((item) => presentConversation(item, environment)),
    [list.items, environment],
  );
  const filterRows = usePaneFilterRows({
    sourceKey: "Conversations:mine",
    getRowStatus: (text) =>
      listRowStatus(
        list,
        rows.length,
        rows.filter((row) => matchesPaneFilterQuery(text, [row.title.text]))
          .length,
        UNIT,
      ),
  });
  const { query, clearQuery } = filterRows;
  const { inputRef, focusInput } = usePaneCollectionInput();
  const reset = useCallback(() => {
    clearQuery();
    setView(CANONICAL);
    requestAnimationFrame(() =>
      sortRef.current?.focus({ preventScroll: true }),
    );
  }, [clearQuery, setView]);
  const { refetch } = list;
  const execute = useCallback<PaneRefreshExecute>(async () => {
    try {
      await refetch();
      return { kind: "Complete", announcement: "Conversations refreshed" };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return {
        kind: "Failed",
        announcement: "Conversations failed to refresh",
      };
    }
  }, [refetch]);
  usePaneChrome({
    collection: invalid
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
              onQueryChange={filterRows.onQueryChange}
              onClearQuery={clearQuery}
              rowStatus={filterRows.rowStatus}
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
    refresh: { kind: "Refreshable", sourceKey: "Conversations:mine", execute },
    menuActions: NEW_CHAT,
    header: {
      kind: "Section",
      meta: invalid
        ? { kind: "None" }
        : list.complete
          ? { kind: "Count", value: list.items.length, unit: "chat" }
          : { kind: "Pending" },
    },
  });

  if (invalid) {
    return (
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid chats view" }}
        announcement="Assertive"
        actions={[{ label: "Reset view", onClick: reset }]}
      />
    );
  }
  const failed = list.failure?.op === "More" ? null : list.failure?.error;
  const failure = failed ? (
    <FeedbackNotice
      content={{
        tone: "Danger",
        title: "Chats couldn’t be loaded.",
        requestId: failed.requestId,
      }}
      announcement="Assertive"
      actions={[{ label: "Retry", onClick: list.retry }]}
    />
  ) : undefined;
  const filtering = query.trim() !== "";
  return (
    <div>
      <CollectionView
        returnScope="Conversations.Items"
        rows={rows.filter((row) =>
          matchesPaneFilterQuery(query, [row.title.text]),
        )}
        status={list.status === "failed" ? "error" : list.status}
        ariaLabel="Conversations"
        rowChangePresentation={{
          kind: "ImmediateOnKeyChange",
          key: query.trim(),
        }}
        collectionBusy={list.running !== null || !list.current}
        notice={list.status === "ready" ? failure : undefined}
        error={list.status === "ready" ? undefined : failure}
        empty={
          <FeedbackNotice
            content={{
              tone: "Neutral",
              title: !filtering
                ? "No chats yet."
                : list.complete
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
        footer={<CollectionExhaustionNotice list={list} />}
      />
    </div>
  );
}
