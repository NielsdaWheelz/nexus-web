"use client";

import { Plus } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import {
  FeedbackNotice,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneUrlState } from "@/lib/panes/usePaneUrlState";
import {
  listRowStatus,
  pageQuery,
  useServerList,
  type ListSnapshot,
} from "@/lib/api/useServerList";
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
import {
  dailyDateFor,
  fetchNotePages,
  type NotePageSummary,
} from "@/lib/notes/api";
import { usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import {
  matchesPaneFilterQuery,
  paneFilterRowsStatusVisible,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import {
  requirePaneRuntime,
  usePaneIsActive,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { resourceDraftOwnerId, useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { useLatestWorkspace } from "@/lib/workspace/store";
import { planWorkspaceTarget, type WorkspaceTargetActivationRequest } from "@/lib/workspace/targetActivation";
import { workspaceTargetActivationIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
} from "@/lib/workspace/paneReturnMemento";
import styles from "./notes.module.css";

const VISIT = definePaneVisitDataKey<ListSnapshot<NotePageSummary>>(
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
 * (filter, load to the end, count), a box that creates a page, and Today.
 */
export default function NotesPaneBody() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "NotesPaneBody");
  const { calendarTimeZone } = useAuthenticatedAccount();
  const { state: decoded, setState: setDecoded } = usePaneUrlState(VIEW_CODEC);
  const invalid = decoded.kind === "Invalid";
  const view = decoded.kind === "Valid" ? decoded.view : CANONICAL;
  const viewQuery = updatedTitleIndexViewQuery(view).slice(1);
  const list = useServerList<NotePageSummary>({
    key: invalid ? null : `/notes/pages?${viewQuery}`,
    stale: useChangeStamp("Notes"),
    pageSize: 100,
    drain: true,
    active: usePaneIsActive(),
    visit: VISIT,
    id: (item) => item.id,
    fetchPage: (cursor, limit, signal) =>
      fetchNotePages(pageQuery(viewQuery, cursor, limit), signal),
  });
  usePaneReturnReady(list.status !== "loading" || invalid);
  const captureScroll = usePaneScrollRetention(list.items);
  const setView = useCallback(
    (next: UpdatedTitleIndexView) => {
      captureScroll();
      setDecoded({ kind: "Valid", view: next });
    },
    [captureScroll, setDecoded],
  );

  const rows = useMemo(() => list.items.map(presentNote), [list.items]);
  const filterRows = usePaneFilterRows({
    sourceKey: "Notes.Pages",
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
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const canReset = view.kind !== "Canonical";
  const headerMeta: PaneHeaderMeta = invalid
    ? { kind: "None" }
    : list.complete
      ? { kind: "Count", value: list.items.length, unit: "page" }
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
            visible: paneFilterRowsStatusVisible({
              status: filterRows.rowStatus,
              filtering: query.trim() !== "",
            }),
            content: <PaneFilterRowsStatus id={queryStatusId} status={filterRows.rowStatus} query={query} />,
          }}
          onReset={canReset ? reset : undefined}
        />
      ),
    },
    refresh: { kind: "Refreshable", sourceKey: "Notes.Pages", execute },
    header: { kind: "Section", meta: headerMeta },
  });

  const title = useResourceDraft("Notes.NewPageTitle", () => "", value => ({ changed: value !== "", unconfirmed: false, stopsBrowserWork: false }));
  const titleInput = useRef<HTMLInputElement>(null);
  const setTitle = title.set;
  useEffect(() => { if (titleInput.current) setTitle(titleInput.current.value); }, [setTitle]);
  const workspace = useLatestWorkspace();
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
    const current = workspace();
    const plan = planWorkspaceTarget(current.state, current.dailyPageByPaneId, request);
    const destination = current.state.panes.find(pane => pane.id === plan.paneId);
    const discardOwnerIds = title.read() && destination && (plan.kind === "Unchanged" || plan.kind === "ActivatedExisting")
      ? [resourceDraftOwnerId(JSON.stringify([destination.current_visit.id, resolvePaneRouteModel(destination.current_visit.href).routeKey]), "Notes.NewPage")]
      : [];
    const result = runtime.activateTarget({ ...request, discardOwnerIds });
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
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid pages view" }}
        announcement="Assertive"
        actions={[{ label: "Reset view", onClick: reset }]}
      />
    );
  }
  const failed = list.failure?.op === "More" ? null : list.failure?.error;
  const loadFailure = failed ? (
    <FeedbackNotice
      content={{
        tone: "Danger",
        title: "Notes couldn’t be loaded.",
        requestId: failed.requestId,
      }}
      announcement="Assertive"
      actions={[{ label: "Retry", onClick: list.retry, busy: list.running !== null }]}
    />
  ) : undefined;
  const filtering = query.trim() !== "";
  return (
    <div>
      <CollectionView
        returnScope="Notes.Pages"
        rows={rows.filter((row) =>
          matchesPaneFilterQuery(query, [row.title.text]),
        )}
        status={list.status === "failed" ? "error" : list.status}
        ariaLabel="Notes"
        rowChangePresentation={{
          kind: "ImmediateOnKeyChange",
          key: query.trim(),
        }}
        collectionBusy={list.running !== null || !list.current}
        notice={list.status === "ready" ? loadFailure : undefined}
        error={list.status === "ready" ? undefined : loadFailure}
        empty={
          <FeedbackNotice
            content={{
              tone: "Neutral",
              title: !filtering
                ? "No pages yet."
                : list.complete
                  ? "No pages match this filter."
                  : "No matching page found so far.",
            }}
            announcement="None"
          />
        }
        footer={<CollectionExhaustionNotice list={list} />}
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
              <Button iconOnly type="submit" aria-label="Create page" onClick={submitGesture}>
                <Plus size={16} aria-hidden="true" />
              </Button>
            </form>
            <Button variant="secondary" size="sm" asChild>
              <a href={todayHref} data-workspace-rich-target="true" onClick={openToday} onKeyDown={openToday}>Today</a>
            </Button>
          </>
        }
      />
    </div>
  );
}
