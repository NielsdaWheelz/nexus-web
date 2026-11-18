"use client";

// The subscribed sources. The url owns filter, sort and library scope and passes
// them to the server, which validates them; the text filter stays local.
// A selected scope owns its label read independently of the closed choices.

import { useCallback, useMemo, useRef, useState } from "react";
import * as Icon from "@/lib/ui/icons";
import CollectionView from "@/components/collections/CollectionView";
import CollectionRow from "@/components/collections/CollectionRow";
import { Fact, Failed } from "@/components/feedback/Fact";
import { useActiveRegion } from "@/components/feedback/stage";
import { catalogLine } from "@/lib/catalog/copy";
import { viewHref } from "@/lib/collections/view";
import { Ruling } from "@/components/feedback/Ruling";
import type { PaneCollation } from "@/lib/panes/collation";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { feedBrowseAction } from "@/lib/feeds/navigation";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import { presentFeed } from "@/lib/collections/presenters/feed";
import { libraryReason } from "@/lib/libraries/errors";
import { getLibrary, librariesIndex, type Library } from "@/lib/libraries/api";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { usePaneIsActive, usePaneRouter, usePaneRuntime, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { projectFeedLibraryRemovalAction } from "@/lib/actions/project";
import { remoteReady } from "@/lib/native/admission";
import { findPaneCollectionRowFocusTarget } from "@/lib/workspace/paneDom";
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
  usePaneVisitData,
} from "@/lib/workspace/paneReturnMemento";

const VISIT = definePaneVisitDataKey<Visit<Awaited<ReturnType<typeof listFeeds>>>>(
  "Podcasts.Subscriptions",
);
const LIBRARIES = definePaneVisitDataKey<Visit<Awaited<ReturnType<typeof librariesIndex>>>>("Podcasts.LibraryChoices");
const SELECTED_LIBRARY = definePaneVisitDataKey<Visit<Library>>("Podcasts.SelectedLibrary");
const DRAWING = definePaneVisitDataKey<"rows" | "wall">("Feeds.Drawing");
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
  const filters = [{ value: "all", label: kind === "podcast" ? "all shows" : "all feeds" }, { value: "has_new", label: kind === "podcast" ? "new episodes" : "new articles" }, { value: "not_in_library", label: "unfiled" }];
  const speak = useActiveRegion();
  const router = usePaneRouter();
  const active = usePaneIsActive();
  const paneId = usePaneRuntime()?.paneId;
  const { ctx, run } = useActionRuntime();
  const params = usePaneSearchParams();
  const capturedDrawing = useRef<"rows" | "wall" | null>(null);
  const savedDrawing = usePaneVisitData(DRAWING, () => capturedDrawing.current);
  const [drawing, setDrawing] = useState(savedDrawing ?? "rows");
  capturedDrawing.current = drawing;
  const [librariesSeen, setLibrariesSeen] = useState(false);
  const sort = params.get("sort") ?? "recent_entry";
  const orderKnown = ["recent_entry", "unfinished_count", "alpha"].includes(sort);
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
  // Relevance is the saved entries of the scope's unfiltered sources: every subscribed source,
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
  const library = libraryId === null ? null : libraryItems.find(item => item.id === libraryId)
    ?? (selectedLibrary.status === "ready" ? selectedLibrary.data : null);
  const blocked = list.status !== "ready" || list.source.kind !== "live" || !list.fresh || list.error !== null || list.refreshing || !remoteReady()
    ? "TemporarilyUnavailable" : null;
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
      router.replace(viewHref(href, params, changes)),
    [params, router, href],
  );
  const text = filterRows.query.trim();
  const visible = (rows ?? []).filter((row) => matchesPaneFilterQuery(text, fields(row)));
  const filtered = filter !== "all" || libraryId !== null;
  const emptyTitle = text
    ? `no ${noun} match this filter.` : filtered ? `no ${noun} match these filters.` : `no subscribed ${noun}.`;
  const readFeedback = useIndexReadFeedback({ value: list, requestedKey: descriptor.key, active, waiting: list.status === "loading", outcome: visible.length > 0 ? "results updated." : emptyTitle });
  const libraryChoices = libraryItems.map(library => ({ value: library.id, label: library.name, sign: null, count: null, reason: null }));
  if (libraryId !== null && !libraryChoices.some(choice => choice.value === libraryId)) {
    libraryChoices.push({ value: libraryId, label: selectedLibrary.status === "ready" ? selectedLibrary.data.name : "selected library", sign: null, count: null, reason: null });
  }
  const headerMeta: PaneHeaderMeta = complete
    ? { kind: "Count", value: visible.length, of: rows?.length ?? 0, unit: kind === "podcast" ? "show" : "feed" }
    : list.status === "loading" ? { kind: "Pending" } : { kind: "None" };
  const libraryFailureReason = libraries.status === "failed" ? libraryReason(libraries.error) : null;
  const catalogLibraryFailure = libraries.status === "failed" ? catalogLine(libraries.error) : null;
  const collation: PaneCollation = {
    words: {
      label: `filter ${noun}`, value: filterRows.query, applied: filterRows.query,
      onChange: filterRows.onQueryChange, onClear: filterRows.clearQuery,
      standing: false, onSubmit: null, notice: null, verbs: [],
      rows: { status: filterRows.rowStatus, announce: list.status === "ready" && failure === null },
    },
    dimensions: [{
      kind: "One", id: "library", label: "library", rest: "any library", value: libraryId,
      options: libraryChoices,
      onChange: value => replaceView({ library_id: value }),
      onOpenChange: open => { if (open) setLibrariesSeen(true); },
      aside: libraries.status === "loading" ? <Ruling /> : libraries.status === "failed"
        ? catalogLibraryFailure !== null ? <Fact line={catalogLibraryFailure} speak={speak} />
          : libraryFailureReason !== null ? <Fact line={{ fact: "couldn’t load libraries.", reason: libraryFailureReason }} />
          : <Failed error={libraries.error} noun="libraries" retry={{ run: retryLibraries, busy: indexReading(libraries) }} />
        : null,
    }],
    order: orderKnown ? {
      value: sort === "recent_entry" ? null : sort,
      rest: kind === "podcast" ? "newest episode" : "newest article",
      keys: [
        { label: kind === "podcast" ? "most unplayed" : "most unfinished", ways: [{ value: "unfinished_count", label: null, word: kind === "podcast" ? "most unplayed" : "most unfinished" }] },
        { label: "title", ways: [{ value: "alpha", label: null, word: "title a–z" }] },
      ],
      onChange: value => replaceView({ sort: value }), note: null,
    } : null,
    reset: orderKnown && sort !== "recent_entry" || libraryId !== null ? () => {
      filterRows.clearQuery();
      replaceView({ sort: null, library_id: null });
    } : null,
  };
  usePaneChrome({
    header: { kind: "Section", meta: headerMeta },
    primaryAction: browse,
    menuActions: [browse],
    drawing: {
      value: drawing,
      choices: [{ value: "rows", label: "rows", icon: <Icon.Rows aria-hidden="true" /> },
        { value: "wall", label: "wall", icon: <Icon.Wall aria-hidden="true" /> }],
      onChange: value => {
        if (value !== "rows" && value !== "wall") throw new Error("unknown source drawing");
        setDrawing(value);
      },
    },
    views: { label: kind === "podcast" ? "podcast view" : "feed view", value: filter, items: filters,
      onSelect: value => replaceView({ filter: value === "all" ? null : value }) },
    query: { kind: "Collation", collation },
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
      <CollectionView geometry={drawing === "rows" ? "UniformIndex" : null} layout={drawing === "rows" ? "Rows" : "Wall"}
        returnScope="Podcasts.Subscriptions"
        rows={visible.map((row) =>
          presentFeed({
            kind, subtitle: null,
            id: row.id,
            title: row.title,
            imageUrl: row.image_url,
            contributors: row.contributors,
          }),
        )}
        status={list.status === "loading" ? "loading" : "ready"}
        ariaLabel={`subscribed ${noun}`}
        anchorKey={text}
        renderRow={library !== null && !library.is_default ? props => <CollectionRow {...props}
          occurrenceActions={[projectFeedLibraryRemovalAction({
            feedId: props.row.id, feedKind: kind, title: props.row.title.text,
            libraryId: library.id, libraryName: library.name, canRemove: library.can_add_content, blocked,
            ctx, run, focus: {
              trigger: null,
              returnFocus: () => findPaneCollectionRowFocusTarget(paneId, props.row.id)
                ?.closest("[data-collection-row-id]")?.querySelector<HTMLElement>("[data-row-actions-control]") ?? null,
              afterRemoval: props.afterRemoval,
            },
          })]} /> : undefined}
        empty={<Fact line={{ fact: emptyTitle }} verbs={text ? undefined
          : filtered ? [{ label: "clear filters", commandKey: "clear podcast filters", run: () => replaceView({ filter: null, library_id: null }) }]
          : [{ label: browse.label.toLowerCase(), href: browse.href }]} />}
      />
    </>
  );
}
