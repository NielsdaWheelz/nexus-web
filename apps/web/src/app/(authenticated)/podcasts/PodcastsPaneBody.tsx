"use client";

// The followed shows. The url owns filter, sort and library scope and passes
// them to the server, which validates them; the text filter stays local.
// A selected scope owns its label read independently of the closed choices.

import { useCallback, useId, useMemo, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { viewHref } from "@/lib/collections/view";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import RadioGroup from "@/components/ui/RadioGroup";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { PODCAST_BROWSE_ACTION } from "@/lib/podcasts/navigation";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { getLibrary, librariesIndex, type Library } from "@/lib/libraries/api";
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
import { useServerValue, type Visit } from "@/lib/api/serverState";
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
import { useCatalogRead, useCatalogState, usePromoteLiveGroup } from "@/lib/catalog/provider";
import { unstamped } from "@/lib/consumption/listening";
import { isApiError } from "@/lib/api/client";
import { catalogPodcasts, catalogLibraries, catalogLibrary } from "@/lib/catalog/selectors";
import { useChangeStamp } from "@/lib/api/changes";
import { indexRowStatus, indexReading } from "@/lib/panes/indexRows";
import { usePodcastsIndexRead } from "@/lib/panes/indexPaneEntry";
import {
  podcastErrorMessage,
  podcastRefresh,
} from "@/lib/podcasts/paneState";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";

const VISIT = definePaneVisitDataKey<Visit<Awaited<ReturnType<typeof listPodcasts>>>>(
  "Podcasts.Subscriptions",
);
const LIBRARIES = definePaneVisitDataKey<Visit<Awaited<ReturnType<typeof librariesIndex>>>>("Podcasts.LibraryChoices");
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
  const [librariesSeen, setLibrariesSeen] = useState(false);
  if (librariesOpen && !librariesSeen) setLibrariesSeen(true);
  const sort = params.get("sort") ?? "recent_episode";
  const filter = params.get("filter") ?? "all";
  const libraryId = params.get("library_id");
  const librariesRevision = useChangeStamp("Libraries");
  const query = new URLSearchParams({ sort, filter });
  if (libraryId !== null) query.set("library_id", libraryId);
  const key = query.toString();
  const savedPodcasts = useCatalogRead(value => {
    const page = catalogPodcasts(value, new URLSearchParams(key));
    return page === null ? null : { data: page, consumption_revision: value.value.consumption_revision };
  });
  const savedLibraries = useCatalogRead(catalogLibraries);
  const { read: descriptor, group } = usePodcastsIndexRead();
  const rawList = useServerValue({ ...descriptor, catalog: savedPodcasts, visit: VISIT });
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
  usePromoteLiveGroup(group, rawList.status === "ready" && rawList.source.kind === "live" && rawList.error === null && rawList.fresh
    ? [rawList.data.consumption_revision] : null, scopedEpisodes);
  const saved = useMemo(() => {
    if (catalog.data === null) return null;
    try {
      const data = catalogPodcasts(catalog.data, new URLSearchParams(key));
      return data === null ? null : { data: { data, consumption_revision: catalog.data.value.consumption_revision },
        source: { kind: "catalog" as const, snapshot_id: catalog.data.value.snapshot_id, captured_at: catalog.data.value.captured_at } };
    } catch (error) { if (isApiError(error)) return null; throw error; }
  }, [catalog.data, key]);
  const snapshot: typeof rawList = group.live || saved === null ? rawList : {
    ...rawList, status: "ready", data: saved.data, source: saved.source, fresh: false, acceptedStale: null, generation: 0,
    error: rawList.status === "loading" ? null : rawList.error, refreshing: indexReading(rawList),
  };
  const list = unstamped(snapshot);
  const failure = list.status === "loading" ? null : list.error;
  const busy = indexReading(list);
  const retry = () => { void list.refetch().catch(() => {}); };
  const libraries = useServerValue({
    catalog: savedLibraries, key: librariesSeen ? "podcasts:member-libraries" : null,
    stale: librariesRevision, visit: LIBRARIES,
    load: (signal) => librariesIndex(new URLSearchParams(), signal),
  });
  const libraryItems = libraries.status === "ready" ? libraries.data.items : [];
  const libraryFailure = libraries.status === "loading" ? null : libraries.error;
  const retryLibraries = () => { void libraries.refetch().catch(() => {}); };
  const selectedLibraryId = libraryId !== null && !libraryItems.some(library => library.id === libraryId) ? libraryId : null;
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
  const rows = list.status === "ready" ? list.data.items : null;
  const complete = list.status === "ready";
  const getRowStatus = useCallback(
    (text: string) => {
      const loaded = rows ?? [];
      const visible = loaded.filter((row) => matchesPaneFilterQuery(text, fields(row)));
      return indexRowStatus(list, loaded.length, visible.length, UNIT);
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
    ? "no shows match this filter." : filtered ? "no podcasts match the current filters." : "no followed podcasts yet.";
  const readFeedback = useIndexReadFeedback({
    value: list, requestedKey: descriptor.key, active, unit: UNIT, waiting: list.status === "loading",
    outcome: visible.length > 0 ? "results updated." : emptyTitle,
    returnFocus: () => inputRef.current,
  });
  const libraryChoices = [
    { value: "", label: "All libraries" },
    ...(libraries.status === "ready" ? libraryItems.map((library) => ({ value: library.id, label: library.name })) : []),
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
        </>,
      }}
      sort={{ label: "Sort", value: sort, choices: sortChoices, onChange: (value) => replaceView({ sort: value === "recent_episode" ? null : value }) }}
      chips={{ items: chips, onRemove: (id) => replaceView({ [id]: null }) }}
      status={{
        placement: "Inline",
        id: queryStatusId,
        visible: false,
        content: <PaneFilterRowsStatus announceQueryChanges={(list.status === "ready") && failure === null} id={queryStatusId} status={filterRows.rowStatus} query={filterRows.query} />,
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
    refresh: list.status === "ready" && list.source.kind === "catalog" ? undefined : {
      kind: "Refreshable",
      sourceKey: `Podcasts.Subscriptions:${key}`,
      execute: REFRESH,
    },
  });
  usePaneReturnReady(list.status !== "loading");

  if (list.status === "failed" && failure !== null) {
    const invalidView = failure.code === "E_INVALID_REQUEST";
    return (
      <>
        {readFeedback.announcement}
        <FeedbackNotice
          content={podcastErrorMessage(
            failure,
            "couldn’t load shows",
          )}
          announcement="Polite"
          actions={[
            invalidView
              ? {
                  label: "Reset view",
                  onClick: () => router.replace("/podcasts"),
                }
              : { label: "try again", onClick: retry, busy },
          ]}
        />
      </>
    );
  }

  return (
    <>
      {readFeedback.announcement}
      <CollectionView
        returnScope="Podcasts.Subscriptions"
        rows={visible.map((row) =>
          presentPodcast({
            facts: failure !== null
              ? { kind: "Failed", observedSubscribed: list.status === "ready" && list.source.kind === "live" ? true : null, error: failure, retry, retrying: busy }
              : list.status !== "ready" || list.source.kind !== "live" || !remoteReady() || !list.fresh || busy
                ? { kind: "Resolving", observedSubscribed: list.status === "ready" && list.source.kind === "live" ? true : null }
                : { kind: "Ready", resolution: { kind: "Canonical", podcast_id: row.id, subscribed: true } },
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
          {list.status === "ready" && failure !== null ? (
            <FeedbackNotice
              content={podcastErrorMessage(
                failure,
                "couldn’t refresh shows",
              )}
              announcement="None"
              actions={[{ label: "try again", onClick: retry, busy }]}
            />
          ) : selectedLibraryFailure !== null ? (
            <FeedbackNotice
              content={selectedLibraryFailure}
              announcement={selectedLibrary.status === "ready" ? "None" : "Polite"}
              actions={[{ label: "retry library", onClick: selectedLibrary.refetch, busy: selectedLibrary.status === "failed" ? selectedLibrary.retrying : selectedLibrary.status === "ready" && selectedLibrary.refreshing }]}
              returnFocus={() => inputRef.current}
            />
          ) : libraryFailure !== null ? (
            <FeedbackNotice
              content={podcastErrorMessage(
                libraryFailure,
                libraries.status === "ready" ? "couldn’t refresh libraries" : "couldn’t load libraries",
              )}
              announcement={libraries.status === "ready" ? "None" : "Polite"}
              actions={[{ label: "try again", onClick: retryLibraries, busy: indexReading(libraries) }]}
            />
          ) : null}
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
      />
    </>
  );
}
