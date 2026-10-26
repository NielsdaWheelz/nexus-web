"use client";

import { Plus } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import CollectionView from "@/components/collections/CollectionView";
import {
  FeedbackNotice,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import Input from "@/components/ui/Input";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { catalogErrorFeedback } from "@/lib/catalog/copy";
import { useCatalogRead } from "@/lib/catalog/provider";
import { catalogNotes } from "@/lib/catalog/selectors";
import { usePaneUrlState } from "@/lib/panes/usePaneUrlState";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { indexRowStatus, indexReading } from "@/lib/panes/indexRows";
import { useNotesIndexRead } from "@/lib/panes/indexPaneEntry";
import { presentNote } from "@/lib/collections/presenters/note";
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
import { subscribeWriting } from "@/lib/notes/writes";
import { isDeletedResource } from "@/lib/resourceGraph/links";
import {
  dailyDateFor,
  isDeletingPage,
  type NotePageSummary,
} from "@/lib/notes/api";
import { usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import {
  matchesPaneFilterQuery,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import {
  requirePaneRuntime,
  usePaneIsActive,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import type { WorkspaceTargetActivationRequest } from "@/lib/workspace/targetActivation";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
} from "@/lib/workspace/paneReturnMemento";
import styles from "./notes.module.css";

const VISIT = definePaneVisitDataKey<Visit<{ items: NotePageSummary[] }>>(
  "Notes.Index",
);
const UNIT = { singular: "page", plural: "pages" };

// The pane URL owns the sort (`?sort=&direction=`); canonical has no keys.
const VIEW_CODEC = {
  basePath: "/notes",
  decode: decodeUpdatedTitleIndexView,
  encode: (decoded: DecodedUpdatedTitleIndexView, current: URLSearchParams) =>
    encodeUpdatedTitleIndexView(
      decoded.kind === "Valid" ? decoded.view : CANONICAL,
      current,
    ),
};

/**
 * The Notes index: the chats index's sortable view over the viewer's pages
 * (complete filtering and count), a box that creates a page, and Today.
 */
export default function NotesPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "NotesPaneBody");
  const { calendarTimeZone } = useAuthenticatedAccount();
  const { state: decoded, setState: setDecoded } = usePaneUrlState(VIEW_CODEC);
  const invalid = decoded.kind === "Invalid";
  const view = decoded.kind === "Valid" ? decoded.view : CANONICAL;
  const viewQuery = updatedTitleIndexViewQuery(view).slice(1);
  const catalog = useCatalogRead(value => catalogNotes(value, new URLSearchParams(viewQuery)));
  const descriptor = useNotesIndexRead();
  const list = useServerValue({ ...descriptor, catalog, visit: VISIT });
  const indexItems = list.status === "ready" ? list.data.items : [];
  const failure = list.status === "loading" ? null : list.error;
  const busy = indexReading(list);
  const retry = () => { void list.refetch().catch(() => {}); };
  usePaneReturnReady(list.status !== "loading" || invalid);
  const captureScroll = usePaneScrollRetention(indexItems);
  const setView = useCallback(
    (next: UpdatedTitleIndexView) => {
      captureScroll();
      setDecoded({ kind: "Valid", view: next });
    },
    [captureScroll, setDecoded],
  );

  const pendingDeletes = useSyncExternalStore(subscribeWriting,
    () => indexItems.filter(item => isDeletingPage(item.id)).map(item => item.id).join(" "), () => "");
  const items = useMemo(() => {
    const pending = new Set(pendingDeletes.split(" "));
    return (list.status === "ready" ? list.data.items : []).filter(item => !pending.has(item.id) && !isDeletedResource(`page:${item.id}`));
  }, [list, pendingDeletes]);
  const rows = useMemo(() => items.map(presentNote), [items]);
  const filterRows = usePaneFilterRows({
    sourceKey: "Notes.Pages",
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
    ? "no pages match this filter."
    : "no pages yet.";
  const readFeedback = useIndexReadFeedback({
    value: list, requestedKey: descriptor.key, active: usePaneIsActive(), unit: UNIT, waiting: list.status === "loading" && !invalid,
    outcome: visible.length > 0 ? "results updated." : emptyTitle,
    returnFocus: () => inputRef.current,
  });
  const canReset = view.kind !== "Canonical";
  const headerMeta: PaneHeaderMeta = invalid
    ? { kind: "None" }
    : (list.status === "ready")
      ? { kind: "Count", value: items.length, unit: "page" }
      : { kind: "Pending" };
  const reset = useCallback(() => {
    clearQuery();
    // Leaving an invalid view mounts the list: nothing to reflow, and a view
    // transition would mount it after the focus below.
    if (invalid) runtime.router.replace("/notes");
    else setView(CANONICAL);
    requestAnimationFrame(() =>
      inputRef.current?.focus({ preventScroll: true }),
    );
  }, [clearQuery, inputRef, invalid, runtime.router, setView]);
  const { refetch } = list;
  const execute = useCallback<PaneRefreshExecute>(async () => {
    try {
      await refetch();
      return { kind: "Complete", announcement: "Notes refreshed" };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { kind: "Failed", announcement: "Notes failed to refresh" };
    }
  }, [refetch]);
  usePaneChrome({
    query: invalid ? undefined : {
      kind: "Controls",
      label: "Filter pages",
      focusInput,
      content: (
        <PaneQueryToolbar
          inputRef={inputRef}
          input={{ label: "Filter pages", placeholder: "Filter pages", value: query, appliedValue: query, onChange: filterRows.onQueryChange, onClear: clearQuery }}
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
    refresh: { kind: "Refreshable", sourceKey: "Notes.Pages", execute },
    header: { kind: "Section", meta: headerMeta },
  });

  const title = useResourceDraft("Notes.NewPageTitle", () => "");
  const titleInput = useRef<HTMLInputElement>(null);
  const setTitle = title.set;
  useEffect(() => { if (titleInput.current) setTitle(titleInput.current.value); }, [setTitle]);
  const todayHref = `/daily/${dailyDateFor({ kind: "Today" }, calendarTimeZone)}`;
  const openToday = (event: TargetActivationEvent) =>
    activateTargetLink({
      event, runtime, target: { href: todayHref },
    });
  const submitIntent = (fork: boolean) => {
    const request: WorkspaceTargetActivationRequest = {
      originPaneId: runtime.paneId, target: { href: "/pages/new" },
      disposition: { kind: fork ? "Fork" : "Follow" },
      ...(title.read() ? { entry: { kind: "ComposePage", title: title.read() } } : {}),
    };
    const result = runtime.activateTarget(request);
    if (result.kind !== "Cancelled") title.set("");
    return result;
  };
  const submitGesture = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Consume") event.preventDefault();
    else if (activation.kind === "Open" && activation.intent === "new_pane") {
      event.preventDefault();
      submitIntent(true);
    }
  };

  if (invalid) {
    return (
      <div>
        {readFeedback.announcement}
        <FeedbackNotice
          content={{ tone: "Danger", title: "Invalid pages view" }}
          announcement="Assertive"
          actions={[{ label: "Reset view", onClick: reset }]}
        />
      </div>
    );
  }
  const failed = failure;
  const loadFailure = failed ? (
    <FeedbackNotice
      content={catalogErrorFeedback(failed) ?? {
        tone: "Danger",
        title: list.status === "ready" ? "couldn’t refresh pages" : "couldn’t load pages",
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
        returnScope="Notes.Pages"
        rows={visible}
        status={list.status === "failed" ? "error" : list.status}
        ariaLabel="Notes"
        anchorKey={query.trim()}
        collectionBusy={busy}
        notice={list.status === "ready" ? loadFailure : null}
        error={list.status === "ready" ? undefined : loadFailure}
        empty={
          <FeedbackNotice
            content={{
              tone: "Neutral",
              title: emptyTitle,
            }}
            announcement="None"
          />
        }
        toolbar={
          <>
            <form
              className={styles.toolbar}
              onSubmit={(event) => {
                event.preventDefault();
                submitIntent(false);
              }}
              onKeyDown={submitGesture}
            >
              <Input
                ref={titleInput}
                value={title.value}
                onChange={event => title.set(event.currentTarget.value)}
                onInput={event => title.set(event.currentTarget.value)}
                placeholder="New page"
                aria-label="New page title"
                style={{ flex: 1 }}
              />
              <Button emphasis="strong" iconOnly type="submit" aria-label="Create page" onClick={submitGesture} icon={<Plus size={16} aria-hidden="true" />} />
            </form>
            <ButtonLink href={todayHref} data-workspace-rich-target="true" onClick={openToday} onKeyDown={openToday}>Today</ButtonLink>
          </>
        }
      />
    </div>
  );
}
