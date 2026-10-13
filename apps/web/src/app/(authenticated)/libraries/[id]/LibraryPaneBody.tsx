"use client";

import { useCallback, useId, useEffect, useMemo, useRef, useState } from "react";
import { requestNexusOpen } from "@/lib/nexus/events";
import { isInvalidViewError } from "@/lib/api/client";
import { libraryEntriesResource } from "@/lib/api/resource";
import { listRowStatus } from "@/lib/api/useServerList";
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
import type { AppliedFilterChip } from "@/components/ui/AppliedFilters";
import RadioGroup from "@/components/ui/RadioGroup";
import ChoiceField from "@/components/ui/ChoiceField";
import PaneSurface from "@/components/ui/PaneSurface";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { mediaListFilterFields } from "@/lib/media/mediaListFilter";
import CollectionView from "@/components/collections/CollectionView";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import SuggestionsSection from "@/components/collections/SuggestionsSection";
import type { CollectionRowView } from "@/lib/collections/types";
import LibraryMembersSurface from "@/components/libraries/LibraryMembersSurface";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import {
  usePaneParam,
  usePaneIsActive,
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
import {
  matchesPaneFilterQuery,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import type { PaneRefreshExecute } from "@/lib/panes/paneChrome";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { isAbortError } from "@/lib/errors";
import { podcastRefreshRequestAnnouncement, requestPodcastRefresh } from "@/lib/podcasts/api";
import {
  libraryEntryTargetId,
  type LibraryEntryListItem,
} from "@/lib/libraries/entryListItem";
import { suggestionTargetId } from "@/lib/suggestions";
import styles from "./LibraryPaneBody.module.css";

type LibraryEntry = LibraryEntryListItem;
const ENTRY_UNIT = { singular: "entry", plural: "entries" };
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
  return mediaListFilterFields(entry.kind === "media" ? entry.mediaSummary : entry.podcast);
}

export default function LibraryPaneBody() {
  const id = usePaneParam("id");
  if (!id) throw new Error("library route requires an id");
  return <LibraryPane key={id} id={id} />;
}

function LibraryPane({ id }: { readonly id: string }) {
  const paneRuntime = usePaneRuntime();
  const isPaneActive = usePaneIsActive();
  const paneId = paneRuntime?.paneId ?? `library-${id}`;
  const listRegionRef = useRef<HTMLDivElement | null>(null);
  const owner = useLibraryEntries({ id, active: isPaneActive });
  const {
    library: currentLibrary, entries: list, shownView: committedView,
    invalid: invalidView, libraryFailure, reorderBusy, setView, adoptLibrary,
    refresh: refreshLibrary,
  } = owner;
  const knownLibrary = currentLibrary;
  const entries = list.items;
  const summaries = useMediaSummaries(entries.flatMap((entry) => entry.kind === "media" ? [entry.mediaSummary] : []));
  const installedEntries = useMemo(() => entries.flatMap<LibraryEntry>((entry) => {
    if (entry.kind !== "media") return [entry];
    const mediaSummary = summaries.resolve(entry.mediaSummary);
    return mediaSummary === null ? [] : [{ ...entry, mediaSummary: mediaSummary }];
  }), [entries, summaries]);
  const view = owner.view.kind === "Valid" ? owner.view.view : null;
  const viewIsCommitted = list.current;
  const requestedViewKey = view === null ? null : libraryEntriesResource.cacheKey({ id, view });
  const draining = list.current && !list.complete && list.failure === null;
  const entryFailure =
    !invalidView && list.failure?.op === "Load" ? list.failure.error : null;
  const firstPageError = libraryFailure ?? entryFailure;
  const loading =
    knownLibrary === null && firstPageError === null && !invalidView && !owner.unavailable;
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
    if (currentLibrary?.can_manage_members === true) {
      setAuthorityFeedback(null);
    }
  }, [currentLibrary?.can_manage_members]);
  useEffect(() => setAuthorityFeedback(null), [id]);
  // the runtime reports the stored Companion: a remembered Members tab counts
  // only where this viewer is shown it.
  const membersShown =
    currentLibrary?.can_manage_members === true &&
    currentLibrary.is_default === false &&
    currentLibrary.system_key === null;
  const membersActive =
    isPaneActive &&
    membersShown &&
    paneRuntime?.secondaryPane?.group_id === "resource-inspector" &&
    paneRuntime.secondaryPane.visibility === "visible" &&
    paneRuntime.secondaryPane.active_surface_id === "resource-members";
  const libraryMembersController = useLibraryMembers({
    libraryId: id,
    library: currentLibrary,
    adoptLibrary,
    membersActive,
    announceAuthorityLoss: announceLibraryAuthorityLoss,
  });
  const isDefaultLibrary = knownLibrary?.is_default === true;
  // Entry mutation (add content, reorder, remove) is hidden for system-protected
  // libraries (e.g. the Oracle Corpus), which report canEditEntries === false.
  const canEditEntries =
    currentLibrary?.role === "admin" && currentLibrary.can_edit_entries === true;
  // Explicit reorder gate: Default has server-defined ordering and no reorder
  // UX/endpoint support, independent of canEditEntries (which stays true for
  // Default's "Add content" capability).
  const canReorder = canEditEntries && !isDefaultLibrary;
  useSetPaneLabel(knownLibrary ? libraryPresentation(knownLibrary).name : loading ? null : "Library");
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
                initialDestinations: currentLibrary.is_default
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
      if (hideFinished && entry.mediaSummary.consumption.state === "Finished") {
        return false;
      }
      if (isInProgressView && entry.mediaSummary.consumption.state !== "InProgress") {
        return false;
      }
      return true;
    },
    [hideFinished, isInProgressView],
  );
  const visibleEntries = useMemo(
    () => installedEntries.filter(isVisibleEntry),
    [installedEntries, isVisibleEntry],
  );
  const entryCollectionComplete = list.complete;
  const orderPresetIds = useMemo(
    () => orderPresetIdsFor(isDefaultLibrary),
    [isDefaultLibrary],
  );
  const projectionOptions = useMemo(
    () => projectionOptionsFor(isDefaultLibrary),
    [isDefaultLibrary],
  );
  const getFilterStatus = useCallback(
    (query: string) =>
      listRowStatus(
        list,
        visibleEntries.length,
        visibleEntries.filter((entry) =>
          matchesPaneFilterQuery(query, libraryEntryFilterFields(entry)),
        ).length,
        ENTRY_UNIT,
      ),
    [list, visibleEntries],
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
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
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
  const queryControls = invalidView || view === null ? undefined : {
    kind: "Controls" as const,
    label: "Filter library entries",
    focusInput,
    content: <PaneQueryToolbar
      inputRef={inputRef}
      input={{ label: "Filter library entries", placeholder: "Filter entries", value: filterQuery, appliedValue: filterQuery, onChange: onQueryChange, onClear: clearQuery }}
      options={{
        label: "Filters",
        activeCount: appliedFilters.length,
        onClear: clearDomainFilters,
        content: <>
          <RadioGroup
            label="Type"
            value={entryTypeOptionOf(view)}
            choices={LIBRARY_ENTRY_TYPE_OPTION_IDS.map((value) => ({ value, label: entryTypeOptionLabel(value) }))}
            onChange={(value) => setView(withEntryTypeOption(view,
              // justify-type-assertion: the group offers exactly these ids.
              value as LibraryEntryTypeOptionId,
            ))}
          />
          <RadioGroup
            label="View"
            value={projectionOptionOf(view)}
            choices={projectionOptions.map((value) => ({ value, label: projectionOptionLabel(value) }))}
            onChange={(value) => setView(withProjectionOption(view,
              // justify-type-assertion: the group offers exactly these ids.
              value as ProjectionOptionId,
            ))}
          />
          {projectionSupportsCompletion(view) ? <ChoiceField
            label="Hide finished"
            checked={completionOf(view) === "unfinished"}
            onChange={(checked) => setView(withCompletion(view, checked ? "unfinished" : "all"))}
          /> : null}
        </>,
      }}
      sort={{
        label: "Sort",
        value: orderToPresetId(view.order),
        choices: orderPresetIds.map((value) => ({ value, label: presetLabel(value, isDefaultLibrary) })),
        onChange: (value) => setView({ ...view, order: presetIdToOrder(
          // justify-type-assertion: the select offers exactly these ids.
          value as LibraryOrderPresetId,
        ) }),
      }}
      chips={{ items: appliedFilters, onRemove: (chipId) => {
        if (chipId === "type") setView(withEntryTypeOption(view, "all-types"));
        else if (chipId === "projection") setView(withProjectionOption(view, "all-items"));
        else if (chipId === "completion") setView(withCompletion(view, "all"));
      } }}
      status={{ id: queryStatusId, content: <PaneFilterRowsStatus id={queryStatusId} status={rowStatus} query={filterQuery} /> }}
      onReset={!isInitialLibraryView(view) || filterQuery ? resetView : undefined}
    />,
  };
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
  const publishMembers = membersShown && membersBody !== null;
  useResourceInspector({
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
      { kind: "Library", library_id: id },
      controller.signal,
    )
      .then(refreshLibrary)
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
  }, [id, refreshLibrary, presentFailure]);
  retryLibraryRefreshRef.current = retryLibraryRefresh;
  const executeRefresh = useCallback<PaneRefreshExecute>(
    async ({ signal }) => {
      try {
        const requestedCount = await requestPodcastRefresh(
          { kind: "Library", library_id: id },
          signal,
        );
        await refreshLibrary();
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
    [id, refreshLibrary],
  );
  usePaneChrome({
    query: queryControls,
    refresh:
      currentLibrary && requestedViewKey && viewIsCommitted
        ? {
          kind: "Refreshable",
          sourceKey: requestedViewKey,
          execute: executeRefresh,
        }
        : undefined,
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
        title: libraryFailure !== null
          ? "Library couldn’t be loaded" : "Library entries couldn’t be loaded",
        request: libraryFailure !== null ? "LibraryRead" : "EntryRead",
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
  const entryFooter = <CollectionExhaustionNotice list={list} />;
  const refetchError = list.failure?.op === "Refetch" ? list.failure.error : null;
  const entryRefreshError = refetchError ?? summaries.error;
  const entryReconciliationNotice = entryRefreshError === null ? null : <MediaSummaryNotice
    error={entryRefreshError}
    retry={() => {
      if (summaries.error !== null) summaries.retry();
      if (refetchError !== null) list.retry();
    }}
  />;
  const requestedViewLabel = view === null ? "" : formatLibraryView(view, isDefaultLibrary);
  const committedViewLabel = committedView === null ? "" : formatLibraryView(committedView, isDefaultLibrary);
  const entryStatusNode = !invalidView && !list.current ? (
    <div className={styles.entryViewStatus} role="status" aria-controls={entryRegionId}>
      <span>{`${entryFailure !== null ? "Could not load" : "Loading"} ${requestedViewLabel}.${list.status !== "ready" ? "" : ` Showing ${committedViewLabel}.`
        }`}</span>
      {firstPageError === null ? null : (
        <Button variant="ghost" size="sm" onClick={() => {
          inputRef.current?.focus({ preventScroll: true });
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
        id: libraryEntryTargetId(item),
        context: showAdded ? {
          kind: "Text",
          text: `${isDefaultLibrary ? "Added to Nexus " : "Added "}${formatAdded(item.added_at)}`,
        } : row.context,
      };
    }
    return presentMedia(item.mediaSummary, {
      id: libraryEntryTargetId(item),
      primary: {
        kind: "link",
        href: `/media/${item.mediaSummary.media_id}`,
      },
      actionSubject: {
        ref: canonicalResourceRef({ scheme: "media", id: item.mediaSummary.media_id }),
      },
      selected: false,
    });
  };
  const visibleEntryRows = filteredEntries.map(entryRowView);

  const entriesAccessibleName = libraryPresentation(knownLibrary).name;
  // Recoveries preserve order and return focus to the permanent query input.
  const recoverToAllItems = () => {
    if (committedView === null) return;
    inputRef.current?.focus({ preventScroll: true });
    setView({
      order: committedView.order,
      projection: { kind: "AllItems", completion: "all" },
      entryType: committedView.entryType,
    });
  };
  const recoverShowFinished = () => {
    if (committedView === null) return;
    inputRef.current?.focus({ preventScroll: true });
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
              inputRef.current?.focus({ preventScroll: true });
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
              inputRef.current?.focus({ preventScroll: true });
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
  const emptyEntryBody = filterQuery.trim() ? (
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
  ) : list.status !== "ready" ? // No false empty-state notice before the first commit.
    null : !list.complete ? (
      entryFooter
    ) : (
      emptyStateNotice
    );
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
  ) : (
    <CollectionView
      returnScope="Library.Entries"
      rows={visibleEntryRows}
      empty={emptyEntryBody}
      status="ready"
      ariaLabel={entriesAccessibleName}
      rowChangePresentation={{
        kind: "ImmediateOnKeyChange",
        key: filterQuery.trim(),
      }}
      rowActionsAvailable={viewIsCommitted}
      footer={filteredEntries.length > 0 ? entryFooter : undefined}
      collectionBusy={draining}
      surface={false}
      sortable={
        canReorder && committedView?.order.kind === "Canonical" &&
          committedView.projection.kind === "AllItems" && committedView.projection.completion === "all" &&
          committedView.entryType.kind === "AllTypes" && !filterQuery.trim()
          ? {
            disabled: reorderBusy || !owner.reorderable || list.running === "Refetch",
            onReorder: (nextRows) => {
              const byEntryId = new Map(
                filteredEntries.map((entry) => [
                  libraryEntryTargetId(entry),
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
          tabIndex={-1}
          aria-busy={
            (!list.current && !invalidView) || draining
              ? true
              : undefined
          }
        >
          {mainBody}
        </div>
        {currentLibrary !== null && list.complete ? (
          <SuggestionsSection
            key={currentLibrary.id}
            returnScope="Library.Suggestions"
            destination={{
              kind: "Library",
              id: currentLibrary.id,
              name: libraryPresentation(currentLibrary).name,
            }}
            paneId={paneId}
            isActive={isPaneActive}
            accept={async (target) => {
              await addLibraryPlacement({
                target: { kind: target.kind, id: suggestionTargetId(target) },
                destination: {
                  kind: "Library",
                  library: { id: currentLibrary.id, name: currentLibrary.name },
                },
              });
              return "Accepted";
            }}
          />
        ) : null}
      </PaneSurface>
    </>
  );
}
