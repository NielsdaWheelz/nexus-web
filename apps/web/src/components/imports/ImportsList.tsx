"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import PaneSurface from "@/components/ui/PaneSurface";
import ResourceList from "@/components/ui/ResourceList";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { usePagePrefix } from "@/lib/api/pagePrefix";
import {
  fetchImportPage,
  type ImportItem,
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

/** A flat server-ordered prefix; refreshing retains the pages already requested. */
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
  const { summary, observation, refresh } = useImports();
  const display = useRenderEnvironment();
  const active = usePaneIsActive();
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

  const selected = state.selected ?? null;
  const matched =
    items.find((item) => item.ref === selected)?.matched_event ?? null;
  useEffect(
    () => onMatched({ importRef: selected, apiQuery: query, event: matched }),
    [matched, onMatched, query, selected],
  );

  const { inputRef, focusInput } = usePaneQueryInput();
  const listRef = useRef<HTMLDivElement>(null);
  const ownedFocus = useRef<{
    target: HTMLElement;
    importRef: string;
    followingRefs: string[];
  } | null>(null);
  // Retire on a real focus move, even if it returns to body before a render.
  useLayoutEffect(() => {
    const retire = (event: FocusEvent) => {
      const focus = ownedFocus.current;
      if (
        focus !== null &&
        event.target !== focus.target &&
        event.target !== document.body
      )
        ownedFocus.current = null;
    };
    document.addEventListener("focusin", retire, true);
    return () => document.removeEventListener("focusin", retire, true);
  }, []);
  // Repair an owned control lost to removal or native disabled-button blur.
  // A canonical command or another pane may already have placed focus.
  useLayoutEffect(() => {
    const focus = ownedFocus.current;
    const root = listRef.current;
    if (focus === null || root === null) return;
    const focused = document.activeElement;
    if (
      !active ||
      root.closest("[inert]") ||
      (focused !== document.body && focused !== focus.target)
    ) {
      ownedFocus.current = null;
      return;
    }
    const remaining = [
      ...root.querySelectorAll<HTMLElement>("[data-import-ref]"),
    ];
    if (focus.target.isConnected) {
      const at = remaining.findIndex(
        (row) => row.dataset.importRef === focus.importRef,
      );
      focus.followingRefs = remaining
        .slice(at + 1)
        .flatMap((row) => row.dataset.importRef ?? []);
      if (
        focused === document.body &&
        !focus.target.matches(":disabled")
      )
        focus.target.focus({ preventScroll: true });
      return;
    }
    ownedFocus.current = null;
    const same = remaining.find(
      (row) => row.dataset.importRef === focus.importRef,
    );
    const following = focus.followingRefs
      .map((ref) => remaining.find((row) => row.dataset.importRef === ref))
      .find((row) => row !== undefined);
    const target =
      same?.querySelector<HTMLElement>(
        "[data-row-focusable]:not([disabled])",
      ) ??
      following?.querySelector<HTMLElement>(
        "[data-row-focusable]:not([disabled])",
      ) ??
      inputRef.current;
    target?.focus({ preventScroll: true });
  });

  const chips = useMemo(
    () => appliedFilters(view, state, display.displayLocale),
    [display.displayLocale, state, view],
  );
  const matchedCount = data?.pages[0].matched_count ?? 0;
  const loaded = items.length;
  const noun = `${state.q === undefined ? "" : "matching "}${matchedCount === 1 ? "import" : "imports"}`;
  const loadedCount =
    loaded === matchedCount
      ? `${loaded} ${noun}`
      : `${loaded} of ${matchedCount} ${noun}`;
  let resultStatus = loadedCount;
  if (rows.status === "loading") resultStatus = "Loading imports";
  else if (rows.status === "failed") resultStatus = "Results unavailable";
  else if (moreFailed) resultStatus = `${loadedCount}; loading failed`;
  else if (stale)
    resultStatus = `Update failed; showing previous results · ${loadedCount}`;
  else if (short) resultStatus = `${loadedCount}; loading more`;
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
        const target = event.target;
        const row = target.closest<HTMLElement>("[data-import-ref]");
        if (row?.dataset.importRef === undefined) return;
        const remaining = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            "[data-import-ref]",
          ),
        ];
        ownedFocus.current = {
          target,
          importRef: row.dataset.importRef,
          followingRefs: remaining
            .slice(remaining.indexOf(row) + 1)
            .flatMap((item) => item.dataset.importRef ?? []),
        };
      }}
      onBlurCapture={(event) => {
        if (
          event.target.isConnected &&
          (event.relatedTarget === null ||
            !event.currentTarget.contains(event.relatedTarget)) &&
          // Chromium blurs a newly disabled command to body before its row
          // disappears. Keep that owner until settlement or removal;
          // a real move clears it.
          !(event.relatedTarget === null && event.target.matches(":disabled"))
        )
          ownedFocus.current = null;
      }}
    >
      <PaneSurface
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
            {stale ? (
              <FeedbackNotice
                content={STALE_NOTICE}
                announcement="Polite"
                actions={[{ label: "Try again", onClick: refresh }]}
              />
            ) : null}
            {rows.status === "loading" ? (
              <PaneLoadingState label="Loading imports" announcement="Polite" />
            ) : null}
          </>
        }
        empty={
          data === null ? undefined : (
            <div className={styles.empty}>
              <strong>{empty.title}</strong>
              <p>{empty.body}</p>
              {filtered || state.q !== undefined ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setState(withoutFilters({ ...state, q: undefined }));
                    focusInput();
                  }}
                >
                  {filtered
                    ? state.q === undefined
                      ? "Clear filters"
                      : "Clear search and filters"
                    : "Clear search"}
                </Button>
              ) : null}
            </div>
          )
        }
        footer={
          data !== null && data.more && !moreFailed ? (
            <LoadMoreFooter
              hasMore
              loading={short && error === null}
              onLoadMore={loadMore}
            />
          ) : null
        }
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
