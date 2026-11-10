"use client";

// The followed sources. The url owns filter, sort and library scope and passes
// them to the server, which validates them; the text filter stays local.
// A selected scope owns its label read independently of the closed choices.

import { useCallback, useId, useMemo, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import { Fact, Failed } from "@/components/feedback/Fact";
import { useActiveRegion } from "@/components/feedback/stage";
import { catalogLine } from "@/lib/catalog/copy";
import { viewHref } from "@/lib/collections/view";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import RadioGroup from "@/components/ui/RadioGroup";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { feedBrowseAction } from "@/lib/feeds/navigation";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { presentFeed } from "@/lib/collections/presenters/feed";
import { libraryReason } from "@/lib/libraries/errors";
import { getLibrary, librariesIndex, type Library } from "@/lib/libraries/api";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { usePaneIsActive, usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import {
  matchesPaneFilterQuery,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import { listFeeds, type FeedRow } from "@/lib/feeds/api";

import { useCatalogRead, useCatalogState, usePromoteLiveGroup } from "@/lib/catalog/provider";
import { unstamped } from "@/lib/consumption/listening";
import { isApiError } from "@/lib/api/client";
import { catalogFeeds, catalogLibraries, catalogLibrary } from "@/lib/catalog/selectors";
import { useChangeStamp } from "@/lib/api/changes";
import { indexRowStatus, indexReading } from "@/lib/panes/indexRows";
import { useFeedsIndexRead } from "@/lib/panes/indexPaneEntry";
import { feedRefresh } from "@/lib/feeds/paneState";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";

const VISIT = definePaneVisitDataKey<Visit<Awaited<ReturnType<typeof listFeeds>>>>(
  "Podcasts.Subscriptions",
);
const LIBRARIES = definePaneVisitDataKey<Visit<Awaited<ReturnType<typeof librariesIndex>>>>("Podcasts.LibraryChoices");
const SELECTED_LIBRARY = definePaneVisitDataKey<Visit<Library>>("Podcasts.SelectedLibrary");
const fields = (row: FeedRow) => [
  row.title,
  ...row.contributors.flatMap((credit) => [
    credit.contributor_display_name ?? "",
    credit.credited_name,
  ]),
];

export default function FeedsPaneBody({ kind }: { readonly kind: "podcast" | "article" }) {
  const noun = kind === "podcast" ? "podcasts" : "feeds";
  const href = kind === "podcast" ? "/podcasts" : "/feeds";
  const browse = feedBrowseAction(kind);
  const sorts = [{ value: "recent_entry", label: kind === "podcast" ? "Newest episode" : "Newest article" }, { value: "unfinished_count", label: kind === "podcast" ? "Most unplayed" : "Most unfinished" }, { value: "alpha", label: "Title A–Z" }];
  const filters = [{ value: "all", label: kind === "podcast" ? "All shows" : "All feeds" }, { value: "has_new", label: kind === "podcast" ? "Has new episodes" : "Has new articles" }, { value: "not_in_library", label: "Not in a library" }];
  const speak = useActiveRegion();
  const router = usePaneRouter();
  const active = usePaneIsActive();
  const [librariesOpen, setLibrariesOpen] = useState(false);
  const params = usePaneSearchParams();
  const [librariesSeen, setLibrariesSeen] = useState(false);
  if (librariesOpen && !librariesSeen) setLibrariesSeen(true);
  const sort = params.get("sort") ?? "recent_entry";
  const filter = params.get("filter") ?? "all";
  const libraryId = params.get("library_id");
  const librariesRevision = useChangeStamp("Libraries");
  const query = new URLSearchParams({ kind, sort, filter });
  if (libraryId !== null) query.set("library_id", libraryId);
  const key = query.toString();
  const savedPodcasts = useCatalogRead(value => {
    const page = catalogFeeds(value, new URLSearchParams(key));
    return page === null ? null : { data: page, consumption_revision: value.value.consumption_revision };
  });
  const savedLibraries = useCatalogRead(catalogLibraries);
  const { read: descriptor, group } = useFeedsIndexRead();
  const rawList = useServerValue({ ...descriptor, catalog: savedPodcasts, visit: VISIT });
  // Relevance is the saved entries of the scope's unfiltered sources: every followed source,
  // or the selected library's subscriptions; never narrowed by has_new/not_in_library.
  const catalog = useCatalogState();
  const scopedEpisodes = useMemo(() => {
    const raw = catalog.raw;
    if (raw === null) return new Set<string>();
    const shows = new Set(libraryId === null
      ? raw.value.sources.flatMap(row => row.index === null ? [] : [row.detail.feed.id])
      : raw.librarySources.get(libraryId)?.subscriptions.map(row => row.feed.id) ?? []);
    return new Set([...raw.value.episodes, ...raw.value.articles].flatMap(row => shows.has(row.feed_id) ? [row.media_id] : []));
  }, [catalog.raw, libraryId]);
  usePromoteLiveGroup(group, rawList.status === "ready" && rawList.source.kind === "live" && rawList.error === null && rawList.fresh
    ? [rawList.data.consumption_revision] : null, scopedEpisodes);
  const saved = useMemo(() => {
    if (catalog.data === null) return null;
    try {
      const data = catalogFeeds(catalog.data, new URLSearchParams(key));
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
  const catalogFailure = failure === null ? null : catalogLine(failure);
  const busy = indexReading(list);
  const retry = () => { void list.refetch().catch(() => {}); };
  const libraries = useServerValue({
    catalog: savedLibraries, key: librariesSeen ? "podcasts:member-libraries" : null,
    stale: librariesRevision, visit: LIBRARIES,
    load: (signal) => librariesIndex(new URLSearchParams(), signal),
  });
  const libraryItems = libraries.status === "ready" ? libraries.data.items : [];
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
  const rows = list.status === "ready" ? list.data.items : null;
  const complete = list.status === "ready";
  const getRowStatus = useCallback(
    (text: string) => {
      const loaded = rows ?? [];
      const visible = loaded.filter((row) => matchesPaneFilterQuery(text, fields(row)));
      const unit = kind === "podcast" ? { singular: "show", plural: "shows" } : { singular: "feed", plural: "feeds" };
      return indexRowStatus(list, loaded.length, visible.length, unit);
    },
    [list, rows, kind],
  );
  const filterRows = usePaneFilterRows({
    sourceKey: "Podcasts.Subscriptions",
    getRowStatus,
  });
  const replaceView = useCallback(
    (changes: Readonly<Record<string, string | null>>) =>
      router.replace(viewHref(href, params, changes), {
      }),
    [params, router, href],
  );
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const text = filterRows.query.trim();
  const visible = (rows ?? []).filter((row) => matchesPaneFilterQuery(text, fields(row)));
  const filtered = filter !== "all" || libraryId !== null;
  const emptyTitle = text
    ? `no ${noun} match this filter.` : filtered ? `no ${noun} match these filters.` : `no subscribed ${noun}.`;
  const readFeedback = useIndexReadFeedback({ value: list, requestedKey: descriptor.key, active, waiting: list.status === "loading", outcome: visible.length > 0 ? "results updated." : emptyTitle });
  const libraryChoices = [
    { value: "", label: "All libraries" },
    ...(libraries.status === "ready" ? libraryItems.map((library) => ({ value: library.id, label: library.name })) : []),
  ];
  if (libraryId !== null && !libraryChoices.some((choice) => choice.value === libraryId)) {
    libraryChoices.push({ value: libraryId, label: selectedLibrary.status === "ready" ? selectedLibrary.data.name : "selected library" });
  }
  const showChoices = filters.some((choice) => choice.value === filter) ? filters : [...filters, { value: filter, label: filter }];
  const sortChoices = sorts.some((choice) => choice.value === sort) ? sorts : [...sorts, { value: sort, label: "Unsupported order" }];
  const chips = [
    ...(filter === "all" ? [] : [{ id: "filter", label: `Show: ${showChoices.find((choice) => choice.value === filter)?.label}` }]),
    ...(libraryId === null ? [] : [{ id: "library_id", label: `Library: ${libraryChoices.find((choice) => choice.value === libraryId)?.label}` }]),
  ];
  const canReset = sort !== "recent_entry" || chips.length > 0;
  const headerMeta: PaneHeaderMeta = complete
    ? { kind: "Count", value: rows?.length ?? 0, unit: kind === "podcast" ? "show" : "feed" }
    : list.status === "loading"
      ? { kind: "Pending" }
      : { kind: "None" };
  const libraryFailureReason = libraries.status === "failed" ? libraryReason(libraries.error) : null;
  const catalogLibraryFailure = libraries.status === "failed" ? catalogLine(libraries.error) : null;
  const queryControls = {
    kind: "Controls" as const,
    focusInput,
    content: <PaneQueryToolbar
      inputRef={inputRef}
      input={{ label: `Filter followed ${noun}`, placeholder: `Filter ${noun}`, value: filterRows.query, appliedValue: filterRows.query, onChange: filterRows.onQueryChange, onClear: filterRows.clearQuery }}
      options={{
        label: "Filters", activeCount: chips.length, onExpandedChange: setLibrariesOpen,
        onClear: () => replaceView({ filter: null, library_id: null }),
        content: <>
          <RadioGroup label="Show" value={filter} choices={showChoices} onChange={(value) => replaceView({ filter: value === "all" ? null : value })} />
          <RadioGroup label="Library" value={libraryId ?? ""} choices={libraryChoices} disabled={libraries.status === "loading"} onChange={(value) => replaceView({ library_id: value || null })} />
          {libraries.status === "failed" ? catalogLibraryFailure !== null ? <Fact line={catalogLibraryFailure} speak={speak} />
            : libraryFailureReason !== null
            ? <Fact line={{ fact: "couldn’t load libraries.", reason: libraryFailureReason }} />
            : <Failed error={libraries.error} noun="libraries" retry={{ run: retryLibraries, busy: indexReading(libraries) }} /> : null}
        </>,
      }}
      sort={{ label: "Sort", value: sort, choices: sortChoices, onChange: (value) => replaceView({ sort: value === "recent_entry" ? null : value }) }}
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
    primaryAction: browse,
    menuActions: [browse],
    query: queryControls,
    refresh: list.status === "ready" && list.source.kind === "catalog" ? undefined : {
      kind: "Refreshable",
      sourceKey: `Podcasts.Subscriptions:${key}`,
      execute: feedRefresh({ kind: "Feeds" }, kind),
    },
  });
  usePaneReturnReady(list.status !== "loading");

  if (list.status === "failed" && failure !== null) {
    return (
      <>
        {readFeedback.announcement}
        {failure.code === "E_INVALID_REQUEST"
          ? <Fact line={{ fact: `couldn’t load ${noun} for this view.` }}
            verbs={[{ label: "reset view", commandKey: "reset podcasts view", run: () => router.replace(href) }]} />
          : catalogFailure !== null ? <Fact line={catalogFailure} speak={speak} />
          : <Failed error={failure} noun={noun} retry={{ run: retry, busy }} />}
      </>
    );
  }

  return (
    <>
      {readFeedback.announcement}
      <CollectionView geometry="UniformIndex"
        returnScope="Podcasts.Subscriptions"
        rows={visible.map((row) =>
          presentFeed({
            kind, subtitle: null,
            id: row.id,
            title: row.title,
            imageUrl: row.image_url,
            contributors: row.contributors,
            recurring: null,
          }),
        )}
        status={list.status === "loading" ? "loading" : "ready"}
        ariaLabel={`Followed ${noun}`}
        anchorKey={text}
        empty={<Fact line={{ fact: emptyTitle }} verbs={text ? undefined
          : filtered ? [{ label: "clear filters", commandKey: "clear podcast filters", run: () => replaceView({ filter: null, library_id: null }) }]
          : [{ label: browse.label.toLowerCase(), href: browse.href }]} />}
      />
    </>
  );
}
