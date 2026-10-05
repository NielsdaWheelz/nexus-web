"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { requestNexusOpen } from "@/lib/nexus/events";
import { isInvalidViewError } from "@/lib/api/client";
import { libraryEntriesResource } from "@/lib/api/resource";
import { present } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  FeedbackNotice,
  type FeedbackAnnouncement,
  type FeedbackActions,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { presentMedia } from "@/lib/collections/presenters/media";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { addLibraryPlacement } from "@/lib/libraries/libraryPlacement";
import Button from "@/components/ui/Button";
import AppliedFilters, { type AppliedFilterChip } from "@/components/ui/AppliedFilters";
import SelectField from "@/components/ui/SelectField";
import Toggle from "@/components/ui/Toggle";
import PaneSurface from "@/components/ui/PaneSurface";
import CollectionView from "@/components/collections/CollectionView";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import ReadingSlateSection from "@/components/collections/ReadingSlateSection";
import type { CollectionRowView } from "@/lib/collections/types";
import LibraryMembersSurface from "@/components/libraries/LibraryMembersSurface";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import PaneCollectionBar from "@/components/workspace/PaneCollectionBar";
import CollectionFilterEditor from "@/components/workspace/CollectionFilterEditor";
import usePaneCollectionInput from "@/components/workspace/usePaneCollectionInput";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import {
  usePaneParam,
  usePaneIsActive,
  usePaneIsVisible,
  usePaneRuntime,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { useLibraryMembers } from "@/lib/libraries/useLibraryMembers";
import { useLibraryEntries } from "@/lib/libraries/useLibraryEntries";
import {
  libraryRequestErrorMessage,
  type LibraryRequest,
} from "@/lib/libraries/libraryRequestErrorMessage";
import {
  CANONICAL_LIBRARY_VIEW,
  LIBRARY_ENTRY_TYPE_OPTION_IDS,
  completionOf,
  entryTypeOptionLabel,
  entryTypeOptionOf,
  formatLibraryView,
  isInitialLibraryView,
  orderPresetIdsFor,
  orderToPresetId,
  presetIdToOrder,
  presetLabel,
  projectionOptionLabel,
  projectionOptionOf,
  projectionOptionsFor,
  projectionSupportsCompletion,
  withCompletion,
  withEntryTypeOption,
  withProjectionOption,
  type LibraryEntryTypeOptionId,
  type LibraryOrderPresetId,
  type ProjectionOptionId,
} from "@/lib/libraries/libraryView";
import { libraryPresentation } from "@/lib/libraries/presentation";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import type { PaneRefreshExecute } from "@/lib/panes/panePublications";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { isAbortError } from "@/lib/errors";
import { podcastRefreshRequestAnnouncement, requestPodcastRefresh } from "@/lib/podcasts/refresh";
import type { LibraryEntryListItem } from "@/lib/libraries/entryListItem";
import { slateTargetId } from "@/lib/resonance";
import styles from "./LibraryPaneBody.module.css";

type LibraryEntry = LibraryEntryListItem;
const EMPTY_LIBRARY_ENTRIES: readonly LibraryEntry[] = [];
function libraryTargetId(entry: LibraryEntry): string {
  return entry.kind === "media" ? entry.media.id : entry.podcast.id;
}
interface LibraryPaneFeedback {
  readonly content: FeedbackContent;
  readonly actions?: FeedbackActions;
  readonly announcement?: FeedbackAnnouncement;
}

// The one full-date formatter for the "Added …" row line; the whole instant is
// formatted (not a date-only weekday), so it reads unambiguously.
const ADDED_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

function formatAdded(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, ADDED_DATE_FORMAT).format(date);
}

function libraryEntryFilterFields(entry: LibraryEntry): readonly string[] {
  const item = entry.kind === "media" ? entry.mediaSummary : entry.podcast;
  return [
    item.title,
    ...item.contributors.flatMap((credit) => [
      credit.contributor_display_name ?? "",
      credit.credited_name,
    ]),
  ];
}

export default function LibraryPaneBody() {
  const id = usePaneParam("id");
  if (!id) throw new Error("library route requires an id");
  const paneRuntime = usePaneRuntime();
  const isPaneActive = usePaneIsActive();
  const isPaneVisible = usePaneIsVisible();
  const paneId = paneRuntime?.paneId ?? `library-${id}`;
  const listRegionRef = useRef<HTMLDivElement | null>(null);
  const owner = useLibraryEntries({ id, active: isPaneActive, visible: isPaneVisible, regionRef: listRegionRef });
  const {
    committed, view: decodedView, state, exhaustion: entryExhaustion,
    reorderBusy, setView, adoptLibrary, revalidate: revalidateLibraryEntries,
  } = owner;
  const currentLibrary = committed?.library ?? null;
  const knownLibrary = owner.library;
  const entries = committed?.entries ?? EMPTY_LIBRARY_ENTRIES;
  const committedView = committed?.view ?? null;
  const view = decodedView.kind === "Valid" ? decodedView.view : null;
  const viewIsCommitted = state.kind === "Ready";
  const requestedViewKey = view === null ? null : libraryEntriesResource.cacheKey({ id, view });
  const invalidView = state.kind === "Invalid";
  const firstPageError = state.kind === "Failed" ? state.error : null;
  const loading = knownLibrary === null && state.kind === "Loading";
  const [error, setError] = useState<LibraryPaneFeedback | null>(null);
  const [authorityFeedback, setAuthorityFeedback] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const presentFailure = useCallback(
    (
      requestError: unknown,
      title: string,
      request: LibraryRequest,
      retry?: { readonly label: string; readonly onClick: () => void },
    ): void => {
      try {
        setError({
          content: libraryRequestErrorMessage(requestError, { title, request }),
          actions: retry ? [{ label: retry.label, onClick: retry.onClick }] : undefined,
        });
      } catch (caughtDefect) {
        setDefect({ error: caughtDefect });
      }
    },
    [],
  );
  const announceLibraryAuthorityLoss = useCallback(
    (message: string) =>
      setAuthorityFeedback({
        tone: "Warning",
        title: "Library access changed",
        message,
      }),
    [],
  );
  useEffect(() => {
    if (currentLibrary?.canManageMembers === true) {
      setAuthorityFeedback(null);
    }
  }, [currentLibrary?.canManageMembers]);
  useEffect(() => setAuthorityFeedback(null), [id]);
  const membersActive =
    isPaneActive &&
    paneRuntime?.secondaryPane?.groupId === "resource-inspector" &&
    paneRuntime.secondaryPane.visibility === "visible" &&
    paneRuntime.secondaryPane.activeSurfaceId === "resource-members";
  const libraryMembersController = useLibraryMembers({
    libraryId: id,
    library: currentLibrary,
    adoptLibrary,
    membersActive,
    announceAuthorityLoss: announceLibraryAuthorityLoss,
  });
  const isDefaultLibrary = knownLibrary?.isDefault === true;
  // Entry mutation (add content, reorder, remove) is hidden for system-protected
  // libraries (e.g. the Oracle Corpus), which report canEditEntries === false.
  const canEditEntries =
    currentLibrary?.role === "admin" && currentLibrary.canEditEntries === true;
  // Explicit reorder gate: Default has server-defined ordering and no reorder
  // UX/endpoint support, independent of canEditEntries (which stays true for
  // Default's "Add content" capability).
  const canReorder = canEditEntries && !isDefaultLibrary;
  const filtersTriggerRef = useRef<HTMLButtonElement | null>(null);
  const hideFinishedInputId = `library-hide-finished-${id}`;
  useSetPaneLabel(knownLibrary ? libraryPresentation(knownLibrary).name : loading ? null : "Library");
  useEffect(() => {
    if (owner.reconciliation?.recovery !== "RefreshList" || owner.reconciliation.error === null) return;
    const scope = listRegionRef.current?.closest<HTMLElement>("[data-pane-content]") ?? document;
    const button = Array.from(scope.querySelectorAll<HTMLButtonElement>("button"))
      .find(candidate => candidate.textContent?.trim() === "Refresh list");
    button?.focus();
  }, [owner.reconciliation?.recovery, owner.reconciliation?.error]);
  const handleReorderEntries = (nextEntries: readonly LibraryEntry[]) => {
    setError(null);
    void owner.reorder(nextEntries).catch((requestError: unknown) =>
      presentFailure(requestError, "Library entries weren’t reordered", "EntryMutation"),
    );
  };
  const addContentAction: ActionDescriptor[] =
    currentLibrary && canEditEntries && viewIsCommitted
      ? [
        {
          kind: "command",
          id: "ViewAction.Library.AddContent",
          label: "Add content",
          restoreFocusOnClose: false,
          onSelect: () =>
            requestNexusOpen({
              kind: "Add",
              seed: {
                kind: "Content",
                initialFocus: "Url",
                initialDestinations: currentLibrary.isDefault
                  ? []
                  : [
                    {
                      id: currentLibrary.id,
                      name: currentLibrary.name,
                    },
                  ],
              },
            }),
        },
      ]
      : [];

  const hideFinished =
    committedView !== null && completionOf(committedView) === "unfinished";
  const isInProgressView = committedView?.projection.kind === "InProgress";
  // Apply the committed projection's consumption filters to the installed rows.
  const isVisibleEntry = useCallback(
    (entry: LibraryEntry): boolean => {
      if (entry.kind !== "media") return true;
      if (hideFinished && entry.media.readState === "finished") {
        return false;
      }
      if (isInProgressView && entry.media.readState !== "in_progress") {
        return false;
      }
      return true;
    },
    [hideFinished, isInProgressView],
  );
  const visibleEntries = useMemo(
    () => entries.filter(isVisibleEntry),
    [entries, isVisibleEntry],
  );
  const entryCollectionComplete =
    committed?.nextCursor.kind === "Absent" &&
    entryExhaustion.kind === "Complete";
  const orderPresetIds = useMemo(
    () => orderPresetIdsFor(isDefaultLibrary),
    [isDefaultLibrary],
  );
  const projectionOptions = useMemo(
    () => projectionOptionsFor(isDefaultLibrary),
    [isDefaultLibrary],
  );
  const domainFilterControls = useMemo(
    () =>
      invalidView || view === null ? undefined : (
        <>
          <SelectField
            layout="Stacked"
            label="Type"
            value={entryTypeOptionOf(view)}
            onChange={(event) => {
              setView(
                withEntryTypeOption(
                  view,
                  event.target.value as LibraryEntryTypeOptionId,
                ),
              );
            }}
          >
            {LIBRARY_ENTRY_TYPE_OPTION_IDS.map((optionId) => (
              <option key={optionId} value={optionId}>
                {entryTypeOptionLabel(optionId)}
              </option>
            ))}
          </SelectField>
          <SelectField
            layout="Stacked"
            label="View"
            value={projectionOptionOf(view)}
            onChange={(event) => {
              setView(
                withProjectionOption(
                  view,
                  event.target.value as ProjectionOptionId,
                ),
              );
            }}
          >
            {projectionOptions.map((optionId) => (
              <option key={optionId} value={optionId}>
                {projectionOptionLabel(optionId)}
              </option>
            ))}
          </SelectField>
          {projectionSupportsCompletion(view) ? (
            <Toggle
              id={hideFinishedInputId}
              checked={completionOf(view) === "unfinished"}
              onCheckedChange={(checked) => {
                setView(withCompletion(view, checked ? "unfinished" : "all"));
              }}
              label="Hide finished"
            />
          ) : null}
        </>
      ),
    [
      hideFinishedInputId,
      invalidView,
      projectionOptions,
      setView,
      view,
    ],
  );
  const getFilterStatus = useCallback(
    (query: string) => {
      const visibleCount = visibleEntries.filter((entry) =>
        matchesPaneFilterQuery(query, libraryEntryFilterFields(entry)),
      ).length;
      const unit = { singular: "entry", plural: "entries" };
      if (committed !== null && !viewIsCommitted) {
        return {
          kind: "Retained" as const,
          visibleCount,
          loadedCount: visibleEntries.length,
          unit,
          cause: firstPageError === null ? "Updating" as const : "Failed" as const,
        };
      }
      if (
        (committed === null && firstPageError !== null) ||
        entryExhaustion.kind === "ResumeFailed" ||
        entryExhaustion.kind === "RefreshRequired"
      ) {
        return { kind: "Failed" as const, visibleCount, loadedCount: visibleEntries.length, unit };
      }
      return entryCollectionComplete
        ? {
          kind: "Complete" as const,
          visibleCount,
          totalCount: visibleEntries.length,
          unit,
        }
        : {
          kind: "Partial" as const,
          visibleCount,
          loadedCount: visibleEntries.length,
          unit,
        };
    },
    [committed, entryCollectionComplete, entryExhaustion.kind, firstPageError, viewIsCommitted, visibleEntries],
  );
  const {
    query: filterQuery,
    onQueryChange,
    clearQuery,
    rowStatus,
  } = usePaneFilterRows({
    sourceKey: `Library.Entries:${id}`,
    getRowStatus: getFilterStatus,
  });
  const { inputRef, focusInput } = usePaneCollectionInput();
  const resetView = useCallback(() => {
    clearQuery();
    setView(CANONICAL_LIBRARY_VIEW);
  }, [clearQuery, setView]);
  const clearDomainFilters = useCallback(() => {
    if (view === null) return;
    setView({
      order: view.order,
      projection: { kind: "AllItems", completion: "all" },
      entryType: { kind: "AllTypes" },
    });
  }, [setView, view]);
  const appliedFilters = useMemo<AppliedFilterChip[]>(() => view === null ? [] : [
    ...(view.entryType.kind === "AllTypes"
      ? []
      : [{ id: "type", label: `Type: ${entryTypeOptionLabel(view.entryType.value)}` }]),
    ...(view.projection.kind === "AllItems"
      ? []
      : [{ id: "projection", label: `View: ${projectionOptionLabel(projectionOptionOf(view))}` }]),
    ...(completionOf(view) === "all"
      ? []
      : [{ id: "completion", label: "Hide finished" }]),
  ], [view]);
  const collection = useMemo(
    () =>
      invalidView || view === null
        ? undefined
        : {
          label: "Filter library entries",
          content: (
            <PaneCollectionBar
              inputRef={inputRef}
              inputLabel="Filter library entries"
              placeholder="Filter entries"
              query={filterQuery}
              onQueryChange={onQueryChange}
              onClearQuery={clearQuery}
              rowStatus={rowStatus}
              filters={
                <>
                  <SelectField
                    layout="Inline"
                    label="Sort entries"
                    size="sm"
                    value={orderToPresetId(view.order)}
                    onChange={(event) =>
                      setView({
                        order: presetIdToOrder(event.target.value as LibraryOrderPresetId),
                        projection: view.projection,
                        entryType: view.entryType,
                      })
                    }
                  >
                    {orderPresetIds.map((presetId) => (
                      <option key={presetId} value={presetId}>
                        {presetLabel(presetId, isDefaultLibrary)}
                      </option>
                    ))}
                  </SelectField>
                  <CollectionFilterEditor
                    activeCount={appliedFilters.length}
                    triggerRef={filtersTriggerRef}
                    onClearFilters={clearDomainFilters}
                    onResetView={!isInitialLibraryView(view) || filterQuery.trim() ? resetView : undefined}
                  >
                    {domainFilterControls}
                  </CollectionFilterEditor>
                </>
              }
              appliedFilters={
                <AppliedFilters
                  chips={appliedFilters}
                  returnFocusTo={filtersTriggerRef}
                  onRemove={(chipId) => {
                    if (chipId === "type") {
                      setView(withEntryTypeOption(view, "all-types"));
                    } else if (chipId === "projection") {
                      setView(withProjectionOption(view, "all-items"));
                    } else if (chipId === "completion") {
                      setView(withCompletion(view, "all"));
                    }
                  }}
                />
              }
            />
          ),
          focusInput,
        },
    [
      appliedFilters,
      clearDomainFilters,
      resetView,
      clearQuery,
      domainFilterControls,
      filterQuery,
      focusInput,
      inputRef,
      invalidView,
      onQueryChange,
      isDefaultLibrary,
      orderPresetIds,
      rowStatus,
      setView,
      view,
    ],
  );
  const filteredEntries = useMemo(
    () =>
      visibleEntries.filter((entry) =>
        matchesPaneFilterQuery(filterQuery, libraryEntryFilterFields(entry)),
      ),
    [filterQuery, visibleEntries],
  );
  const entryMeta: PaneHeaderMeta =
    loading || !entryCollectionComplete
      ? { kind: "Pending" }
      : { kind: "Count", value: visibleEntries.length, unit: "entry" };
  const connectionsBody = useMemo(
    () => (
      <ConnectionsSurface
        resourceRef={{ scheme: "library", id }}
      />
    ),
    [id],
  );
  const membersBody = useMemo(
    () =>
      libraryMembersController ? (
        <LibraryMembersSurface controller={libraryMembersController} />
      ) : null,
    [libraryMembersController],
  );
  const publishMembers =
    currentLibrary?.canManageMembers === true &&
    currentLibrary.isDefault === false &&
    currentLibrary.systemKey === null &&
    membersBody !== null;
  const { companionAction } = useResourceInspector({
    scheme: "library",
    handle: currentLibrary ? id : null,
    bodies: {
      members: publishMembers ? membersBody : undefined,
      linkedItems: connectionsBody,
    },
  });
  const retryLibraryRefreshRef = useRef<() => void>(() => { });
  const retryLibraryRefresh = useCallback(() => {
    const controller = new AbortController();
    setError(null);
    void requestPodcastRefresh(
      { kind: "Library", libraryId: id },
      controller.signal,
    )
      .then(async () => {
        await revalidateLibraryEntries(controller.signal);
      })
      .catch((refreshError: unknown) => {
        if (isAbortError(refreshError)) return;
        if (handleUnauthenticatedApiError(refreshError)) return;
        presentFailure(
          refreshError,
          "Library couldn’t be refreshed",
          "PodcastMutation",
          {
            label: "Retry",
            onClick: () => retryLibraryRefreshRef.current(),
          },
        );
      });
  }, [id, presentFailure, revalidateLibraryEntries]);
  retryLibraryRefreshRef.current = retryLibraryRefresh;
  const executeRefresh = useCallback<PaneRefreshExecute>(
    async ({ signal }) => {
      try {
        const requestedCount = await requestPodcastRefresh(
          { kind: "Library", libraryId: id },
          signal,
        );
        await revalidateLibraryEntries(signal);
        return {
          kind: "Complete",
          announcement: podcastRefreshRequestAnnouncement(requestedCount),
        };
      } catch (refreshError: unknown) {
        if (isAbortError(refreshError)) throw refreshError;
        const content = libraryRequestErrorMessage(
          refreshError,
          {
            title: "Library couldn’t be refreshed",
            request: "PodcastMutation",
          },
        );
        setError({
          content,
          announcement: "None",
          actions: [
            {
              label: "Retry",
              onClick: () => retryLibraryRefreshRef.current(),
            },
          ],
        });
        return {
          kind: "Failed",
          announcement: content.title,
        };
      }
    },
    [id, revalidateLibraryEntries],
  );
  usePanePrimaryChrome({
    collection,
    refresh:
      currentLibrary && requestedViewKey && viewIsCommitted
        ? {
          kind: "Refreshable",
          sourceKey: requestedViewKey,
          execute: executeRefresh,
        }
        : undefined,
    companionAction: companionAction ?? undefined,
    // The pane's canonical identity is its route key, not a fact of any read it
    // is still waiting on. Publishing it late leaves the menu with no subject,
    // so it renders no resource suffix and no loading row either: the surface
    // looks settled while it is not. The snapshot owns missing state.
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "library", id }),
    },
    menuActions: addContentAction,
    header: { kind: "Section", meta: entryMeta },
  });

  if (defect !== null) throw defect.error;
  const firstPageFailureContent = firstPageError === null ? null
    : isInvalidViewError(firstPageError) ? { tone: "Danger" as const, title: "Invalid library view" }
      : libraryRequestErrorMessage(firstPageError, {
        title: state.kind === "Failed" && state.request === "LibraryRead"
          ? "Library couldn’t be loaded" : "Library entries couldn’t be loaded",
        request: state.kind === "Failed" ? state.request : "EntryRead",
      });
  if (loading) return <>
    <PaneLoadingState label="Loading library…" announcement="Polite" />
    {filterQuery.trim() && filteredEntries.length === 0 ? (
      <FeedbackNotice content={{ tone: "Neutral", title: "No matching entry found so far." }} announcement="None" />
    ) : null}
  </>;
  if (knownLibrary === null) return <FeedbackNotice
    content={invalidView ? { tone: "Danger", title: "Invalid library view" }
      : firstPageFailureContent ?? error?.content ?? { tone: "Danger", title: "Library not found" }}
    announcement="Assertive"
    actions={invalidView ? [{ label: "Reset view", onClick: resetView }]
      : firstPageError ? [{ label: "Retry", onClick: owner.retry }] : error?.actions}
  />;
  const entryRegionId = `library-entry-region-${id}`;
  const canReorderVisibleEntries = viewIsCommitted && canReorder &&
    committedView?.order.kind === "Canonical" && committedView.projection.kind === "AllItems" &&
    committedView.projection.completion === "all" && committedView.entryType.kind === "AllTypes" &&
    committed?.nextCursor.kind === "Absent" && entryExhaustion.kind === "Complete";
  const entryFooter = <CollectionExhaustionNotice state={entryExhaustion} />;
  const entryReconciliationNotice = owner.reconciliation === null ? null : <FeedbackNotice
    content={owner.reconciliation.error === null
      ? { tone: "Neutral", title: "Refreshing library entries…" }
      : owner.reconciliation.recovery === "RefreshList"
        ? { tone: "Warning", title: "List changed while loading" }
        : libraryRequestErrorMessage(owner.reconciliation.error, {
          title: "Library entries couldn’t be refreshed", request: "EntryRead",
        })}
    announcement={owner.reconciliation.error === null ? "Polite" : "Assertive"}
    actions={owner.reconciliation.error === null ? undefined : [{
      label: owner.reconciliation.recovery === "RefreshList" ? "Refresh list" : "Retry",
      onClick: owner.retry,
    }]}
  />;
  const requestedViewLabel = view === null ? "" : formatLibraryView(view, isDefaultLibrary);
  const committedViewLabel = committedView === null ? "" : formatLibraryView(committedView, isDefaultLibrary);
  const entryStatusNode = !invalidView && state.kind !== "Ready" ? (
    <div className={styles.entryViewStatus} role="status" aria-controls={entryRegionId}>
      <span>{`${state.kind === "Failed" ? "Could not load" : "Loading"} ${requestedViewLabel}.${committed === null ? "" : ` Showing ${committedViewLabel}.`
        }`}</span>
      {firstPageError === null ? null : (
        <Button variant="ghost" size="sm" onClick={() => {
          filtersTriggerRef.current?.focus({ preventScroll: true });
          owner.retry();
        }}>Retry</Button>
      )}
    </div>
  ) : null;
  const entryRowView = (item: LibraryEntry): CollectionRowView => {
    const showAdded = committedView?.order.kind === "Added";
    if (item.kind === "podcast") {
      const row = presentPodcast({
        id: item.podcast.id,
        title: item.podcast.title,
        contributors: item.podcast.contributors,
        unplayedCount: item.podcast.unplayedCount,
        publicationDate: item.podcast.publicationDate,
        syncStatus: item.podcast.syncStatus,
      });
      return {
        ...row,
        id: libraryTargetId(item),
        context: showAdded ? present({
          kind: "Text",
          text: `${isDefaultLibrary ? "Added to Nexus " : "Added "}${formatAdded(item.addedAt)}`,
        }) : row.context,
      };
    }
    return presentMedia(item.mediaSummary, {
      id: libraryTargetId(item),
      primary: {
        kind: "link",
        href: `/media/${item.mediaSummary.mediaId}`,
      },
      actionSubject: {
        ref: canonicalResourceRef({ scheme: "media", id: item.mediaSummary.mediaId }),
      },
      selected: false,
    });
  };
  const visibleEntryRows = filteredEntries.map(entryRowView);

  const entriesAccessibleName = libraryPresentation(knownLibrary).name;
  // Both recoveries request AllItems(All) preserving order and focus View; the
  // completion-only "Show finished" recovery focuses the Hide-finished checkbox.
  const recoverToAllItems = () => {
    if (committedView === null) return;
    filtersTriggerRef.current?.focus({ preventScroll: true });
    setView({
      order: committedView.order,
      projection: { kind: "AllItems", completion: "all" },
      entryType: committedView.entryType,
    });
  };
  const recoverShowFinished = () => {
    if (committedView === null) return;
    filtersTriggerRef.current?.focus({ preventScroll: true });
    setView(withCompletion(committedView, "all"));
  };
  // Closed-union empty-state precedence (never inferred from counts).
  const emptyStateNotice = (() => {
    const exactEntryType =
      committedView?.entryType.kind === "ExactType"
        ? committedView.entryType.value
        : null;
    const projection =
      committedView?.projection ?? CANONICAL_LIBRARY_VIEW.projection;
    if (exactEntryType !== null) {
      return (
        <FeedbackNotice
          content={{
            tone: "Neutral",
            title: `No matches for “${entryTypeOptionLabel(exactEntryType)}” in this view.`,
          }}
          announcement="Polite"
          actions={[{
            label: "Clear filters", onClick: () => {
              filtersTriggerRef.current?.focus({ preventScroll: true });
              clearDomainFilters();
            }
          }]}
        />
      );
    }
    if (projection.kind === "InProgress") {
      return (
        <FeedbackNotice
          content={{ tone: "Neutral", title: "Nothing in progress." }}
          announcement="Polite"
          actions={[{ label: "Show all items", onClick: recoverToAllItems }]}
        />
      );
    }
    if (projection.kind === "Unfiled") {
      return projection.completion === "all" ? (
        <FeedbackNotice
          content={{ tone: "Neutral", title: "Everything is filed." }}
          announcement="Polite"
          actions={[{ label: "Show all items", onClick: recoverToAllItems }]}
        />
      ) : (
        <FeedbackNotice
          content={{
            tone: "Neutral",
            title: "No unfinished unfiled items.",
          }}
          announcement="Polite"
          actions={[{
            label: "Clear filters", onClick: () => {
              filtersTriggerRef.current?.focus({ preventScroll: true });
              clearDomainFilters();
            }
          }]}
        />
      );
    }
    return projection.completion === "all" ? (
      <FeedbackNotice
        content={{
          tone: "Neutral",
          title: isDefaultLibrary
            ? "No media yet."
            : "No podcasts or media in this library yet.",
        }}
        announcement="Polite"
      />
    ) : (
      <FeedbackNotice
        content={{ tone: "Neutral", title: "No unfinished items." }}
        announcement="Polite"
        actions={[{ label: "Show finished", onClick: recoverShowFinished }]}
      />
    );
  })();
  const mainBody = invalidView ? (
    <FeedbackNotice
      content={{ tone: "Danger", title: "Invalid library view" }}
      announcement="Assertive"
      actions={[
        {
          label: "Reset view",
          onClick: () => {
            clearQuery();
            setView(CANONICAL_LIBRARY_VIEW);
          },
        },
      ]}
    />
  ) : filteredEntries.length > 0 ? (
    <CollectionView
      returnScope="Library.Entries"
      rows={visibleEntryRows}
      status="ready"
      ariaLabel={entriesAccessibleName}
      rowChangePresentation={{
        kind: "ImmediateOnKeyChange",
        key: filterQuery.trim(),
      }}
      rowActionsAvailable={viewIsCommitted}
      footer={entryFooter}
      collectionBusy={entryExhaustion.kind === "Draining"}
      surface={false}
      sortable={
        canReorderVisibleEntries && !filterQuery.trim()
          ? {
            disabled: reorderBusy,
            onReorder: (nextRows) => {
              const byEntryId = new Map(
                filteredEntries.map((entry) => [
                  libraryTargetId(entry),
                  entry,
                ]),
              );
              const nextEntries = nextRows
                .map((row) => byEntryId.get(row.id))
                .filter(
                  (entry): entry is LibraryEntry => entry !== undefined,
                );
              if (nextEntries.length === filteredEntries.length) {
                handleReorderEntries(nextEntries);
              }
            },
          }
          : undefined
      }
    />
  ) : filterQuery.trim() ? (
    entryCollectionComplete ? (
      <FeedbackNotice
        content={{
          tone: "Neutral",
          title: "No entries match this filter.",
        }}
        announcement="Polite"
      />
    ) : (
      <>
        <FeedbackNotice
          content={{
            tone: "Neutral",
            title: "No matching entry found so far.",
          }}
          announcement="Polite"
        />
        {entryFooter}
      </>
    )
  ) : currentLibrary ===
    null ? // (rows/empty-state only); the polite status node carries "Loading …" / // Metadata known but no page has committed yet: the busy region stays empty
    // "Could not load …". No false empty-state notice before the first commit.
    null : entryExhaustion.kind !== "Complete" ? (
      entryFooter
    ) : (
      emptyStateNotice
    );

  return (
    <>
      <PaneSurface
        state={
          error || authorityFeedback || entryReconciliationNotice ? (
            <>
              {error ? (
                <FeedbackNotice
                  content={error.content}
                  announcement={error.announcement ?? "Assertive"}
                  actions={error.actions}
                />
              ) : null}
              {authorityFeedback ? (
                <FeedbackNotice
                  content={authorityFeedback}
                  announcement="Assertive"
                />
              ) : null}
              {entryReconciliationNotice}
            </>
          ) : null
        }
      >
        {entryStatusNode}
        <div
          id={entryRegionId}
          ref={listRegionRef}
          role="region"
          aria-label={entriesAccessibleName}
          aria-busy={
            state.kind === "Refreshing" ||
              (state.kind === "Loading" && !invalidView) ||
              entryExhaustion.kind === "Draining"
              ? true
              : undefined
          }
        >
          {mainBody}
        </div>
        {currentLibrary !== null &&
          committed?.nextCursor.kind === "Absent" &&
          entryExhaustion.kind === "Complete" ? (
          <ReadingSlateSection
            key={currentLibrary.id}
            returnScope="Library.ReadingSlate"
            destination={{
              kind: "Library",
              id: currentLibrary.id,
              name: libraryPresentation(currentLibrary).name,
            }}
            paneId={paneId}
            isActive={isPaneActive}
            accept={async (target) => {
              await addLibraryPlacement({
                target: { kind: target.kind, id: slateTargetId(target) },
                destination: {
                  kind: "Library",
                  library: { id: currentLibrary.id, name: currentLibrary.name },
                },
              });
            }}
          />
        ) : null}
      </PaneSurface>
    </>
  );
}
