"use client";

import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { Plus } from "lucide-react";
import { useCallback, useId, useMemo } from "react";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { catalogErrorFeedback } from "@/lib/catalog/copy";
import { useCatalogRead } from "@/lib/catalog/provider";
import { catalogChats } from "@/lib/catalog/selectors";
import { usePaneUrlState } from "@/lib/panes/usePaneUrlState";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { indexRowStatus, indexReading } from "@/lib/panes/indexRows";
import { useChatsIndexRead } from "@/lib/panes/indexPaneEntry";
import {
  type ConversationListItem,
} from "@/lib/chat/conversationIndex";
import { presentConversation } from "@/lib/collections/presenters/conversation";
import { useChatAgeClock } from "@/lib/chat/useChatAgeClock";
import {
  CANONICAL_UPDATED_TITLE_INDEX_VIEW as CANONICAL,
  decodeUpdatedTitleIndexView,
  encodeUpdatedTitleIndexView,
  UPDATED_TITLE_SORT_OPTION_IDS,
  updatedTitleIndexViewQuery,
  updatedTitleSortOptionLabel,
  updatedTitleSortOptionOf,
  updatedTitleViewForSortOption,
  type DecodedUpdatedTitleIndexView,
  type UpdatedTitleIndexView,
  type UpdatedTitleSortOptionId,
} from "@/lib/collections/updatedTitleIndexView";
import { isAbortError } from "@/lib/errors";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { usePaneChrome, type PanePrimaryAction, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import {
  matchesPaneFilterQuery,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import {
  requirePaneRuntime,
  usePaneIsActive,
  usePaneIsVisible,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
} from "@/lib/workspace/paneReturnMemento";

const VISIT = definePaneVisitDataKey<Visit<{ items: ConversationListItem[] }>>(
  "Conversations.Index",
);
const UNIT = { singular: "chat", plural: "chats" };
const NEW_CHAT: PanePrimaryAction = {
  kind: "link",
  id: "Conversations.New",
  label: "new chat",
  icon: <Plus size={20} aria-hidden="true" />,
  href: "/conversations/new",
};
// The pane URL owns the sort (`?sort=&direction=`); canonical has no keys.
const VIEW_CODEC = {
  basePath: "/conversations",
  decode: decodeUpdatedTitleIndexView,
  encode: (decoded: DecodedUpdatedTitleIndexView, current: URLSearchParams) =>
    encodeUpdatedTitleIndexView(
      decoded.kind === "Valid" ? decoded.view : CANONICAL,
      current,
    ),
};

/** The Chats index in one sortable view: complete filtering and count. */
export default function ConversationsPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "ConversationsPaneBody");
  const environment = useRenderEnvironment();
  const { state: decoded, setState: setDecoded } = usePaneUrlState(VIEW_CODEC);
  const invalid = decoded.kind === "Invalid";
  const view = decoded.kind === "Valid" ? decoded.view : CANONICAL;
  const viewQuery = updatedTitleIndexViewQuery(view).slice(1);
  const catalog = useCatalogRead(value => catalogChats(value, new URLSearchParams(viewQuery)));
  const descriptor = useChatsIndexRead();
  const list = useServerValue({ ...descriptor, catalog, visit: VISIT });
  const indexItems = list.status === "ready" ? list.data.items : [];
  const failure = list.status === "loading" ? null : list.error;
  const busy = indexReading(list);
  const retry = () => { void list.refetch().catch(() => {}); };
  const nowMs = useChatAgeClock({ initialInstant: environment.currentInstant, items: indexItems, visible: usePaneIsVisible() });
  usePaneReturnReady(list.status !== "loading" || invalid);
  const captureScroll = usePaneScrollRetention(indexItems);
  const setView = useCallback(
    (next: UpdatedTitleIndexView) => {
      captureScroll();
      setDecoded({ kind: "Valid", view: next });
    },
    [captureScroll, setDecoded],
  );

  const rows = useMemo(
    () => (list.status === "ready" ? list.data.items : []).map((item) => presentConversation(item, environment, nowMs)),
    [list, environment, nowMs],
  );
  const filterRows = usePaneFilterRows({
    sourceKey: "Conversations:mine",
    getRowStatus: (text) =>
      indexRowStatus(
        list,
        rows.length,
        rows.filter((row) => matchesPaneFilterQuery(text, [row.title.text]))
          .length,
        UNIT,
      ),
  });
  const { query, clearQuery } = filterRows;
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const filtering = query.trim() !== "";
  const visible = rows.filter((row) => matchesPaneFilterQuery(query, [row.title.text]));
  const emptyTitle = filtering
    ? "no chats match this filter."
    : "no chats yet.";
  const readFeedback = useIndexReadFeedback({
    value: list, requestedKey: descriptor.key, active: usePaneIsActive(), unit: UNIT, waiting: list.status === "loading" && !invalid,
    outcome: visible.length > 0 ? "results updated." : emptyTitle,
    returnFocus: () => inputRef.current,
  });
  const canReset = view.kind !== "Canonical";
  const headerMeta: PaneHeaderMeta = invalid
    ? { kind: "None" }
    : (list.status === "ready")
      ? { kind: "Count", value: indexItems.length, unit: "chat" }
      : { kind: "Pending" };
  const reset = useCallback(() => {
    clearQuery();
    setView(CANONICAL);
    requestAnimationFrame(() =>
      inputRef.current?.focus({ preventScroll: true }),
    );
  }, [clearQuery, inputRef, setView]);
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
    query: invalid ? undefined : {
      kind: "Controls",
      label: "Filter chats",
      focusInput,
      content: (
        <PaneQueryToolbar
          inputRef={inputRef}
          input={{ label: "Filter chats", placeholder: "Filter chats", value: query, appliedValue: query, onChange: filterRows.onQueryChange, onClear: clearQuery }}
          sort={{
            label: "Sort",
            value: updatedTitleSortOptionOf(view),
            choices: UPDATED_TITLE_SORT_OPTION_IDS.map((value) => ({ value, label: updatedTitleSortOptionLabel(value) })),
            onChange: (value) => setView(updatedTitleViewForSortOption(
              // justify-type-assertion: the select offers exactly these ids.
              value as UpdatedTitleSortOptionId,
            )),
          }}
          status={{
            placement: "Inline",
            id: queryStatusId,
            visible: false,
            content: <PaneFilterRowsStatus announceQueryChanges={(list.status === "ready") && failure === null} id={queryStatusId} status={filterRows.rowStatus} query={query} />,
          }}
          onReset={canReset ? reset : undefined}
        />
      ),
    },
    refresh: { kind: "Refreshable", sourceKey: "Conversations:mine", execute },
    primaryAction: NEW_CHAT,
    menuActions: [NEW_CHAT],
    header: { kind: "Section", meta: headerMeta },
  });

  if (invalid) {
    return (
      <div>
        {readFeedback.announcement}
        <FeedbackNotice
          content={{ tone: "Danger", title: "Invalid chats view" }}
          announcement="Assertive"
          actions={[{ label: "Reset view", onClick: reset }]}
        />
      </div>
    );
  }
  const failed = failure;
  const failureNotice = failed ? (
    <FeedbackNotice
      content={catalogErrorFeedback(failed) ?? {
        tone: "Danger",
        title: list.status === "ready" ? "couldn’t refresh chats" : "couldn’t load chats",
        requestId: failed.requestId,
      }}
      announcement={list.status === "ready" ? "None" : "Polite"}
      actions={[{ label: "try again", onClick: retry, busy }]}
      returnFocus={() => inputRef.current}
    />
  ) : undefined;
  return (
    <div>
      {readFeedback.announcement}
      <CollectionView geometry="UniformIndex"
        returnScope="Conversations.Items"
        rows={visible}
        status={list.status === "failed" ? "error" : list.status}
        ariaLabel="Conversations"
        anchorKey={query.trim()}
        collectionBusy={busy}
        notice={list.status === "ready" ? failureNotice : null}
        error={list.status === "ready" ? undefined : failureNotice}
        empty={
          <FeedbackNotice
            content={{
              tone: "Neutral",
              title: emptyTitle,
            }}
            announcement="None"
            actions={
              filtering
                ? undefined
                : [
                    {
                      label: "New chat",
                      href: "/conversations/new",
                      onActivate: event => activateTargetLink({ event, runtime, target: { href: "/conversations/new" } }),
                    },
                  ]
            }
          />
        }
      />
    </div>
  );
}
