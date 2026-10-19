"use client";

import { Plus } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useChangeStamp } from "@/lib/api/changes";
import { apiTransportFeedback } from "@/lib/api/client";
import { modeledApiError, useThrowLater } from "@/lib/api/serverState";
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
  createPage,
  dailyDateFor,
  fetchNotePages,
  type NotePageSummary,
} from "@/lib/notes/api";
import { usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import { openAsyncResult } from "@/lib/panes/openResult";
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
import { useHydrationPreservedInput } from "@/lib/ui/useHydrationPreservedInput";
import { workspaceTargetActivationIntent, type OpenIntent, type TargetActivationEvent } from "@/lib/ui/targetActivation";
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
  replaceOptions: { viewTransition: { kind: "collection-reflow" as const } },
};

/** A create the user can retry: the same id, so a landed retry finds its page. */
interface Create {
  readonly id: string;
  readonly title: string;
  readonly titled: boolean;
  readonly openIntent: OpenIntent;
}

/**
 * The Notes index: the chats index's sortable view over the viewer's pages
 * (filter, load to the end, count), a box that creates a page, and Today.
 */
export default function NotesPaneBody() {
  const { ctx } = useActionRuntime();
  const mounted = useRef(false);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const runtime = requirePaneRuntime(usePaneRuntime(), "NotesPaneBody");
  const { calendarTimeZone } = useAuthenticatedAccount();
  const fail = useThrowLater();
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

  const title = useHydrationPreservedInput();
  const [retry, setRetry] = useState<Create | null>(null);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submit = (create: Create) => {
    if (submitting) return;
    const submittedTitle = title.inputProps.ref.current?.value;
    setSubmitting(true);
    if (retry?.id !== create.id) setFailure(null);
    void openAsyncResult({
      ctx, originPaneId: runtime.paneId, intent: create.openIntent, disposition: "Follow",
      create: async () => {
        const page = await createPage(create.id, create.title);
        if (mounted.current) {
          setFailure(null);
          setRetry(null);
          if (submittedTitle !== undefined && (submittedTitle.trim() || "Untitled") === create.title &&
            title.inputProps.ref.current?.value === submittedTitle) title.setValue("");
        }
        return {
          target: { href: `/pages/${page.id}`, labelHint: page.title },
          title: "page created", openLabel: "open page",
          entry: create.titled
            ? { kind: "AppendNote" }
            : { kind: "EditPageTitle", pageId: page.id },
        };
      },
    }).catch((error: unknown) => {
        if (!mounted.current || ctx.sessionSignal().aborted) return;
        const modeled = modeledApiError(error, fail);
        if (!modeled) return;
        const heading = "Page couldn’t be created";
        setRetry(create);
        setFailure(
          apiTransportFeedback(modeled, heading) ?? {
            tone: "Danger",
            title: heading,
            message: "Change the title, then create it again.",
            requestId: modeled.requestId,
          },
        );
      }).finally(() => { if (mounted.current) setSubmitting(false); });
  };
  const todayHref = `/daily/${dailyDateFor({ kind: "Today" }, calendarTimeZone)}`;
  const openToday = (event: TargetActivationEvent) =>
    activateTargetLink({
      event, runtime, target: { href: todayHref },
      onDefault: () => runtime.activateTarget({ target: { href: todayHref }, disposition: { kind: "Adopt" } }),
    });
  const submitIntent = (openIntent: OpenIntent) => {
    const typed = title.value.trim();
    const next = typed || "Untitled";
    submit(retry?.title === next
      ? { ...retry, openIntent: openIntent === "new_pane" ? openIntent : retry.openIntent }
      : { id: crypto.randomUUID(), title: next, titled: !!typed, openIntent });
  };
  const submitGesture = (event: TargetActivationEvent) => {
    const activation = workspaceTargetActivationIntent(event);
    if (activation.kind === "Consume") event.preventDefault();
    else if (activation.kind === "Open" && activation.intent === "new_pane") {
      event.preventDefault();
      submitIntent(activation.intent);
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
        notice={
          failure ? (
            <FeedbackNotice
              content={failure}
              announcement="Assertive"
              actions={
                retry
                  ? [{ label: "Retry", onClick: intent => submit({ ...retry, openIntent: intent === "new_pane" ? intent : retry.openIntent }), busy: submitting }]
                  : undefined
              }
            />
          ) : list.status === "ready" ? (
            loadFailure
          ) : undefined
        }
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
                submitIntent("default");
              }}
              onKeyDown={submitGesture}
            >
              <Input
                {...title.inputProps}
                placeholder="New page"
                aria-label="New page title"
                style={{ flex: 1 }}
              />
              <Button iconOnly type="submit" aria-label="Create page" disabled={submitting} onClick={submitGesture}>
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
