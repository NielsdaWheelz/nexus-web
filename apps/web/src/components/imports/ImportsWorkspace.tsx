"use client";

import { useEffect, useRef, useState } from "react";
import AppliedFilters from "@/components/search/AppliedFilters";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import PaneToolbar from "@/components/ui/PaneToolbar";
import Pill from "@/components/ui/Pill";
import ResourceList from "@/components/ui/ResourceList";
import SelectField from "@/components/ui/SelectField";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import Toggle from "@/components/ui/Toggle";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { absent, present, type Presence } from "@/lib/api/presence";
import {
  IMPORT_STAGES,
  IMPORT_STATE_KINDS,
  SAFE_FAILURE_CODES,
  type ImportRef,
  type ImportStage,
  type ImportStateKind,
  type SafeFailureCode,
} from "@/lib/imports/importRef";
import { useImports } from "@/lib/imports/ImportsProvider";
import {
  IMPORTS_VIEWS,
  type ImportsUrlState,
  type ImportsView,
} from "@/lib/imports/importsUrlState";
import type { ImportItem } from "@/lib/imports/importsClient";
import { useImportsPage } from "@/lib/imports/useImportsPage";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import { MEDIA_KINDS, type MediaKind } from "@/lib/media/kind";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import {
  IMPORTS_STALE_REFRESH_NOTICE,
  IMPORT_FAILURE_COPY,
  IMPORT_STATE_KIND_LABEL,
  importKindLabel,
  importStageLabel,
  importsEmptyCopy,
  importsFreshnessLine,
  importsLoadErrorMessage,
  importsMatchedLine,
  importsSummaryLine,
} from "@/lib/status/imports";
import ImportRow from "./ImportRow";
import {
  IMPORTS_VIEW_LABEL,
  appliedImportsFilters,
  importStageSections,
  importsViewSelection,
  unqualifiedImportsView,
  withoutImportsFilter,
  withoutImportsFilters,
  type ImportsFilterField,
} from "./importsWorkspaceModel";
import styles from "./ImportsWorkspace.module.css";

export interface ImportsWorkspaceProps {
  readonly state: ImportsUrlState;
  readonly onStateChange: (next: ImportsUrlState) => void;
  readonly selectedRef: ImportRef | null;
  readonly onSelect: (ref: ImportRef | null) => void;
  /**
   * Reports whether the listed page has settled (ready or failed). The pane
   * owns the return memento and cannot see this read, so the list reports it.
   */
  readonly onListSettled: (settled: boolean) => void;
}

const REASON_OPTIONS = [...SAFE_FAILURE_CODES].sort((left, right) =>
  IMPORT_FAILURE_COPY[left].reason.localeCompare(
    IMPORT_FAILURE_COPY[right].reason,
  ),
);

function chosen<T extends string>(
  raw: string,
  values: readonly T[],
): Presence<T> {
  const value = values.find((candidate) => candidate === raw);
  return value === undefined ? absent() : present(value);
}

function text(value: Presence<string>): string {
  return value.kind === "Present" ? value.value : "";
}

/**
 * The Imports workspace: one view at a time, the filters that view can apply,
 * and its rows. The pane owns URL state and the inspector surface; this owns
 * which view an unqualified entry lands on and the window History opens with
 * (contract D17), and reports every change through `onStateChange`.
 */
export default function ImportsWorkspace({
  state,
  onStateChange,
  selectedRef,
  onSelect,
  onListSettled,
}: ImportsWorkspaceProps) {
  const { summary, loadState, refresh } = useImports();
  const { displayTimeZone } = useRenderEnvironment();
  const explicitView = state.view.kind === "Present" ? state.view.value : null;
  // The counts choose a view once. A later observation must never move the
  // reader off the view they are looking at, however the counts change, and the
  // URL this resolution is written to may not have landed yet.
  const chosenRef = useRef<ImportsView | null>(null);
  const resolvedView =
    explicitView ?? chosenRef.current ?? unqualifiedImportsView(summary);
  if (explicitView === null && resolvedView !== null) {
    chosenRef.current = resolvedView;
  }

  const materializedRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    if (explicitView !== null || resolvedView === null) return;
    if (materializedRef.current) return;
    materializedRef.current = true;
    onStateChangeRef.current(
      importsViewSelection(
        stateRef.current,
        resolvedView,
        formatLocalDateInTimeZone(new Date(), displayTimeZone),
      ),
    );
  }, [displayTimeZone, explicitView, resolvedView]);

  if (resolvedView === null) {
    // The counts choose the view, so a first read that never arrived leaves no
    // view for the failure below to be reported inside: this entry carries its
    // own recovery.
    return loadState.kind === "Failed" ? (
      <FeedbackNotice
        content={importsLoadErrorMessage(loadState.error)}
        announcement="Assertive"
        actions={[{ label: "Try again", onClick: () => void refresh() }]}
      />
    ) : (
      <PaneLoadingState label="Loading imports" announcement="Polite" />
    );
  }
  return (
    <ImportsWorkspaceView
      view={resolvedView}
      state={state}
      onStateChange={onStateChange}
      selectedRef={selectedRef}
      onSelect={onSelect}
      onListSettled={onListSettled}
    />
  );
}

function ImportsWorkspaceView({
  view,
  state,
  onStateChange,
  selectedRef,
  onSelect,
  onListSettled,
}: ImportsWorkspaceProps & { readonly view: ImportsView }) {
  const { summary, loadState, observation, refresh } = useImports();
  const display = useRenderEnvironment();
  const page = useImportsPage(view, state);
  const chips = appliedImportsFilters(view, state);
  const listRef = useRef<HTMLDivElement>(null);

  const listSettled = page.status !== "loading";
  useEffect(() => {
    onListSettled(listSettled);
  }, [listSettled, onListSettled]);

  const [draft, setDraft] = useState(() => text(state.q));
  const committedRef = useRef(text(state.q));
  if (committedRef.current !== text(state.q)) {
    committedRef.current = text(state.q);
    setDraft(committedRef.current);
  }

  // A live region carries new information, never a summary of what was already
  // on screen when the pane opened.
  const announcedRef = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (summary === null) return;
    const line = importsSummaryLine(summary);
    const previous = announcedRef.current;
    announcedRef.current = line;
    if (previous === null || previous === line) return;
    setAnnouncement(`${line}.`);
  }, [summary]);

  // Dismissing the inspector returns the reader to the row it was opened from,
  // rather than dropping focus to the document.
  const lastSelectedRef = useRef<ImportRef | null>(selectedRef);
  useEffect(() => {
    const previous = lastSelectedRef.current;
    lastSelectedRef.current = selectedRef;
    if (previous === null || selectedRef !== null) return;
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-import-ref="${previous}"] [data-row-focusable]`,
      )
      ?.focus();
  }, [selectedRef]);

  const update = (next: Partial<ImportsUrlState>) =>
    onStateChange({ ...state, ...next });
  const viewCount = (candidate: ImportsView): number | null => {
    if (summary === null || candidate === "History") return null;
    return candidate === "NeedsAttention"
      ? summary.needsAttentionCount
      : summary.activeCount;
  };
  const observedAt = observation.observedAt;
  const freshness =
    observedAt === null
      ? null
      : importsFreshnessLine(observedAt, display, new Date());
  const empty = importsEmptyCopy(view, chips.length > 0);
  const sections = importStageSections(page.groups, page.items);
  const grouped = view === "NeedsAttention" && sections.length > 0;

  const rows = (items: readonly ImportItem[]) =>
    items.map((item) => (
      <ImportRow
        key={item.ref}
        item={item}
        selected={item.ref === selectedRef}
        onSelect={onSelect}
      />
    ));

  return (
    <Tabs
      className={styles.workspace}
      value={view}
      variant="segmented"
      onValueChange={(next) => {
        const target = IMPORTS_VIEWS.find((candidate) => candidate === next);
        if (target === undefined || target === view) return;
        onStateChange(
          importsViewSelection(
            state,
            target,
            formatLocalDateInTimeZone(new Date(), display.displayTimeZone),
          ),
        );
      }}
    >
      <TabsList aria-label="Imports views">
        {IMPORTS_VIEWS.map((candidate) => {
          const count = viewCount(candidate);
          return (
            <TabsTrigger key={candidate} value={candidate}>
              {IMPORTS_VIEW_LABEL[candidate]}
              {count === null || count === 0 ? null : (
                <Pill
                  tone={candidate === "NeedsAttention" ? "warning" : "neutral"}
                  size="sm"
                >
                  {count}
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
              <p>{summary === null ? "" : importsSummaryLine(summary)}</p>
              <p className={styles.freshness}>
                {page.status === "ready"
                  ? importsMatchedLine(page.matchedCount)
                  : ""}
                {freshness === null ? null : (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span className="sr-only">, </span>
                    <span>{freshness}</span>
                  </>
                )}
              </p>
              <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                {announcement}
              </p>
            </div>
          }
          toolbar={
            <>
              <PaneToolbar
                variant="Refinement"
                search={
                  <form
                    className={styles.search}
                    onSubmit={(event) => {
                      event.preventDefault();
                      const value = draft.trim();
                      update({ q: value === "" ? absent() : present(value) });
                    }}
                  >
                    <Input
                      type="search"
                      aria-label="Search imports"
                      placeholder="Search titles, files and sources"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                    />
                    <button type="submit" className="sr-only">
                      Apply search
                    </button>
                  </form>
                }
                filters={
                  <>
                    <SelectField
                      layout="Inline"
                      label="Type"
                      size="sm"
                      value={text(state.mediaKind)}
                      onChange={(event) =>
                        update({
                          mediaKind: chosen<MediaKind>(
                            event.target.value,
                            MEDIA_KINDS,
                          ),
                        })
                      }
                    >
                      <option value="">Any type</option>
                      {MEDIA_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {importKindLabel(kind)}
                        </option>
                      ))}
                    </SelectField>
                    <SelectField
                      layout="Inline"
                      label="Stage"
                      size="sm"
                      value={text(state.stage)}
                      onChange={(event) =>
                        update({
                          stage: chosen<ImportStage>(
                            event.target.value,
                            IMPORT_STAGES,
                          ),
                        })
                      }
                    >
                      <option value="">Any stage</option>
                      {IMPORT_STAGES.map((stage) => (
                        <option key={stage} value={stage}>
                          {importStageLabel(stage)}
                        </option>
                      ))}
                    </SelectField>
                    {view === "InProgress" ? null : (
                      <SelectField
                        layout="Inline"
                        label="Reason"
                        size="sm"
                        value={text(state.failureCode)}
                        onChange={(event) =>
                          update({
                            failureCode: chosen<SafeFailureCode>(
                              event.target.value,
                              SAFE_FAILURE_CODES,
                            ),
                          })
                        }
                      >
                        <option value="">Any reason</option>
                        {REASON_OPTIONS.map((code) => (
                          <option key={code} value={code}>
                            {IMPORT_FAILURE_COPY[code].reason}
                          </option>
                        ))}
                      </SelectField>
                    )}
                    {view !== "History" ? null : (
                      <>
                        <SelectField
                          layout="Inline"
                          label="State"
                          size="sm"
                          value={text(state.currentState)}
                          onChange={(event) =>
                            update({
                              currentState: chosen<ImportStateKind>(
                                event.target.value,
                                IMPORT_STATE_KINDS,
                              ),
                            })
                          }
                        >
                          <option value="">Any state</option>
                          {IMPORT_STATE_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {IMPORT_STATE_KIND_LABEL[kind]}
                            </option>
                          ))}
                        </SelectField>
                        <Toggle
                          size="sm"
                          label="Had failures"
                          checked={
                            state.hadFailures.kind === "Present" &&
                            state.hadFailures.value
                          }
                          onCheckedChange={(next) =>
                            update({
                              hadFailures: next ? present(true) : absent(),
                            })
                          }
                        />
                        <label className={styles.dateField}>
                          <span>From</span>
                          <input
                            type="date"
                            value={text(state.from)}
                            onChange={(event) =>
                              update({
                                from:
                                  event.target.value === ""
                                    ? absent()
                                    : present(event.target.value),
                              })
                            }
                          />
                        </label>
                        <label className={styles.dateField}>
                          <span>Before</span>
                          <input
                            type="date"
                            value={text(state.before)}
                            onChange={(event) =>
                              update({
                                before:
                                  event.target.value === ""
                                    ? absent()
                                    : present(event.target.value),
                              })
                            }
                          />
                        </label>
                      </>
                    )}
                  </>
                }
                controls={
                  <Button variant="ghost" size="sm" onClick={() => void refresh()}>
                    Refresh
                  </Button>
                }
              />
              <AppliedFilters
                chips={chips.map((chip) => ({ id: chip.id, label: chip.label }))}
                onRemove={(id) =>
                  onStateChange(
                    withoutImportsFilter(state, id as ImportsFilterField),
                  )
                }
                onClearAll={() => onStateChange(withoutImportsFilters(state))}
              />
            </>
          }
          state={
            <>
              {loadState.kind === "Failed" ? (
                summary === null ? (
                  <FeedbackNotice
                    content={importsLoadErrorMessage(loadState.error)}
                    announcement="Assertive"
                    actions={[{ label: "Try again", onClick: () => void refresh() }]}
                  />
                ) : (
                  <FeedbackNotice
                    content={IMPORTS_STALE_REFRESH_NOTICE}
                    announcement="Polite"
                    actions={[{ label: "Try again", onClick: () => void refresh() }]}
                  />
                )
              ) : null}
              {page.status === "error" && page.error !== null ? (
                <FeedbackNotice
                  content={importsLoadErrorMessage(page.error)}
                  announcement="Assertive"
                  actions={[{ label: "Try again", onClick: page.retry }]}
                />
              ) : null}
              {page.status === "loading" ? (
                <PaneLoadingState label="Loading imports" announcement="Polite" />
              ) : null}
            </>
          }
          empty={
            // A re-keyed read is not an empty view: only a page that actually
            // came back empty may say so.
            page.status !== "ready" ? undefined : (
            <div className={styles.empty}>
              <strong>{empty.title}</strong>
              <p>{empty.body}</p>
              {chips.length === 0 ? null : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onStateChange(withoutImportsFilters(state))}
                >
                  Clear filters
                </Button>
              )}
            </div>
            )
          }
          footer={
            <LoadMoreFooter
              hasMore={page.hasMore}
              loading={page.loadingMore}
              onLoadMore={page.loadMore}
            />
          }
        >
          {page.status === "ready" && page.items.length > 0 ? (
            <div ref={listRef} className={styles.list}>
              {grouped ? (
                sections.map((section) => (
                  <PaneSection
                    key={section.stage}
                    title={`${importStageLabel(section.stage)} (${section.count})`}
                  >
                    <ResourceList
                      ariaLabel={`${importStageLabel(section.stage)} imports`}
                    >
                      {rows(section.items)}
                    </ResourceList>
                  </PaneSection>
                ))
              ) : (
                <ResourceList ariaLabel={`${IMPORTS_VIEW_LABEL[view]} imports`}>
                  {rows(page.items)}
                </ResourceList>
              )}
            </div>
          ) : null}
        </PaneSurface>
      </TabsContent>
    </Tabs>
  );
}
