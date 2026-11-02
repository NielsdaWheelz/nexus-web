"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import Button from "@/components/ui/Button";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneSurface from "@/components/ui/PaneSurface";
import ResourceList from "@/components/ui/ResourceList";
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
  VIEW_LABEL,
  countText,
  emptyLine,
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
  const counts = summary.status === "ready" ? summary.data : null;
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
        resultStatus={<PaneFilterRowsStatus status={rowStatus} query={state.q ?? ""} id={statusId} announceQueryChanges={false}>
          {matchedCount === null ? null : ` ${matchedCount} ${matchedCount === 1 ? "import" : "imports"} matched at last update.`}
        </PaneFilterRowsStatus>}
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
          content: toolbar,
          focusInput,
        },
      }),
      [focusInput, navigation, toolbar],
    ),
  );

  const filtered = chips.some((chip) => chip.id !== "q");
  const searched = state.q !== undefined;
  const readFeedback = useCollectionReadFeedback({
    list: rows, unit: UNIT, waiting: rows.status === "loading",
    outcome: null,
    returnFocus: () => inputRef.current,
  });
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
      {readFeedback.announcement}
      <PaneSurface
        state={rows.status === "loading" ? <Ruling />
          : rows.status === "failed" && rows.failure !== null ? <Failed error={rows.failure.error} noun="imports" retry={{ run: rows.retry, busy: rows.running !== null }} />
          : null}
        empty={!rows.current ? undefined : !rows.complete ? rows.failure === null ? <Ruling /> : undefined : (
          <Fact
            line={{ fact: emptyLine(view, searched, filtered) }}
            verbs={filtered || searched ? [{
              label: filtered ? searched ? "clear search and filters" : "clear filters" : "clear search",
              commandKey: "clear search and filters",
              run: () => {
                setState(withoutFilters({ ...state, q: undefined }));
                focusInput();
              },
            }] : undefined}
            speak={active}
          />
        )}
        footer={readFeedback.notice}
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
