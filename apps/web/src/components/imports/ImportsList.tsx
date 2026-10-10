"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import Pill from "@/components/ui/Pill";
import ResourceList from "@/components/ui/ResourceList";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePaneCollectionInput } from "@/components/workspace/PaneCollectionBar";
import {
  fetchImportPage,
  usePagePrefix,
  type ImportItem,
  type ImportsView,
} from "@/lib/imports/api";
import {
  STALE_NOTICE,
  VIEW_LABEL,
  briefSegments,
  countText,
  emptyCopy,
  loadFailure,
  stageLabel,
  summaryLine,
} from "@/lib/imports/copy";
import { useImports } from "@/lib/imports/ImportsProvider";
import {
  IMPORTS_VIEWS,
  apiQuery,
  appliedFilters,
  isDefaultView,
  oneOf,
  selectView,
  withoutFilters,
  type ImportsUrlState,
} from "@/lib/imports/query";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import ImportRow from "./ImportRow";
import ImportsToolbar from "./ImportsToolbar";
import styles from "./Imports.module.css";

const ABSENT = { kind: "Absent" } as const;

/**
 * One Imports view: its rows, counts, notices and tabs. The list is the first
 * `pages` pages of the view's query; every observation rereads that prefix, so
 * a refresh keeps the pages the reader loaded, Load more is one page longer,
 * and a new query starts again at one page. A failed read keeps the rows.
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
  readonly onMatched: (matched: ImportItem["matched_event"]) => void;
  readonly onSelect: (ref: string | null) => void;
  readonly onSettled: (settled: boolean) => void;
}) {
  const { summary, observation, refresh } = useImports();
  const display = useRenderEnvironment();
  const query = apiQuery(view, state);
  const {
    prefix: rows,
    short,
    loadMore,
  } = usePagePrefix(query, observation, (cursor, signal) =>
    fetchImportPage(query, cursor, signal),
  );
  const data = rows.status === "ready" ? rows.data : null;
  const error = rows.status === "ready" ? rows.error : null;
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const moreFailed = error !== null && short;
  const counts = summary.status === "ready" ? summary.data : null;
  const summaryFailed =
    summary.status === "failed" ||
    (summary.status === "ready" && summary.error !== null);
  const stale =
    (error !== null && !short) || (summaryFailed && counts !== null);

  const settled = rows.status !== "loading";
  useEffect(() => onSettled(settled), [onSettled, settled]);

  // Why the selected import matched is a fact of the listed row; a query that
  // no longer lists it reports none.
  const selected = state.selected ?? null;
  const matched =
    items.find((item) => item.ref === selected)?.matched_event ?? ABSENT;
  useEffect(() => onMatched(matched), [matched, onMatched]);

  // Dismissing the inspector returns focus to the row it was opened from.
  const listRef = useRef<HTMLDivElement>(null);
  const lastSelected = useRef(selected);
  useEffect(() => {
    const previous = lastSelected.current;
    lastSelected.current = selected;
    if (previous === null || selected !== null) return;
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-import-ref="${CSS.escape(previous)}"] [data-row-focusable]`,
      )
      ?.focus();
  }, [selected]);

  const { inputRef, focusInput } = usePaneCollectionInput();
  const chips = useMemo(
    () => appliedFilters(view, state, display.displayLocale),
    [display.displayLocale, state, view],
  );
  const matchedCount = data?.pages[0].matched_count ?? 0;
  const loaded = items.length;
  const noun = state.q === undefined ? "imports" : "matching imports";
  const loadedCount =
    loaded === matchedCount
      ? `${loaded} ${noun}`
      : `${loaded} of ${matchedCount} ${noun}`;
  let resultStatus = loadedCount;
  if (rows.status === "loading") resultStatus = "Loading imports";
  else if (rows.status === "failed") resultStatus = "Results unavailable";
  else if (moreFailed) resultStatus = `${loadedCount}; loading failed`;
  else if (stale) {
    resultStatus = `Update failed; showing previous results · ${loadedCount}`;
  } else if (short) resultStatus = `${loadedCount}; loading more`;
  const announce = data !== null && error === null && !summaryFailed;
  const resetAvailable = !isDefaultView(state, view, today());
  const onReset = useCallback(
    () =>
      setState(
        selectView(withoutFilters({ ...state, q: undefined }), view, today()),
      ),
    [setState, state, today, view],
  );
  const toolbar = useMemo(
    () => (
      <ImportsToolbar
        view={view}
        state={state}
        inputRef={inputRef}
        chips={chips}
        resultStatus={resultStatus}
        announce={announce}
        resetAvailable={resetAvailable}
        onChange={setState}
        onReset={onReset}
        onRefresh={refresh}
      />
    ),
    [
      announce,
      chips,
      inputRef,
      onReset,
      refresh,
      resetAvailable,
      resultStatus,
      setState,
      state,
      view,
    ],
  );
  usePaneChrome(
    useMemo(
      () => ({
        collection: { label: "Filter imports", content: toolbar, focusInput },
      }),
      [focusInput, toolbar],
    ),
  );

  const filtered = chips.some((chip) => chip.id !== "q");
  const empty = emptyCopy(view, state.q !== undefined, filtered);
  const clearSearch = () => {
    setState({ ...state, q: undefined });
    inputRef.current?.focus({ preventScroll: true });
  };
  const segments = briefSegments(
    data === null ? null : matchedCount,
    observation || null,
    display,
    new Date(),
  );
  const rowsOf = (items: readonly ImportItem[]) =>
    items.map((item) => (
      <ImportRow
        key={item.ref}
        item={item}
        selected={item.ref === selected}
        onSelect={onSelect}
      />
    ));
  const sections =
    view === "NeedsAttention" && data !== null ? data.pages[0].groups : [];

  return (
    <Tabs
      className={styles.workspace}
      value={view}
      variant="segmented"
      onValueChange={(next) => {
        const target = oneOf(next, IMPORTS_VIEWS);
        if (target !== undefined && target !== view) {
          setState(selectView(state, target, today()));
        }
      }}
    >
      <TabsList aria-label="Imports views">
        {IMPORTS_VIEWS.map((candidate) => {
          const count =
            counts === null || candidate === "History"
              ? 0
              : candidate === "NeedsAttention"
                ? counts.needs_attention_count
                : counts.active_count;
          return (
            <TabsTrigger
              key={candidate}
              value={candidate}
              aria-label={
                count === 0 ? undefined : `${VIEW_LABEL[candidate]}, ${count}`
              }
            >
              {VIEW_LABEL[candidate]}
              {count === 0 ? null : (
                <Pill
                  tone={candidate === "NeedsAttention" ? "warning" : "neutral"}
                  size="sm"
                >
                  {countText(count)}
                </Pill>
              )}
            </TabsTrigger>
          );
        })}
      </TabsList>
      <TabsContent value={view}>
        <PaneSurface
          brief={
            <div className={styles.brief}>
              {/* One element, so a reader browsing linearly meets the sentence
                  once and a count changing under a settled list is spoken. */}
              <p role="status" aria-live="polite" aria-atomic="true">
                {counts === null || data === null ? "" : summaryLine(counts)}
              </p>
              <p className={styles.freshness}>
                {segments.map((segment, index) => (
                  <Fragment key={segment}>
                    {index === 0 ? null : (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span className="sr-only">, </span>
                      </>
                    )}
                    <span>{segment}</span>
                  </Fragment>
                ))}
              </p>
            </div>
          }
          state={
            <>
              {summary.status === "failed" ? (
                <FeedbackNotice
                  content={loadFailure(summary.error)}
                  announcement="Assertive"
                  actions={[{ label: "Try again", onClick: refresh }]}
                />
              ) : null}
              {rows.status === "failed" ? (
                <FeedbackNotice
                  content={loadFailure(rows.error)}
                  announcement="Assertive"
                  actions={[{ label: "Try again", onClick: rows.refetch }]}
                />
              ) : null}
              {moreFailed ? (
                <FeedbackNotice
                  content={{
                    ...loadFailure(error),
                    title: "More imports couldn’t be loaded",
                    message:
                      error.code === "E_INVALID_CURSOR"
                        ? "Refresh this view to start loading again."
                        : "Retry from the current imports.",
                  }}
                  announcement="Assertive"
                  actions={[
                    error.code === "E_INVALID_CURSOR"
                      ? { label: "Refresh", onClick: refresh }
                      : { label: "Retry", onClick: rows.refetch },
                  ]}
                />
              ) : null}
              {/* A read that failed over facts the reader still has is a
                  freshness fact; Try again is a wake that rereads both. */}
              {stale ? (
                <FeedbackNotice
                  content={STALE_NOTICE}
                  announcement="Polite"
                  actions={[{ label: "Try again", onClick: refresh }]}
                />
              ) : null}
              {rows.status === "loading" ? (
                <PaneLoadingState
                  label="Loading imports"
                  announcement="Polite"
                />
              ) : null}
            </>
          }
          empty={
            // Only a page that came back empty may say the view is empty.
            data === null ? undefined : (
              <div className={styles.empty}>
                <strong>{empty.title}</strong>
                <p>{empty.body}</p>
                {filtered ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setState(withoutFilters(state))}
                  >
                    Clear filters
                  </Button>
                ) : state.q !== undefined ? (
                  <Button variant="secondary" size="sm" onClick={clearSearch}>
                    Clear search
                  </Button>
                ) : null}
              </div>
            )
          }
          footer={
            <LoadMoreFooter
              hasMore={data !== null && data.more && !moreFailed}
              loading={short && error === null}
              onLoadMore={loadMore}
            />
          }
        >
          {items.length > 0 ? (
            <div ref={listRef} className={styles.list}>
              {sections.length > 0 ? (
                sections.map((section) => (
                  <PaneSection
                    key={section.stage}
                    title={`${stageLabel(section.stage)} (${section.count})`}
                  >
                    <ResourceList
                      ariaLabel={`${stageLabel(section.stage)} imports`}
                    >
                      {rowsOf(
                        items.filter(
                          (item) =>
                            item.state.kind === "NeedsAttention" &&
                            item.state.stage === section.stage,
                        ),
                      )}
                    </ResourceList>
                  </PaneSection>
                ))
              ) : (
                <ResourceList ariaLabel={`${VIEW_LABEL[view]} imports`}>
                  {rowsOf(items)}
                </ResourceList>
              )}
            </div>
          ) : null}
        </PaneSurface>
      </TabsContent>
    </Tabs>
  );
}
