"use client";

// The followed shows. The url owns filter, sort and library scope and passes
// them to the server, which validates them; the text filter stays local.
// A selected scope owns its label read independently of the closed choices.

import { useCallback, useId, useMemo, useState } from "react";
import type { PodcastActionSubject } from "@/lib/actions/inlineActions";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { viewHref } from "@/lib/collections/view";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import RadioGroup from "@/components/ui/RadioGroup";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { PODCAST_BROWSE_ACTION } from "@/lib/podcasts/navigation";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { getLibrary, librariesPage, type Library } from "@/lib/libraries/api";
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { useMediaQueryRevision } from "@/lib/media/MediaSummaryProvider";
import { usePaneIsActive, usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import {
  matchesPaneFilterQuery,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import {
  listPodcasts,
  type PodcastRow,
} from "@/lib/podcasts/api";
import { remoteReady } from "@/lib/native/admission";
import { useCatalogRead, useCatalogState, useLiveGroup, usePromoteLiveGroup } from "@/lib/catalog/provider";
import { oldestRevision, type ConsumptionStamp } from "@/lib/consumption/listening";
import { isApiError } from "@/lib/api/client";
import { catalogPodcasts, catalogLibraries, catalogLibrary } from "@/lib/catalog/selectors";
import { useChangeStamp } from "@/lib/api/changes";
import {
  listRowStatus,
  pageQuery,
  useServerList,
  type ListSnapshot,
} from "@/lib/api/useServerList";
import {
  podcastErrorMessage,
  podcastRefresh,
} from "@/lib/podcasts/paneState";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";

const VISIT = definePaneVisitDataKey<ListSnapshot<PodcastRow, ConsumptionStamp>>(
  "Podcasts.Subscriptions",
);
const LIBRARIES = definePaneVisitDataKey<ListSnapshot<Library>>("Podcasts.LibraryChoices");
const SELECTED_LIBRARY = definePaneVisitDataKey<Visit<Library>>("Podcasts.SelectedLibrary");
const REFRESH = podcastRefresh({ kind: "Podcasts" });
const UNIT = { singular: "show", plural: "shows" };
const SORTS = [
  { value: "recent_episode", label: "Newest episode" },
  { value: "unplayed_count", label: "Most unplayed" },
  { value: "alpha", label: "Title A–Z" },
];
const FILTERS = [
  { value: "all", label: "All shows" },
  { value: "has_new", label: "Has new episodes" },
  { value: "not_in_library", label: "Not in a library" },
];

const fields = (row: PodcastRow) => [
  row.title,
  ...row.contributors.flatMap((credit) => [
    credit.contributor_display_name ?? "",
    credit.credited_name,
  ]),
];

export default function PodcastsPaneBody() {
  const router = usePaneRouter();
  const active = usePaneIsActive();
  const [librariesOpen, setLibrariesOpen] = useState(false);
  const params = usePaneSearchParams();
  const sort = params.get("sort") ?? "recent_episode";
  const filter = params.get("filter") ?? "all";
  const libraryId = params.get("library_id");
  const librariesRevision = useChangeStamp("Libraries");
  const query = new URLSearchParams({ sort, filter });
  if (libraryId !== null) query.set("library_id", libraryId);
  const key = query.toString();
  const savedPodcasts = useCatalogRead(value => {
    const page = catalogPodcasts(value, new URLSearchParams(key));
    return page === null ? null : { ...page, metadata: { consumption_revision: value.value.consumption_revision } };
  });
  const savedLibraries = useCatalogRead(catalogLibraries);
  // The index orders and filters by unplayed counts, so it is one consumption group.
  const group = useLiveGroup(`podcasts?${key}`);
  const stale = `${useChangeStamp("Podcasts")}:${librariesRevision}:${useMediaQueryRevision()}:${group.stale}`;
  const rawList = useServerList<PodcastRow, ConsumptionStamp>({
    catalog: savedPodcasts,
    foldMetadata: oldestRevision,
    key: `/podcasts?${key}`,
    stale,
    pageSize: 100,
    active,
    visit: VISIT,
    id: (row) => row.id,
    fetchPage: (cursor, limit, signal) =>
      listPodcasts(pageQuery(key, cursor, limit), signal),
  });
  // Relevance is the saved episodes of the scope's unfiltered shows: every followed show,
  // or the selected library's subscriptions; never narrowed by has_new/not_in_library.
  const catalog = useCatalogState();
  const scopedEpisodes = useMemo(() => {
    const raw = catalog.raw;
    if (raw === null) return new Set<string>();
    const shows = new Set(libraryId === null
      ? raw.value.shows.flatMap(row => row.index === null ? [] : [row.detail.podcast.id])
      : raw.libraryShows.get(libraryId)?.subscriptions.map(row => row.podcast.id) ?? []);
    return new Set(raw.value.episodes.flatMap(row => shows.has(row.podcast_id) ? [row.media_id] : []));
  }, [catalog.raw, libraryId]);
  usePromoteLiveGroup(group, rawList.source.kind === "live" && rawList.complete && rawList.failure === null && rawList.metadata !== null
    ? [rawList.metadata.consumption_revision] : null, scopedEpisodes);
  const saved = useMemo(() => {
    if (catalog.data === null) return null;
    try {
      const page = catalogPodcasts(catalog.data, new URLSearchParams(key));
      return page === null ? null : { items: page.items,
        source: { kind: "catalog" as const, snapshot_id: catalog.data.value.snapshot_id, captured_at: catalog.data.value.captured_at } };
    } catch (error) { if (isApiError(error)) return null; throw error; }
  }, [catalog.data, key]);
  const list = useMemo((): typeof rawList => group.live || saved === null ? rawList : {
    ...rawList, source: saved.source, status: "ready", items: saved.items, fresh: false,
    metadata: null, current: true, complete: true, orderRevision: null,
  }, [group.live, rawList, saved]);
  const actionFacts = (id: string): PodcastActionSubject["facts"] => list.failure !== null
    ? { kind: "Failed", error: list.failure.error, retry: list.retry, retrying: list.running !== null }
    : list.source.kind !== "live" || !remoteReady() || !list.fresh || list.running !== null
      ? { kind: "Resolving" } : { kind: "Ready", resolution: { kind: "Canonical", podcast_id: id, subscribed: true } };
  const libraries = useServerList<Library>({
    catalog: savedLibraries,
    key: "podcasts:member-libraries",
    stale: librariesRevision,
    pageSize: 200,
    active: active && librariesOpen,
    visit: LIBRARIES,
    id: library => library.id,
    fetchPage: (cursor, limit, signal) => librariesPage(pageQuery("", cursor, limit), signal),
  });
  const selectedLibraryId = libraryId !== null && !libraries.items.some(library => library.id === libraryId) ? libraryId : null;
  const savedSelectedLibrary = useCatalogRead(value => selectedLibraryId === null ? null : catalogLibrary(value, selectedLibraryId));
  const selectedLibrary = useServerValue<Library>({
    catalog: savedSelectedLibrary,
    key: selectedLibraryId,
    stale: librariesRevision,
    visit: SELECTED_LIBRARY,
    load: signal => {
      if (selectedLibraryId === null) throw new Error("selected library read requires a library id");
      return getLibrary(selectedLibraryId, signal).then(read => read.data);
    },
  });
  const selectedLibraryFailure = selectedLibrary.status !== "loading" && selectedLibrary.error !== null
    ? libraryErrorFeedback(selectedLibrary.error, "selected library couldn’t be loaded", throwDefect)
    : null;
  const rows = list.status === "ready" ? list.items : null;
  const complete = list.complete;
  const getRowStatus = useCallback(
    (text: string) => {
      const loaded = rows ?? [];
      const visible = loaded.filter((row) => matchesPaneFilterQuery(text, fields(row)));
      return listRowStatus(list, loaded.length, visible.length, UNIT);
    },
    [list, rows],
  );
  const filterRows = usePaneFilterRows({
    sourceKey: "Podcasts.Subscriptions",
    getRowStatus,
  });
  const replaceView = useCallback(
    (changes: Readonly<Record<string, string | null>>) =>
      router.replace(viewHref("/podcasts", params, changes), {
      }),
    [params, router],
  );
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const text = filterRows.query.trim();
  const visible = (rows ?? []).filter((row) => matchesPaneFilterQuery(text, fields(row)));
  const filtered = filter !== "all" || libraryId !== null;
  const emptyTitle = text
    ? complete ? "no shows match this filter." : "no matching show found so far."
    : filtered
      ? complete ? "no podcasts match the current filters." : "no matching show found so far."
      : complete ? "no followed podcasts yet." : "no shows loaded so far.";
  const readFeedback = useCollectionReadFeedback({
    list, unit: UNIT, waiting: list.status === "loading",
    outcome: visible.length > 0 ? "results updated." : emptyTitle,
    returnFocus: () => inputRef.current,
  });
  const librariesFeedback = useCollectionReadFeedback({
    list: libraries, unit: { singular: "library", plural: "libraries" },
    waiting: false, outcome: null, returnFocus: () => inputRef.current,
  });
  const libraryChoices = [
    { value: "", label: "All libraries" },
    ...(libraries.status === "ready" ? libraries.items.map((library) => ({ value: library.id, label: library.name })) : []),
  ];
  if (libraryId !== null && !libraryChoices.some((choice) => choice.value === libraryId)) {
    libraryChoices.push({ value: libraryId, label: selectedLibrary.status === "ready" ? selectedLibrary.data.name : "selected library" });
  }
  const showChoices = FILTERS.some((choice) => choice.value === filter) ? FILTERS : [...FILTERS, { value: filter, label: filter }];
  const sortChoices = SORTS.some((choice) => choice.value === sort) ? SORTS : [...SORTS, { value: sort, label: "Unsupported order" }];
  const chips = [
    ...(filter === "all" ? [] : [{ id: "filter", label: `Show: ${showChoices.find((choice) => choice.value === filter)?.label}` }]),
    ...(libraryId === null ? [] : [{ id: "library_id", label: `Library: ${libraryChoices.find((choice) => choice.value === libraryId)?.label}` }]),
  ];
  const canReset = sort !== "recent_episode" || chips.length > 0;
  const headerMeta: PaneHeaderMeta = complete
    ? { kind: "Count", value: rows?.length ?? 0, unit: "show" }
    : list.status === "loading"
      ? { kind: "Pending" }
      : { kind: "None" };
  const queryControls = {
    kind: "Controls" as const,
    label: "Filter followed podcasts",
    focusInput,
    content: <PaneQueryToolbar
      inputRef={inputRef}
      input={{ label: "Filter followed podcasts", placeholder: "Filter shows", value: filterRows.query, appliedValue: filterRows.query, onChange: filterRows.onQueryChange, onClear: filterRows.clearQuery }}
      options={{
        label: "Filters", activeCount: chips.length, onExpandedChange: setLibrariesOpen,
        onClear: () => replaceView({ filter: null, library_id: null }),
        content: <>
          <RadioGroup label="Show" value={filter} choices={showChoices} onChange={(value) => replaceView({ filter: value === "all" ? null : value })} />
          <RadioGroup label="Library" value={libraryId ?? ""} choices={libraryChoices} disabled={libraries.status === "loading"} onChange={(value) => replaceView({ library_id: value || null })} />
          {librariesFeedback.notice}
        </>,
      }}
      sort={{ label: "Sort", value: sort, choices: sortChoices, onChange: (value) => replaceView({ sort: value === "recent_episode" ? null : value }) }}
      chips={{ items: chips, onRemove: (id) => replaceView({ [id]: null }) }}
      status={{
        placement: "Inline",
        id: queryStatusId,
        visible: false,
        content: <PaneFilterRowsStatus announceQueryChanges={list.current && list.failure === null} id={queryStatusId} status={filterRows.rowStatus} query={filterRows.query} />,
      }}
      onReset={canReset ? () => {
        filterRows.clearQuery();
        replaceView({ sort: null, filter: null, library_id: null });
      } : undefined}
    />,
  };
  usePaneChrome({
    header: { kind: "Section", meta: headerMeta },
    primaryAction: PODCAST_BROWSE_ACTION,
    menuActions: [PODCAST_BROWSE_ACTION],
    query: queryControls,
    refresh: list.source.kind === "catalog" ? undefined : {
      kind: "Refreshable",
      sourceKey: `Podcasts.Subscriptions:${key}`,
      execute: REFRESH,
    },
  });
  usePaneReturnReady(list.status !== "loading");

  if (list.status === "failed" && list.failure !== null) {
    const invalidView = list.failure.error.code === "E_INVALID_REQUEST";
    return (
      <>
        {readFeedback.announcement}
        {librariesFeedback.announcement}
        <FeedbackNotice
          content={podcastErrorMessage(
            list.failure.error,
            "Followed podcasts couldn’t be loaded",
          )}
          announcement="Assertive"
          actions={[
            invalidView
              ? {
                  label: "Reset view",
                  onClick: () => router.replace("/podcasts"),
                }
              : { label: "Retry", onClick: list.retry, busy: list.running !== null },
          ]}
        />
      </>
    );
  }

  return (
    <>
      {readFeedback.announcement}
      {librariesFeedback.announcement}
      <CollectionView
        returnScope="Podcasts.Subscriptions"
        rows={visible.map((row) =>
          presentPodcast({
            facts: actionFacts(row.id),
            id: row.id,
            title: row.title,
            imageUrl: row.image_url,
            contributors: row.contributors,
            unplayedCount: null,
            recurring: null,
          }),
        )}
        status={list.status === "loading" ? "loading" : "ready"}
        ariaLabel="Followed podcasts"
        rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: text }}
        notice={<>
          {list.status === "ready" && list.failure && list.failure.op !== "More" ? (
            <FeedbackNotice
              content={podcastErrorMessage(
                list.failure.error,
                "Followed podcasts couldn’t be refreshed",
              )}
              announcement="Polite"
              actions={[{ label: "Retry", onClick: list.retry, busy: list.running !== null }]}
            />
          ) : selectedLibraryFailure !== null ? (
            <FeedbackNotice
              content={selectedLibraryFailure}
              announcement="Polite"
              actions={[{ label: "retry library", onClick: selectedLibrary.refetch, busy: selectedLibrary.status === "failed" ? selectedLibrary.retrying : selectedLibrary.status === "ready" && selectedLibrary.refreshing }]}
              returnFocus={() => inputRef.current}
            />
          ) : libraries.failure !== null && libraries.failure.op !== "More" ? (
            <FeedbackNotice
              content={podcastErrorMessage(
                libraries.failure.error,
                "Podcast libraries couldn’t be loaded",
              )}
              announcement="Polite"
              actions={[{ label: "Retry", onClick: libraries.retry, busy: libraries.running !== null }]}
            />
          ) : null}
          {text && list.current && !complete && list.failure === null && visible.length > 0
            ? <p>filter applies to loaded items.</p> : null}
        </>}
        empty={
          text ? (
            <FeedbackNotice
              content={{
                tone: "Neutral",
                title: emptyTitle,
              }}
              announcement="None"
            />
          ) : filtered ? (
            <FeedbackNotice
              content={{
                tone: "Neutral",
                title: emptyTitle,
              }}
              announcement="None"
              actions={[{ label: "clear filters", onClick: () => replaceView({ filter: null, library_id: null }) }]}
            />
          ) : (
            <FeedbackNotice
              content={{ tone: "Neutral", title: emptyTitle }}
              announcement="None"
              actions={[{ label: "browse podcasts", href: "/browse?kind=Podcast" }]}
            />
          )
        }
        footer={readFeedback.notice}
      />
    </>
  );
}
