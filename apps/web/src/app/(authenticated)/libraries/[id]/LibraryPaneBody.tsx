"use client";

// One library: its entries under the url's view, drag order for those who manage
// a named library, the Reading Slate, the inspector's Members and Linked items,
// and Leave for a member who is not its owner. The url owns sort, type, view and
// completion and hands them to the server, which validates and combines them;
// the text filter stays local.

import { useCallback, useId, useMemo, useRef } from "react";
import { Plus } from "lucide-react";
import useCollectionReadFeedback from "@/components/collections/useCollectionReadFeedback";
import LibraryPodcastsSection from "@/components/podcasts/LibraryPodcastsSection";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import CollectionView from "@/components/collections/CollectionView";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import SuggestionsSection from "@/components/collections/SuggestionsSection";
import { suggestionTargetId } from "@/lib/suggestions";
import { assertNever } from "@/lib/assertNever";
import { useSuggestions } from "@/lib/useSuggestions";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import LibraryMembers, { useLibraryMembers } from "@/components/libraries/LibraryMembers";
import ChoiceField from "@/components/ui/ChoiceField";
import PaneSurface from "@/components/ui/PaneSurface";
import RadioGroup from "@/components/ui/RadioGroup";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { PlaybackSourceContext, capturePlaybackSource, type PlaybackSource } from "@/lib/actions/playbackSource";
import { useCatalogRead, useCatalogState } from "@/lib/catalog/provider";
import { catalogLibrary, catalogEntries, catalogLibraryShows } from "@/lib/catalog/selectors";
import { remoteReady } from "@/lib/native/admission";
import { getLibraryPodcasts, type PodcastSection } from "@/lib/podcasts/api";
import { ApiError, isApiError } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { useServerValue, type Visit, type ServerValue } from "@/lib/api/serverState";
import {
  listRowStatus,
  pageQuery,
  useServerList,
  type ListSnapshot,
} from "@/lib/api/useServerList";
import {
  libraryDisplayName,
  libraryEntryId,
  presentLibraryEntry,
} from "@/lib/collections/presenters/library";
import { viewHref, type ViewChanges } from "@/lib/collections/view";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { renderOrderNotice, orderStatus, presentOrder, projectOrder, useLibraryOrder } from "@/lib/collections/order";
import { useResourceInspector } from "@/components/resource-inspector/useResourceInspector";
import {
  entriesPage,
  getLibrary,
  type Library,
  type LibraryEntry,
} from "@/lib/libraries/api";
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
import { useLibraryPlacementController } from "@/lib/libraries/placementController";
import {
  ENTRY_TYPES,
  emptyEntriesFeedback,
  entrySorts,
  offered,
  projections,
} from "@/lib/libraries/views";
import { mediaListFilterFields } from "@/lib/media/mediaListFilter";
import {
  useMediaQueryRevision,
  useMediaSummaries,
} from "@/lib/media/MediaSummaryProvider";
import { requestNexusOpen } from "@/lib/nexus/events";
import { usePaneChrome, type PanePrimaryAction, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import { matchesPaneFilterQuery, usePaneFilterRows } from "@/lib/panes/paneFilterRows";
import {
  usePaneIsActive,
  usePaneParam,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import { podcastRefresh } from "@/lib/podcasts/paneState";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
} from "@/lib/workspace/paneReturnMemento";

const DETAIL = definePaneVisitDataKey<Visit<Library>>("Library.Detail");
const SHOWS = definePaneVisitDataKey<Visit<PodcastSection>>("Library.Podcasts");
const ENTRIES = definePaneVisitDataKey<ListSnapshot<LibraryEntry>>("Library.Entries");
const UNIT = { singular: "entry", plural: "entries" };
const VIEW_KEYS = ["sort", "entry_type", "projection", "completion"];

const fields = (entry: LibraryEntry) =>
  mediaListFilterFields(entry.media_summary);

export default function LibraryPaneBody() {
  const id = usePaneParam("id");
  if (!id) throw new Error("library route requires an id");
  return <LibraryPane key={id} id={id} />;
}

function LibraryPane({ id }: { readonly id: string }) {
  const { addToLibrary } = useLibraryPlacementController();
  const { ctx } = useActionRuntime();
  const runtime = usePaneRuntime();
  const active = usePaneIsActive();
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const query = new URLSearchParams(
    VIEW_KEYS.flatMap((key) => {
      const value = params.get(key);
      return value === null ? [] : [[key, value]];
    }),
  ).toString();

  const catalog = useCatalogState();
  const savedDetail = useCatalogRead(value => catalogLibrary(value, id));
  const savedEntries = useCatalogRead(value => catalogEntries(value, id, new URLSearchParams(query)));
  const savedShows = useCatalogRead(value => catalogLibraryShows(value, id));
  const rawDetail = useServerValue({
    catalog: savedDetail,
    key: `/libraries/${id}`,
    stale: useChangeStamp("Libraries"),
    visit: DETAIL,
    load: (signal) => getLibrary(id, signal),
  });
  const consumption = useChangeStamp("Consumption");
  // Views whose rows or order move with reading and listening reread with it.
  const followsConsumption =
    params.has("projection") ||
    params.has("completion") ||
    (params.get("sort") ?? "").startsWith("remaining");
  const rawList = useServerList<LibraryEntry>({
    catalog: savedEntries,
    key: `/libraries/${id}/entries?${query}`,
    stale: [
      useChangeStamp("Entries"),
      followsConsumption ? consumption : "-",
      useMediaQueryRevision(),
      useRefreshStamp(active && remoteReady(), 60_000),
    ].join("|"),
    pageSize: 100,
    active: active && (rawDetail.status === "ready" || catalog.data?.libraries.has(id) === true),
    visit: ENTRIES,
    id: libraryEntryId,
    fetchPage: (cursor, limit, signal) =>
      entriesPage(id, pageQuery(query, cursor, limit), signal),
  });
  const showsStale = `${useChangeStamp("Podcasts", "Entries", "Libraries")}:${useRefreshStamp(active && remoteReady(), 60_000)}`;
  const rawShows = useServerValue({
    key: rawDetail.status === "ready" || catalog.data?.libraries.has(id) === true ? `library-podcasts:${ctx.accountId}:${id}` : null,
    stale: showsStale,
    visit: SHOWS, catalog: savedShows,
    load: signal => getLibraryPodcasts(id, signal),
  });
  const groupKey = `${id}?${query}`;
  const promoted = useRef({ key: groupKey, live: false });
  if (promoted.current.key !== groupKey) promoted.current = { key: groupKey, live: false };
  if (rawDetail.status === "ready" && rawDetail.source.kind === "live" && rawDetail.error === null &&
      rawList.source.kind === "live" && rawList.complete && rawList.failure === null &&
      rawShows.status === "ready" && rawShows.source.kind === "live" && rawShows.error === null) promoted.current.live = true;
  const saved = useMemo(() => {
    if (catalog.data === null) return null;
    try {
      const library = catalogLibrary(catalog.data, id);
      const entries = catalogEntries(catalog.data, id, new URLSearchParams(query));
      const shows = catalogLibraryShows(catalog.data, id);
      return library === null || entries === null || shows === null ? null : { library, entries, shows,
        source: { kind: "catalog" as const, snapshot_id: catalog.data.value.snapshot_id, captured_at: catalog.data.value.captured_at } };
    } catch (error) { if (isApiError(error)) return null; throw error; }
  }, [catalog.data, id, query]);
  const showingSaved = !promoted.current.live && saved !== null;
  const detail: ServerValue<Library> = !showingSaved ? rawDetail : {
    status: "ready", data: saved.library, source: saved.source, generation: 0,
    error: rawDetail.status === "loading" ? null : rawDetail.error,
    refreshing: rawDetail.status === "ready" && rawDetail.refreshing, refetch: rawDetail.refetch,
  };
  const list: typeof rawList = !showingSaved ? rawList : {
    ...rawList, source: saved.source, status: "ready", items: saved.entries.items,
    fresh: false, metadata: saved.entries.metadata ?? null,
    current: true, complete: true, orderRevision: saved.entries.order_revision ?? null,
  };
  const shows: ServerValue<PodcastSection> = !showingSaved ? rawShows : {
    status: "ready", data: saved.shows, source: saved.source, generation: 0,
    error: rawShows.status === "loading" ? null : rawShows.error,
    refreshing: rawShows.status === "ready" && rawShows.refreshing, refetch: rawShows.refetch,
  };
  const missing = detail.status !== "loading" && detail.error?.status === 404;
  const library = !missing && detail.status === "ready" ? detail.data : null;
  const live = list.source.kind === "live";
  const suggestionDestination = { kind: "Library" as const, id, name: library ? libraryDisplayName(library) : "library" };
  const suggestions = useSuggestions(suggestionDestination, active && library !== null && live);
  const { refresh: refreshSuggestionFeed } = suggestions;
  const order = useLibraryOrder(id, rawList.current && rawList.source.kind === "live" ? rawList.orderRevision : null);
  const invalidView =
    list.failure?.op === "Load" && list.failure.error.code === "E_INVALID_REQUEST";
  usePaneReturnReady(list.current || list.status === "failed" || missing);
  const scroll = usePaneScrollRetention(list.items);
  const change = useCallback(
    (changes: ViewChanges) => {
      scroll();
      router.replace(viewHref(`/libraries/${id}`, params, changes), {
      });
    },
    [id, params, router, scroll],
  );

  const summaries = useMediaSummaries(
    list.items.map(entry => entry.media_summary), list.source,
  );
  // Live summaries; a row whose summary is gone leaves the list.
  const shown = list.items.flatMap((entry): LibraryEntry[] => {
    const summary = summaries.resolve(entry.media_summary);
    return summary === null ? [] : [{ ...entry, media_summary: summary }];
  });
  const filterRows = usePaneFilterRows({
    sourceKey: `Library.Entries:${id}`,
    getRowStatus: (text) =>
      listRowStatus(
        list,
        shown.length,
        shown.filter((entry) => matchesPaneFilterQuery(text, fields(entry))).length,
        UNIT,
      ),
  });
  const text = filterRows.query.trim();
  const visible = shown.filter((entry) => matchesPaneFilterQuery(text, fields(entry)));

  const isAll = library?.is_default === true;
  const supportsOrder = live && remoteReady() && library?.can_manage === true && !isAll;
  const ordered = live && query === "" && text === "" && !isAll
    ? projectOrder(shown, (entry) => entry.entry_id!, order)
    : visible;
  const ordering = supportsOrder ? presentOrder({ order, complete: list.complete,
    view: params.get("sort") ? "Sorted" : query || text ? "Filtered" : "Custom" }) : undefined;
  const orderingStatus = orderStatus(ordering);

  const members = useLibraryMembers(
    live ? library : null,
    runtime?.secondaryPane?.group_id === "resource-inspector" &&
      runtime.secondaryPane.visibility === "visible" &&
      runtime.secondaryPane.active_surface_id === "resource-members",
    detail.refetch,
  );
  useResourceInspector({
    scheme: "library",
    handle: library && detail.status === "ready" && detail.error?.status !== 403 ? id : null,
    bodies: {
      members: members ? <LibraryMembers state={members} /> : undefined,
      linkedItems: useMemo(
        () => <ConnectionsSurface resourceRef={{ scheme: "library", id }} />,
        [id],
      ),
    },
  });

  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const sort = params.get("sort") ?? "";
  const type = params.get("entry_type") ?? "";
  const projection = params.get("projection") ?? "";
  const hideFinished = params.get("completion") === "unfinished";
  const types = offered(ENTRY_TYPES, type);
  const views = offered(projections(isAll), projection);
  const chips = [
    ...(type ? [{ id: "entry_type", label: `Type: ${types.find((option) => option.value === type)!.label}` }] : []),
    ...(projection ? [{ id: "projection", label: `View: ${views.find((option) => option.value === projection)!.label}` }] : []),
    ...(hideFinished ? [{ id: "completion", label: "Hide finished" }] : []),
  ];
  const canReset = sort.length > 0 || chips.length > 0;
  const headerMeta: PaneHeaderMeta = list.complete
    ? { kind: "Count", value: shown.length, unit: "entry" }
    : { kind: "Pending" };
  const clearFilters = { entry_type: null, projection: null, completion: null };
  // Recoveries and resets return focus to the permanent query input.
  const recover = (changes: ViewChanges) => {
    inputRef.current?.focus({ preventScroll: true });
    change(changes);
  };
  const { refetch: refetchDetail } = detail;
  const { refetch: refetchEntries } = list;
  // Refresh asks the library's shows to sync, then rereads the library.
  const execute = useCallback<PaneRefreshExecute>(
    async (context) => {
      const [result, suggested] = await Promise.all([
        podcastRefresh({ kind: "Library", library_id: id })(context),
        refreshSuggestionFeed(context.signal),
      ]);
      refetchDetail();
      await refetchEntries().catch(() => {});
      switch (suggested) {
        case "Refreshed": case "Finding": case "NotApplicable": return result;
        case "Repair": case "Failed": return {
          kind: result.kind === "Complete" ? "Partial" : result.kind,
          announcement: `${result.announcement}. ${suggested === "Repair" ? "suggestions need repair." : "couldn’t refresh suggestions."}`,
        };
        default: return assertNever(suggested);
      }
    },
    [id, refetchDetail, refetchEntries, refreshSuggestionFeed],
  );
  const addContent: PanePrimaryAction | undefined = live && remoteReady() && library?.can_add_content
    ? {
      kind: "command",
      id: "ViewAction.Library.AddContent",
      label: "add content",
      icon: <Plus size={20} aria-hidden="true" />,
      restoreFocusOnClose: false,
      onSelect: () =>
        requestNexusOpen({
          kind: "Add",
          seed: { kind: "Content", initialDestinations: library.is_default ? [] : [{ id, name: library.name, order_revision: library.order_revision }] },
        }),
    }
    : undefined;
  const emptyFeedback = emptyEntriesFeedback({ params, isAll, change: recover });
  const emptyTitle = text
    ? list.complete ? "no entries match this filter." : "no matching entry found so far."
    : list.complete ? emptyFeedback.content.title : "no entries loaded so far.";
  const readFeedback = useCollectionReadFeedback({
    list, unit: UNIT,
    waiting: library !== null && !invalidView && list.status === "loading",
    outcome: ordered.length > 0 ? "results updated." : emptyTitle,
    returnFocus: () => inputRef.current,
  });
  const menuActions: ActionDescriptor[] = addContent ? [addContent] : [];
  usePaneChrome({
    displayTitle: library === null ? undefined : libraryDisplayName(library),
    primaryAction: addContent,
    query: invalidView || library === null ? undefined : {
      kind: "Controls",
      label: "Filter library entries",
      focusInput,
      content: (
        <PaneQueryToolbar
          inputRef={inputRef}
          input={{ label: "Filter library entries", placeholder: "Filter entries", value: filterRows.query, appliedValue: filterRows.query, onChange: filterRows.onQueryChange, onClear: filterRows.clearQuery }}
          options={{
            label: "Filters",
            activeCount: chips.length,
            onClear: () => change(clearFilters),
            content: <>
              <RadioGroup label="Type" value={type} choices={types} onChange={(value) => change({ entry_type: value || null })} />
              <RadioGroup label="View" value={projection} choices={views} onChange={(value) => change({ projection: value || null })} />
              <ChoiceField label="Hide finished" checked={hideFinished} onChange={(checked) => change({ completion: checked ? "unfinished" : null })} />
            </>,
          }}
          sort={{ label: "Sort", value: sort, choices: offered(entrySorts(isAll), sort), onChange: (value) => change({ sort: value || null }) }}
          chips={{ items: chips, onRemove: (param) => change({ [param]: null }) }}
          status={{
            placement: "Inline",
            id: queryStatusId,
            visible: false,
            content: <PaneFilterRowsStatus announceQueryChanges={list.current && list.failure === null} id={queryStatusId} status={filterRows.rowStatus} query={filterRows.query} />,
          }}
          actions={orderingStatus ? <span>{orderingStatus}</span> : undefined}
          onReset={canReset ? () => {
            filterRows.clearQuery();
            change({ sort: null, ...clearFilters });
          } : undefined}
        />
      ),
    },
    refresh: live && remoteReady() && library
      ? { kind: "Refreshable", sourceKey: `Library:${id}?${query}`, execute }
      : undefined,
    resourceRef: canonicalResourceRef({ scheme: "library", id }),
    menuActions,
    header: { kind: "Section", meta: headerMeta },
  });

  if (missing) {
    return (
      <>
      {readFeedback.announcement}
      <FeedbackNotice
        content={{
          tone: "Danger",
          title: "Library not found",
          message: "It was deleted, or you are no longer a member.",
        }}
        announcement="Assertive"
      />
      </>
    );
  }
  if (library === null) {
    const failure = detail.status === "failed" ? detail.error : null;
    return <>
      {readFeedback.announcement}
      {failure ? <FeedbackNotice
        content={
          libraryErrorFeedback(failure, "Library couldn’t be loaded", throwDefect) ?? {
            tone: "Danger",
            title: "Library couldn’t be loaded",
          }
        }
        announcement="Assertive"
        actions={[{ label: "Retry", onClick: detail.refetch, busy: detail.status === "failed" && detail.retrying }]}
      /> : <PaneLoadingState label="Loading library…" announcement="Polite" />}
    </>;
  }
  if (invalidView) {
    return (
      <>
      {readFeedback.announcement}
      <FeedbackNotice
        content={{ tone: "Danger", title: "Invalid library view" }}
        announcement="Assertive"
        actions={[
          {
            label: "Reset view",
            onClick: () => {
              filterRows.clearQuery();
              router.replace(`/libraries/${id}`);
              requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
            },
          },
        ]}
      />
      </>
    );
  }

  const name = libraryDisplayName(library);
  const loadFailure =
    list.failure !== null && list.failure.op !== "More" ? list.failure.error : null;
  const empty = <FeedbackNotice
    content={{ tone: "Neutral", title: emptyTitle }}
    announcement="None"
    actions={!text && list.complete ? emptyFeedback.actions : undefined}
  />;
  const firstLoad =
    list.status === "failed" && loadFailure !== null
      ? libraryErrorFeedback(loadFailure, "Library entries couldn’t be loaded", throwDefect)
      : null;

  const capture: PlaybackSource = selected_media_id => {
    if (!live || !remoteReady() || !list.current || order.state.pending !== null) throw new ApiError(409, "E_RESOURCE_CONFLICT", "load the current library before starting this queue");
    const sourceSort = (["title_asc", "title_desc", "creator_asc", "creator_desc", "published_asc", "published_desc", "remaining_asc", "remaining_desc", "added_asc", "added_desc"] as const).find(value => value === sort) ?? null;
    const entry_type = (["web_article", "epub", "pdf", "video", "podcast_episode"] as const).find(value => value === type) ?? null;
    const sourceProjection = (["unfiled", "in_progress"] as const).find(value => value === projection) ?? null;
    return capturePlaybackSource({ source: { kind: "Library", library_id: id, query: text,
      sort: sourceSort, entry_type, projection: sourceProjection, completion: hideFinished ? "unfinished" : null }, selected_media_id });
  };

  return (
    <>
      {readFeedback.announcement}
      <PaneSurface
        state={<>
          {ordering !== undefined ? renderOrderNotice({ order: order.state, active, paneId: runtime?.paneId ?? null }) : null}
          {list.status === "ready" && (loadFailure !== null || summaries.error !== null) ? (
            <MediaSummaryNotice
              error={loadFailure ?? summaries.error}
              busy={summaries.retrying || list.running !== null}
              retry={() => {
                if (summaries.error !== null) summaries.retry();
                if (loadFailure !== null) list.retry();
              }}
            />
          ) : null}
        </>}
      >
        <LibraryPodcastsSection library={library} active={active} source={shows} sourceStale={showsStale} />
        <PlaybackSourceContext.Provider value={capture}>
        <CollectionView
          returnScope="Library.Entries"
          rows={ordered.map((entry) => ({ ...presentLibraryEntry(entry),
            id: entry.entry_id ?? libraryEntryId(entry) }))}
          empty={empty}
          status={list.status === "failed" ? "error" : list.status}
          error={
            firstLoad ? (
              <FeedbackNotice
                content={firstLoad}
                announcement="Assertive"
                actions={[{ label: "Retry", onClick: list.retry, busy: list.running !== null }]}
              />
            ) : null
          }
          ariaLabel={name}
          rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: text }}
          rowActionsAvailable={list.current}
          notice={text && list.current && !list.complete && list.failure === null && ordered.length > 0
            ? <p>filter applies to loaded items.</p> : null}
          footer={readFeedback.notice}
          collectionBusy={!list.current || !list.complete}
          surface={false}
          order={ordering}
        />
        </PlaybackSourceContext.Provider>
        {live ? <SuggestionsSection
            destination={suggestionDestination}
            suggestions={suggestions}
            returnScope="Library.Suggestions"
            accept={async (target) => {
              if (target.kind === "Podcast") {
                ctx.overlays.open({ kind: "SubscribePodcast", target: { kind: "Canonical", podcast_id: suggestionTargetId(target) }, title: target.title, libraryId: library.is_default ? null : id,
                  onAccepted: () => suggestions.acknowledge(target.ref) });
                return "Retained";
              }
              const accepted = await addToLibrary({ kind: "Media", id: suggestionTargetId(target) }, id);
              return accepted ? "Accepted" : "Retained";
            }}
          /> : null}
      </PaneSurface>
    </>
  );
}
