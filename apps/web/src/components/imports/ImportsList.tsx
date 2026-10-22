"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import { FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneSurface from "@/components/ui/PaneSurface";
import ResourceList from "@/components/ui/ResourceList";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { listRowStatus, useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import {
  fetchImportPage,
  type ImportItem,
  type ImportPageMetadata,
  type ImportsView,
} from "@/lib/imports/api";
import {
  STALE_NOTICE,
  VIEW_LABEL,
  countText,
  emptyCopy,
  loadFailure,
} from "@/lib/imports/copy";
import { useImports } from "@/lib/imports/ImportsProvider";
import {
  IMPORTS_VIEWS,
  apiQuery,
  appliedFilters,
  isDefaultView,
  resetView,
  selectView,
  withoutFilters,
  type ImportsUrlState,
} from "@/lib/imports/query";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneIsActive } from "@/lib/panes/paneRuntime";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import ImportRow from "./ImportRow";
import ImportsToolbar from "./ImportsToolbar";
import styles from "./Imports.module.css";

/** Historical evidence belongs to one selection under one applied query. */
export interface MatchedImportEvidence {
  readonly importRef: string | null;
  readonly apiQuery: string;
  readonly event: ImportItem["matched_event"];
}

const VISIT = definePaneVisitDataKey<ListSnapshot<ImportItem, ImportPageMetadata>>("Imports.List");
const UNIT = { singular: "import", plural: "imports" };

const ROW = "[data-import-ref]";
const FOCUSABLE = "[data-row-focusable]:not([disabled])";

/** The refs of the rows after `row` in list order (all of them when it is gone). */
function refsAfter(root: Element, row: HTMLElement): string[] {
  const rows = [...root.querySelectorAll<HTMLElement>(ROW)];
  return rows
    .slice(rows.indexOf(row) + 1)
    .flatMap((item) => item.dataset.importRef ?? []);
}

/**
 * The view's progressively loaded server order; observations wait for traversal.
 * A list control that disappears under focus hands it to the same
 * row's title, else the next surviving row's, else the query input, while this
 * pane is active and focus was lost.
 */
export default function ImportsList({
  view,
  state,
  setState,
  today,
  onMatched,
  onSelect,
  onSettled,
}: {
  readonly view: ImportsView;
  readonly state: ImportsUrlState;
  readonly setState: (next: ImportsUrlState) => void;
  readonly today: () => string;
  readonly onMatched: (matched: MatchedImportEvidence) => void;
  readonly onSelect: (ref: string, triggerElement: HTMLButtonElement) => void;
  readonly onSettled: (settled: boolean) => void;
}) {
  const { summary, observation, revision, refresh } = useImports();
  const display = useRenderEnvironment();
  const active = usePaneIsActive();
  const query = apiQuery(view, state);
  const rows = useServerList<ImportItem, ImportPageMetadata>({
    key: `/imports?${query}`,
    stale: revision,
    pageSize: 50,
    active,
    visit: VISIT,
    id: (item) => item.ref,
    fetchPage: (cursor, limit, signal) => fetchImportPage(query, cursor, limit, signal),
  });
  const { revalidate } = rows;
  const observed = useRef(observation);
  useEffect(() => {
    const previous = observed.current;
    observed.current = observation;
    if (previous !== observation) revalidate();
  }, [observation, revalidate]);
  const items = rows.items;
  const error = rows.failure?.error ?? null;
  const counts = summary.status === "ready" ? summary.data : null;
  const summaryFailed =
    summary.status === "failed" ||
    (summary.status === "ready" && summary.error !== null);
  const stale =
    (rows.status === "ready" && rows.failure !== null && rows.failure.op !== "More") ||
    (summaryFailed && counts !== null);
  const settled = rows.status !== "loading";
  useEffect(() => onSettled(settled), [onSettled, settled]);

  const selected = state.selected ?? null;
  const matched =
    rows.current ? items.find((item) => item.ref === selected)?.matched_event ?? null : null;
  useEffect(
    () => onMatched({ importRef: selected, apiQuery: query, event: matched }),
    [matched, onMatched, query, selected],
  );

  const { inputRef, focusInput } = usePaneQueryInput();
  const listRef = useRef<HTMLDivElement>(null);
  const owned = useRef<{
    target: HTMLElement;
    ref: string;
    following: string[];
  } | null>(null);
  // Retire on a real focus move, even if it returns to body before a render.
  useLayoutEffect(() => {
    const retire = (event: FocusEvent) => {
      if (
        owned.current !== null &&
        event.target !== owned.current.target &&
        event.target !== document.body
      )
        owned.current = null;
    };
    document.addEventListener("focusin", retire, true);
    return () => document.removeEventListener("focusin", retire, true);
  }, []);
  // Repair an owned control lost to removal or to a native disabled-button
  // blur. A canonical command or another pane may already have placed focus.
  useLayoutEffect(() => {
    const focus = owned.current;
    const root = listRef.current;
    if (focus === null || root === null) return;
    const focused = document.activeElement;
    if (
      !active ||
      root.closest("[inert]") ||
      (focused !== document.body && focused !== focus.target)
    ) {
      owned.current = null;
      return;
    }
    const row = (ref: string) =>
      root.querySelector<HTMLElement>(
        `${ROW}[data-import-ref="${CSS.escape(ref)}"]`,
      );
    if (focus.target.isConnected) {
      focus.following = refsAfter(root, row(focus.ref) ?? focus.target);
      if (focused === document.body && !focus.target.matches(":disabled"))
        focus.target.focus({ preventScroll: true });
      return;
    }
    owned.current = null;
    const target =
      row(focus.ref)?.querySelector<HTMLElement>(FOCUSABLE) ??
      focus.following
        .map((ref) => row(ref)?.querySelector<HTMLElement>(FOCUSABLE))
        .find((candidate) => candidate) ??
      inputRef.current;
    target?.focus({ preventScroll: true });
  });

  const chips = useMemo(
    () => appliedFilters(view, state, display.displayLocale),
    [display.displayLocale, state, view],
  );
  const statusId = useId();
  const rowStatus = listRowStatus(rows, items.length, items.length, UNIT);
  const matchedCount = rows.current ? rows.metadata?.matched_count ?? null : null;
  const resetAvailable = !isDefaultView(state, view, today());
  const onReset = useCallback(
    () => setState(resetView(state, view, today())),
    [setState, state, today, view],
  );
  const toolbar = useMemo(
    () => (
      <ImportsToolbar
        view={view}
        state={state}
        inputRef={inputRef}
        chips={chips}
        resultStatus={<span className={styles.resultStatus}>
          <PaneFilterRowsStatus status={rowStatus} query={state.q ?? ""} id={statusId} />
          {matchedCount === null ? null : <span> · {matchedCount} {matchedCount === 1 ? "import" : "imports"} matched at last update</span>}
        </span>}
        statusId={statusId}
        resetAvailable={resetAvailable}
        onChange={setState}
        onReset={onReset}
        onRefresh={refresh}
      />
    ),
    [
      chips,
      inputRef,
      onReset,
      refresh,
      resetAvailable,
      rowStatus,
      matchedCount,
      statusId,
      setState,
      state,
      view,
    ],
  );
  const navigation = useMemo(
    () => (
      <nav className={styles.modes} aria-label="Imports views">
        {IMPORTS_VIEWS.map((candidate) => {
          const count =
            counts === null || candidate === "History"
              ? null
              : candidate === "NeedsAttention"
                ? counts.needs_attention_count
                : counts.active_count;
          return (
            <Button
              key={candidate}
              variant="ghost"
              size="sm"
              aria-current={candidate === view ? "page" : undefined}
              aria-label={
                count === null
                  ? undefined
                  : `${VIEW_LABEL[candidate]}, ${count}`
              }
              onClick={() => {
                if (candidate !== view)
                  setState(selectView(state, candidate, today()));
              }}
            >
              {VIEW_LABEL[candidate]}
              {count === null ? null : (
                <span className={styles.modeCount}>{countText(count)}</span>
              )}
            </Button>
          );
        })}
      </nav>
    ),
    [counts, setState, state, today, view],
  );
  usePaneChrome(
    useMemo(
      () => ({
        navigation: { label: "Imports views", content: navigation },
        query: {
          kind: "Controls",
          label: "Search imports",
          content: toolbar,
          focusInput,
        },
      }),
      [focusInput, navigation, toolbar],
    ),
  );

  const filtered = chips.some((chip) => chip.id !== "q");
  const empty = emptyCopy(view, state.q !== undefined, filtered);
  return (
    <div
      ref={listRef}
      className={styles.workspace}
      onFocusCapture={(event) => {
        const row = event.target.closest<HTMLElement>(ROW);
        if (row?.dataset.importRef === undefined) return;
        owned.current = {
          target: event.target,
          ref: row.dataset.importRef,
          following: refsAfter(event.currentTarget, row),
        };
      }}
      onBlurCapture={(event) => {
        const left =
          event.relatedTarget === null ||
          !event.currentTarget.contains(event.relatedTarget);
        // Chromium blurs a newly disabled command to body before its row
        // disappears. Keep that owner until settlement or removal; a real
        // move clears it.
        const disabledBlur =
          event.relatedTarget === null && event.target.matches(":disabled");
        if (event.target.isConnected && left && !disabledBlur)
          owned.current = null;
      }}
    >
      <PaneSurface
        state={
          <>
            {summary.status === "failed" ? (
              <FeedbackNotice
                content={loadFailure(summary.error)}
                announcement="Assertive"
                actions={[{ label: "try again", onClick: refresh, busy: summary.retrying }]}
              />
            ) : null}
            {rows.status === "failed" ? (
              <FeedbackState
                content={loadFailure(error)}
                announcement="Assertive"
                actions={[{ label: "try again", onClick: rows.retry, busy: rows.running !== null }]}
              />
            ) : null}
            {stale ? (
              <FeedbackNotice
                content={STALE_NOTICE}
                announcement="Polite"
                actions={[{ label: "try again", onClick: refresh,
                  busy: (rows.status === "ready" && rows.running !== null) ||
                    (summary.status === "ready" && summary.refreshing) }]}
              />
            ) : null}
            {rows.status === "loading" ? (
              <PaneLoadingState label="Loading imports" announcement="Polite" />
            ) : null}
          </>
        }
        empty={
          !rows.current || !rows.complete ? undefined : (
            <FeedbackState
              content={{ tone: "Neutral", title: empty.title, message: empty.body }}
              announcement="None"
              actions={filtered || state.q !== undefined ? [{
                  label: filtered
                    ? state.q === undefined ? "clear filters" : "clear search and filters"
                    : "clear search",
                  onClick: () => {
                    setState(withoutFilters({ ...state, q: undefined }));
                    focusInput();
                  },
              }] : undefined}
            />
          )
        }
        footer={<CollectionExhaustionNotice list={rows} unit={UNIT} returnFocus={() => inputRef.current} />}
      >
        {items.length > 0 ? (
          <ResourceList ariaLabel={`${VIEW_LABEL[view]} imports`}>
            {items.map((item) => (
              <ImportRow
                key={item.ref}
                item={item}
                selected={item.ref === selected}
                onSelect={onSelect}
              />
            ))}
          </ResourceList>
        ) : null}
      </PaneSurface>
    </div>
  );
}
