"use client";

// One library: its entries under the url's view, drag order for those who manage
// a named library, the Reading Slate, the inspector's Members and Linked items,
// and Leave for a member who is not its owner. The server owns sort and view;
// type and text narrow the complete view locally.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as Icon from "@/lib/ui/icons";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import LibraryFeedsSection from "@/components/feeds/LibraryFeedsSection";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import CollectionView from "@/components/collections/CollectionView";
import SuggestionsSection from "@/components/collections/SuggestionsSection";
import { useSuggestions } from "@/lib/useSuggestions";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { Fact, Failed } from "@/components/feedback/Fact";
import { useActiveRegion } from "@/components/feedback/stage";
import { catalogLine } from "@/lib/catalog/copy";
import { Ruling } from "@/components/feedback/Ruling";
import LibraryMembers, { useLibraryMembers } from "@/components/libraries/LibraryMembers";
import PaneSurface from "@/components/ui/PaneSurface";
import { PlaybackSourceContext, captureSavedView, capturePlaybackSource, type PlaybackSource } from "@/lib/actions/playbackSource";
import { useCatalogRead, useCatalogState, usePromoteLiveGroup } from "@/lib/catalog/provider";
import { unstamped } from "@/lib/consumption/listening";
import { catalogEntries, catalogLibrary } from "@/lib/catalog/selectors";
import { LIVE_SOURCE, type ReadSource } from "@/lib/catalog/types";
import { remoteReady } from "@/lib/native/admission";
import { type LibraryFeedIndex } from "@/lib/feeds/api";
import { ApiError, isApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { useServerValue, type Visit, type ServerValue } from "@/lib/api/serverState";
import { useObservationDemand } from "@/lib/api/useObservationDemand";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { PASSIVE_OBSERVATION_MS, WORK_OBSERVATION_MS } from "@/lib/api/observationPolicy";
import { indexRowStatus, indexReading } from "@/lib/panes/indexRows";
import { indexPaneQuery } from "@/lib/panes/indexPaneQuery";
import { useLibraryEntriesRead } from "@/lib/panes/indexPaneEntry";
import {
  libraryDisplayName,
  libraryEntryId,
  presentLibraryEntry,
} from "@/lib/collections/presenters/library";
import { viewHref, type ViewChanges } from "@/lib/collections/view";
import { presentOrder, projectOrder, useLibraryOrder } from "@/lib/collections/order";
import { useResourceInspector } from "@/components/resource-inspector/useResourceInspector";
import {
  libraryEntriesIndex,
  type Library,
  type LibraryEntry,
} from "@/lib/libraries/api";
import {
  ENTRY_TYPES,
  emptyEntries,
  decodeLibraryView,
  libraryViewNeedsIdentity,
  projections,
} from "@/lib/libraries/views";
import { mediaListFilterFields } from "@/lib/media/mediaListFilter";
import { mediaKindGlyph } from "@/lib/media/kind";
import {
  useMediaSummaries,
} from "@/lib/media/MediaSummaryProvider";
import { requestNexusOpen } from "@/lib/nexus/events";
import { usePaneChrome, type PanePrimaryAction, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import { matchesPaneFilterQuery, usePaneFilterRows } from "@/lib/panes/paneFilterRows";
import {
  usePaneIsActive,
  usePaneIsPresented,
  usePaneParam,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import { feedRefresh } from "@/lib/feeds/paneState";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
} from "@/lib/workspace/paneReturnMemento";

const ENTRIES = definePaneVisitDataKey<Visit<Awaited<ReturnType<typeof libraryEntriesIndex>>>>("Library.Entries");
const IDENTITY = definePaneVisitDataKey<Visit<Library>>("Library.Identity");
const UNIT = { singular: "entry", plural: "entries" };

const fields = (entry: LibraryEntry) =>
  mediaListFilterFields(entry.media_summary);

export default function LibraryPaneBody() {
  const id = usePaneParam("id");
  if (!id) throw new Error("library route requires an id");
  return <LibraryView key={id} id={id} />;
}

function LibraryView({ id }: { readonly id: string }) {
  const params = usePaneSearchParams();
  const router = usePaneRouter();
  const view = decodeLibraryView(params);
  if (view === null) return <Fact line={{ fact: "this view doesn’t exist." }} speak verbs={[{ label: "reset view", commandKey: `library-view-reset:${id}`, run: () => router.replace(`/libraries/${id}`) }]} />;
  return <LibraryPane id={id} view={view} />;
}

function LibraryPane({ id, view }: { readonly id: string; readonly view: NonNullable<ReturnType<typeof decodeLibraryView>> }) {
  const speak = useActiveRegion();
  const { ctx } = useActionRuntime();
  const runtime = usePaneRuntime();
  const active = usePaneIsActive();
  const observing = useObservationDemand(usePaneIsPresented());
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const query = indexPaneQuery("library", params)!;
  const { entry_type: type, sort, projection } = view;

  const catalog = useCatalogState();
  const { read: descriptor, identity: identityDescriptor, group } = useLibraryEntriesRead();
  // The accepted identity belongs to this mounted library; its kind does not change.
  const accepted = useRef<{ data: Library; source: ReadSource } | null>(null);
  const retained = accepted.current?.source.kind === "catalog" && accepted.current.source.snapshot_id !== catalog.data?.value.snapshot_id
    ? null : accepted.current;
  const needsIdentity = libraryViewNeedsIdentity(view);
  const savedIdentity = useCatalogRead(value => catalogLibrary(value, id));
  const identity = useServerValue({ ...identityDescriptor, catalog: savedIdentity, visit: IDENTITY,
    enabled: observing && needsIdentity && retained === null });
  const identityError = identity.status === "loading" ? null : identity.error;
  const identityMissing = identityError?.status === 404;
  const known = retained ?? (identity.status === "ready" && identityError === null &&
    (identity.source.kind === "live" || identity.source.snapshot_id === catalog.data?.value.snapshot_id)
    ? { data: identity.data, source: identity.source } : null);
  const invalidSelection = known !== null && (projection === "unfiled" && !known.data.is_default || sort === "added_desc" && known.data.is_default);
  const admitted = !needsIdentity || known !== null && !invalidSelection;
  const savedRead = useCatalogRead(value => {
    const data = catalogEntries(value, id, new URLSearchParams(query));
    return data === null ? null : { data, consumption_revision: value.value.consumption_revision };
  });
  const raw = useServerValue({ ...descriptor, catalog: savedRead, visit: ENTRIES, enabled: observing && admitted });
  const relevantMediaIds = useMemo(() => new Set(catalog.raw?.value.library_media.flatMap(row => row.library_id === id ? [row.media_id] : []) ?? []), [catalog.raw, id]);
  usePromoteLiveGroup(group, admitted && raw.status === "ready" && raw.source.kind === "live" && raw.error === null && raw.fresh
    ? [raw.data.consumption_revision] : null, relevantMediaIds);
  const saved = useMemo(() => {
    if (!admitted || catalog.data === null) return null;
    try {
      const data = catalogEntries(catalog.data, id, new URLSearchParams(query));
      return data === null ? null : { data: { data, consumption_revision: catalog.data.value.consumption_revision },
        source: { kind: "catalog" as const, snapshot_id: catalog.data.value.snapshot_id, captured_at: catalog.data.value.captured_at } };
    } catch (error) { if (isApiError(error)) return null; throw error; }
  }, [admitted, catalog.data, id, query]);
  const snapshot: typeof raw = group.live || saved === null ? raw : {
    ...raw, status: "ready", data: saved.data, source: saved.source, fresh: false, acceptedStale: null, generation: 0,
    error: raw.status === "loading" ? null : raw.error, refreshing: indexReading(raw),
  };
  const list = unstamped(snapshot);
  const index = list.status === "ready" ? list.data : null;
  const indexItems = useMemo(() => index?.items ?? [], [index]);
  const failure = list.status === "loading" ? null : list.error;
  const busy = indexReading(list);
  useLayoutEffect(() => {
    if (admitted && list.status === "ready" && list.error === null) accepted.current = { data: list.data.library, source: list.source };
    else if (retained === null && identity.status === "ready" && identity.error === null)
      accepted.current = { data: identity.data, source: identity.source };
  }, [admitted, identity, list, retained]);
  const detail: ServerValue<Library> = list.status === "ready" ? { ...list, data: list.data.library }
    : list.status === "loading" && known !== null ? { status: "ready", data: known.data, source: known.source,
      acceptedStale: null, fresh: false, generation: 0, error: null, refreshing: false, refetch: list.refetch, revalidate: list.revalidate }
    : list;
  const catalogFailure = detail.status === "loading" || detail.error === null ? null : catalogLine(detail.error);
  const shows: ServerValue<LibraryFeedIndex> = list.status === "ready" ? { ...list, data: list.data.feeds } : list;
  const sourceWork = index !== null && (index.feeds.imports.some(operation => operation.work_in_flight)
    || index.feeds.subscriptions.some(source => source.recurring.work_in_flight || source.recurring.history.work_in_flight
      || source.imports.some(operation => operation.work_in_flight)));
  // justify-polling: one aggregate owns both source cards and their incoming entries.
  useIntervalPoll({ enabled: admitted && observing && remoteReady() && list.status === "ready" && list.source.kind === "live",
    pollIntervalMs: sourceWork ? WORK_OBSERVATION_MS : PASSIVE_OBSERVATION_MS,
    onPoll: () => list.revalidate({ passive: true }) });
  // Publication belongs to the aggregate owner, with one baseline per exact view.
  const publicationKey = `${ctx.accountId}:${descriptor.key}`;
  const publicationData = admitted && raw.status === "ready" && raw.source.kind === "live" && raw.error === null && raw.fresh ? raw.data.data : null;
  const publication = useMemo(() => publicationData === null ? null : JSON.stringify([
    publicationData.items.map(entry => [entry.entry_id, entry.media_summary.media_id]), publicationData.order_revision,
    publicationData.feeds.order_revision,
    publicationData.feeds.subscriptions.map(show => [show.feed.id, show.recurring.last_checked_at, show.imports.map(operation => [operation.id, operation.updated_at]).sort((a, b) => a[0].localeCompare(b[0]))]),
    publicationData.feeds.imports.map(operation => [operation.id, operation.updated_at]).sort((a, b) => a[0].localeCompare(b[0])),
  ]), [publicationData]);
  const observed = useRef<{ key: string; signature: string } | null>(null);
  useEffect(() => {
    if (observed.current?.key !== publicationKey) observed.current = null;
    if (publication === null) return;
    const previous = observed.current;
    observed.current = { key: publicationKey, signature: publication };
    if (previous !== null && previous.key === publicationKey && previous.signature !== publication) publishChange("Entries");
  }, [publication, publicationKey]);
  const missing = detail.status !== "loading" && detail.error?.status === 404;
  const library = !missing && detail.status === "ready" ? detail.data : null;
  const source = list.status === "ready" ? list.source : detail.status === "ready" ? detail.source : LIVE_SOURCE;
  const live = source.kind === "live";
  const suggestionDestination = { kind: "Library" as const, id, name: library ? libraryDisplayName(library) : "library" };
  const suggestions = useSuggestions(suggestionDestination, admitted && library !== null && live);
  const { refresh: refreshSuggestionFeed } = suggestions;
  const order = useLibraryOrder(id, raw.status === "ready" && raw.source.kind === "live" && raw.fresh && raw.error === null ? raw.data.data.order_revision : null);
  usePaneReturnReady(invalidSelection || identityMissing || needsIdentity && known === null && identityError !== null || (list.status === "ready" || list.status === "failed" || missing) && detail.status !== "loading");
  const scroll = usePaneScrollRetention(indexItems);
  const change = useCallback(
    (changes: ViewChanges) => {
      scroll();
      router.replace(viewHref(`/libraries/${id}`, params, changes), {
      });
    },
    [id, params, router, scroll],
  );

  const seeds = useMemo(() => indexItems.map(entry => entry.media_summary), [indexItems]);
  const summaries = useMediaSummaries(seeds, source);
  // Preserve accepted row identities until a summary changes or is withdrawn.
  const shown = useMemo(() => {
    let unchanged = true;
    const next = indexItems.flatMap((entry): LibraryEntry[] => {
      const summary = summaries.resolve(entry.media_summary);
      if (summary === entry.media_summary) return [entry];
      unchanged = false;
      return summary === null ? [] : [{ ...entry, media_summary: summary }];
    });
    return unchanged ? indexItems : next;
  }, [indexItems, summaries]);
  const filterRows = usePaneFilterRows({
    sourceKey: `Library.Entries:${id}`,
    getRowStatus: (text) =>
      indexRowStatus(
        list,
        shown.length,
        shown.filter((entry) => (type === null || entry.media_summary.media_kind === type) && matchesPaneFilterQuery(text, fields(entry))).length,
        UNIT,
      ),
  });
  const text = filterRows.query.trim();
  const visible = useMemo(() => shown.filter(entry => (type === null || entry.media_summary.media_kind === type) && matchesPaneFilterQuery(text, fields(entry))), [shown, text, type]);

  const isAll = library?.is_default === true;
  const supportsOrder = live && remoteReady() && library?.can_manage === true && !isAll;
  const ordered = live && query === "" && type === null && text === "" && !isAll
    ? projectOrder(shown, (entry) => entry.entry_id!, order)
    : visible;
  const rows = useMemo(() => ordered.map(entry => ({ ...presentLibraryEntry(entry),
    id: entry.entry_id ?? libraryEntryId(entry) })), [ordered]);
  const ordering = supportsOrder ? presentOrder({ order, complete: (list.status === "ready"),
    view: sort ? "Sorted" : query || type || text ? "Filtered" : "Custom",
    titleOf: itemId => shown.find(entry => entry.entry_id === itemId)?.media_summary.title ?? "" }) : undefined;

  const members = useLibraryMembers(
    admitted && live ? library : null,
    runtime?.secondaryPane?.group_id === "resource-inspector" &&
      runtime.secondaryPane.visibility === "visible" &&
      runtime.secondaryPane.active_surface_id === "resource-members",
    detail.refetch,
  );
  useResourceInspector({
    scheme: "library",
    handle: admitted && library && detail.status === "ready" && detail.error?.status !== 403 ? id : null,
    bodies: {
      members: members.shown ? <LibraryMembers state={members.shown} /> : undefined,
      linkedItems: useMemo(
        () => <ConnectionsSurface resourceRef={{ scheme: "library", id }} />,
        [id],
      ),
    },
  });

  const views = projections(isAll);
  const headerMeta: PaneHeaderMeta = !admitted ? { kind: "None" } : (list.status === "ready")
    ? { kind: "Count", value: visible.length, of: shown.length, unit: "entry" }
    : { kind: "Pending" };
  const { refetch: refetchEntries } = list;
  // Refresh asks the library's shows to sync, then rereads the library; only the shows' sync
  // speaks. A reread or suggestions refresh that fails over shown rows says nothing.
  const execute = useCallback<PaneRefreshExecute>(
    async (context) => {
      const [result] = await Promise.all([
        feedRefresh({ kind: "Library", library_id: id })(context),
        refreshSuggestionFeed(context.signal),
      ]);
      await refetchEntries().catch(() => {});
      return result;
    },
    [id, refetchEntries, refreshSuggestionFeed],
  );
  const importHere: PanePrimaryAction | undefined = live && remoteReady() && library?.can_add_content
    ? {
      kind: "command",
      id: "ViewAction.Library.Import",
      label: "Import here",
      icon: <Icon.Upload aria-hidden="true" />,
      restoreFocusOnClose: false,
      onSelect: ({ triggerEl }) =>
        requestNexusOpen({ kind: "Import", into: library.is_default ? [] : [{ id, name: library.name }] }, triggerEl),
    }
    : undefined;
  const emptyState = emptyEntries({ view, isAll, change });
  const emptyLine = text ? { fact: "no entries match this filter." } : emptyState.line;
  const readFeedback = useIndexReadFeedback({ value: list, requestedKey: descriptor.key, active: active && admitted, waiting: admitted && list.status === "loading", outcome: ordered.length > 0 ? null : emptyLine.fact });
  const menuActions: ActionDescriptor[] = importHere ? [importHere] : [];
  usePaneChrome({
    displayTitle: library === null ? undefined : libraryDisplayName(library),
    primaryAction: admitted ? importHere : undefined,
    views: !admitted || library === null ? undefined : {
      label: "library view", value: projection ?? "", items: views,
      onSelect: value => change({ projection: value || null }),
    },
    query: !admitted || library === null ? undefined : { kind: "Collation", collation: {
      words: { label: "filter entries", value: filterRows.query, applied: filterRows.query,
        onChange: filterRows.onQueryChange, onClear: filterRows.clearQuery, standing: false, onSubmit: null,
        rows: { status: filterRows.rowStatus, announce: list.status === "ready" && failure === null }, notice: null, verbs: [] },
      dimensions: [{ kind: "One", id: "entry_type", label: "type", rest: "all types", restCount: list.status === "ready" ? shown.filter(entry => matchesPaneFilterQuery(text, fields(entry))).length : undefined, value: type,
        options: ENTRY_TYPES.map(option => ({ ...option,
          sign: mediaKindGlyph(option.value),
          count: list.status === "ready" ? shown.filter(entry => entry.media_summary.media_kind === option.value && matchesPaneFilterQuery(text, fields(entry))).length : null,
          reason: null })),
        onChange: value => change({ entry_type: value }),
      }],
      order: { value: sort, rest: isAll ? "recently added" : "custom order", keys: [
        { label: "title", ways: [{ value: "title_asc", label: "a–z", word: "title a–z" }, { value: "title_desc", label: "z–a", word: "title z–a" }] },
        { label: "creator", ways: [{ value: "creator_asc", label: "a–z", word: "creator a–z" }, { value: "creator_desc", label: "z–a", word: "creator z–a" }] },
        { label: "first published", ways: [{ value: "published_desc", label: "newest", word: "newest published" }, { value: "published_asc", label: "oldest", word: "oldest published" }] },
        { label: "time left", ways: [{ value: "remaining_asc", label: "least", word: "least time left" }, { value: "remaining_desc", label: "most", word: "most time left" }] },
        { label: "added", ways: isAll ? [{ value: "added_asc", label: null, word: "oldest added" }] : [{ value: "added_desc", label: "newest", word: "newest added" }, { value: "added_asc", label: "oldest", word: "oldest added" }] },
      ], onChange: value => change({ sort: value }), note: !supportsOrder ? null : sort ? "only custom order can be dragged." : projection ? "show all items to drag." : type ? "reset to drag." : text ? "clear text to drag." : null },
      reset: sort !== null || type !== null ? () => { filterRows.clearQuery(); change({ sort: null, entry_type: null }); } : null,
    } },
    refresh: admitted && live && remoteReady() && library
      ? { kind: "Refreshable", sourceKey: `Library:${id}?${query}`, execute }
      : undefined,
    resourceRef: admitted ? canonicalResourceRef({ scheme: "library", id }) : undefined,
    menuActions: admitted ? menuActions : [],
    header: { kind: "Section", meta: headerMeta },
  });

  const name = library === null ? "" : libraryDisplayName(library);
  const captureReady = live && list.status === "ready" && list.fresh && list.error === null && !list.refreshing && order.state.pending === null;
  const capture = useCallback<PlaybackSource>(async selected_media_id => {
    if (source.kind === "catalog")
      return captureSavedView(visible.map(entry => entry.media_summary), selected_media_id);
    if (!captureReady || !remoteReady()) throw new ApiError(409, "E_RESOURCE_CONFLICT", "load the current library before starting this queue");
    return capturePlaybackSource({ source: { kind: "Library", query: text, library_id: id, sort: view.sort, entry_type: view.entry_type, projection: view.projection }, selected_media_id });
  }, [view, id, source, visible, text, captureReady]);

  if (needsIdentity && known === null) {
    if (identityMissing) return <Fact line={{ fact: "this library isn’t available.", reason: "it was deleted, or you’re not a member." }} speak />;
    if (identityError !== null) {
      const line = catalogLine(identityError);
      return line !== null ? <Fact line={line} speak={speak} /> : <Failed error={identityError} noun="library" retry={{ run: () => { void identity.refetch().catch(() => {}); }, busy: identity.status === "failed" ? identity.retrying : identity.status === "ready" && identity.refreshing }} />;
    }
    return <Ruling />;
  }
  if (invalidSelection) return <Fact line={{ fact: "this view doesn’t exist." }} speak verbs={[{ label: "reset view", commandKey: `library-view-reset:${id}`, run: () => router.replace(`/libraries/${id}`) }]} />;
  if (missing) {
    return <>
      {readFeedback.announcement}
      {members.held}
      <Fact line={{ fact: "this library isn’t available.", reason: "it was deleted, or you’re not a member." }} speak />
    </>;
  }
  const libraryFailure = detail.status !== "loading" && detail.error !== null
    ? catalogFailure !== null ? <Fact line={catalogFailure} speak={speak} /> : <Failed error={detail.error} noun="library"
      retry={{ run: () => { void detail.refetch().catch(() => {}); }, busy: detail.status === "failed" ? detail.retrying : detail.refreshing }} />
    : null;
  if (library === null) {
    return <>
      {readFeedback.announcement}
      {members.held}
      {libraryFailure ?? <Ruling />}
    </>;
  }

  const empty = <Fact line={emptyLine} verbs={!text && list.status === "ready" ? emptyState.verbs : undefined} />;
  return (
    <>
      {readFeedback.announcement}
      <PaneSurface>
        {members.held}
        <LibraryFeedsSection library={library} source={shows} kind="podcast" />
        <LibraryFeedsSection library={library} source={shows} kind="article" />
        <PlaybackSourceContext.Provider value={capture}>
        <CollectionView geometry="UniformIndex"
          returnScope="Library.Entries"
          rows={rows}
          empty={empty}
          status={list.status === "failed" ? "error" : list.status}
          ariaLabel={name}
          anchorKey={`${type ?? ""}:${text}`}
          collectionBusy={busy}
          surface={false}
          order={ordering}
        />
        </PlaybackSourceContext.Provider>
        {live ? <SuggestionsSection
            destination={suggestionDestination}
            suggestions={suggestions}
            returnScope="Library.Suggestions"
            subscribe={target => ctx.overlays.open({ kind: "SubscribeFeed", target: { kind: "Canonical", feed_id: target.feed_id },
              title: target.title, feedKind: target.feed_kind, libraryId: library.is_default ? null : id, onAccepted: () => suggestions.acknowledge(target.ref) })}
          /> : null}
      </PaneSurface>
    </>
  );
}
