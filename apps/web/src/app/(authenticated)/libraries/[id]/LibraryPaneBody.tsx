"use client";

// One library: its entries under the url's view, drag order for those who manage
// a named library, the Reading Slate, the inspector's Members and Linked items,
// and Leave for a member who is not its owner. The url owns sort, type, view and
// completion and hands them to the server, which validates and combines them;
// the text filter stays local.

import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { Plus } from "lucide-react";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
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
import { PlaybackSourceContext, captureSavedView, capturePlaybackSource, type PlaybackSource } from "@/lib/actions/playbackSource";
import { useCatalogRead, useCatalogState, usePromoteLiveGroup } from "@/lib/catalog/provider";
import { unstamped } from "@/lib/consumption/listening";
import { catalogEntries } from "@/lib/catalog/selectors";
import { LIVE_SOURCE } from "@/lib/catalog/types";
import { remoteReady } from "@/lib/native/admission";
import { type LibraryPodcastIndex } from "@/lib/podcasts/api";
import { ApiError, isApiError } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { useServerValue, type Visit, type ServerValue } from "@/lib/api/serverState";
import { indexRowStatus, indexReading } from "@/lib/panes/indexRows";
import { indexPaneQuery } from "@/lib/panes/indexPaneQuery";
import { useLibraryEntriesRead } from "@/lib/panes/indexPaneEntry";
import {
  libraryDisplayName,
  libraryEntryId,
  presentLibraryEntry,
} from "@/lib/collections/presenters/library";
import { viewHref, type ViewChanges } from "@/lib/collections/view";
import { renderOrderNotice, orderStatus, presentOrder, projectOrder, useLibraryOrder } from "@/lib/collections/order";
import { useResourceInspector } from "@/components/resource-inspector/useResourceInspector";
import {
  libraryEntriesIndex,
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

const ENTRIES = definePaneVisitDataKey<Visit<Awaited<ReturnType<typeof libraryEntriesIndex>>>>("Library.Entries");
const UNIT = { singular: "entry", plural: "entries" };

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
  const query = indexPaneQuery("library", params)!;

  const catalog = useCatalogState();
  const { read: descriptor, group } = useLibraryEntriesRead();
  const savedRead = useCatalogRead(value => {
    const data = catalogEntries(value, id, new URLSearchParams(query));
    return data === null ? null : { data, consumption_revision: value.value.consumption_revision };
  });
  const raw = useServerValue({ ...descriptor, catalog: savedRead, visit: ENTRIES });
  const relevantMediaIds = useMemo(() => new Set(catalog.raw?.value.library_media.flatMap(row => row.library_id === id ? [row.media_id] : []) ?? []), [catalog.raw, id]);
  usePromoteLiveGroup(group, raw.status === "ready" && raw.source.kind === "live" && raw.error === null && raw.fresh
    ? [raw.data.consumption_revision] : null, relevantMediaIds);
  const saved = useMemo(() => {
    if (catalog.data === null) return null;
    try {
      const data = catalogEntries(catalog.data, id, new URLSearchParams(query));
      return data === null ? null : { data: { data, consumption_revision: catalog.data.value.consumption_revision },
        source: { kind: "catalog" as const, snapshot_id: catalog.data.value.snapshot_id, captured_at: catalog.data.value.captured_at } };
    } catch (error) { if (isApiError(error)) return null; throw error; }
  }, [catalog.data, id, query]);
  const snapshot: typeof raw = group.live || saved === null ? raw : {
    ...raw, status: "ready", data: saved.data, source: saved.source, fresh: false, acceptedStale: null, generation: 0,
    error: raw.status === "loading" ? null : raw.error, refreshing: indexReading(raw),
  };
  const list = unstamped(snapshot);
  const index = list.status === "ready" ? list.data : null;
  const indexItems = useMemo(() => index?.items ?? [], [index]);
  const failure = list.status === "loading" ? null : list.error;
  const busy = indexReading(list);
  const retry = () => { void list.refetch().catch(() => {}); };
  const detail: ServerValue<Library> = list.status === "ready" ? { ...list, data: list.data.library } : list;
  const shows: ServerValue<LibraryPodcastIndex> = list.status === "ready" ? { ...list, data: list.data.podcasts } : list;
  // Publication belongs to the aggregate owner, with one baseline per exact view.
  const publicationKey = `${ctx.accountId}:${descriptor.key}`;
  const publicationData = raw.status === "ready" && raw.source.kind === "live" && raw.error === null && raw.fresh ? raw.data.data : null;
  const publication = useMemo(() => publicationData === null ? null : JSON.stringify([
    publicationData.items.map(entry => [entry.entry_id, entry.media_summary.media_id]), publicationData.order_revision,
    publicationData.podcasts.order_revision,
    publicationData.podcasts.subscriptions.map(show => [show.podcast.id, show.recurring.last_checked_at, show.imports.map(operation => [operation.id, operation.updated_at]).sort((a, b) => a[0].localeCompare(b[0]))]),
    publicationData.podcasts.imports.map(operation => [operation.id, operation.updated_at]).sort((a, b) => a[0].localeCompare(b[0])),
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
  const source = list.status === "ready" ? list.source : LIVE_SOURCE;
  const live = source.kind === "live";
  const suggestionDestination = { kind: "Library" as const, id, name: library ? libraryDisplayName(library) : "library" };
  const suggestions = useSuggestions(suggestionDestination, active && library !== null && live);
  const { refresh: refreshSuggestionFeed } = suggestions;
  const order = useLibraryOrder(id, raw.status === "ready" && raw.source.kind === "live" && raw.fresh && raw.error === null ? raw.data.data.order_revision : null);
  const invalidView =
    failure?.code === "E_INVALID_REQUEST";
  usePaneReturnReady((list.status === "ready") || list.status === "failed" || missing);
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
        shown.filter((entry) => matchesPaneFilterQuery(text, fields(entry))).length,
        UNIT,
      ),
  });
  const text = filterRows.query.trim();
  const visible = useMemo(() => text === "" ? shown
    : shown.filter(entry => matchesPaneFilterQuery(text, fields(entry))), [shown, text]);

  const isAll = library?.is_default === true;
  const supportsOrder = live && remoteReady() && library?.can_manage === true && !isAll;
  const ordered = live && query === "" && text === "" && !isAll
    ? projectOrder(shown, (entry) => entry.entry_id!, order)
    : visible;
  const rows = useMemo(() => ordered.map(entry => ({ ...presentLibraryEntry(entry),
    id: entry.entry_id ?? libraryEntryId(entry) })), [ordered]);
  const ordering = supportsOrder ? presentOrder({ order, complete: (list.status === "ready"),
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
  const headerMeta: PaneHeaderMeta = (list.status === "ready")
    ? { kind: "Count", value: shown.length, unit: "entry" }
    : { kind: "Pending" };
  const clearFilters = { entry_type: null, projection: null, completion: null };
  // Recoveries and resets return focus to the permanent query input.
  const recover = (changes: ViewChanges) => {
    inputRef.current?.focus({ preventScroll: true });
    change(changes);
  };
  const { refetch: refetchEntries } = list;
  // Refresh asks the library's shows to sync, then rereads the library.
  const execute = useCallback<PaneRefreshExecute>(
    async (context) => {
      const [result, suggested] = await Promise.all([
        podcastRefresh({ kind: "Library", library_id: id })(context),
        refreshSuggestionFeed(context.signal),
      ]);
      let entriesFailed = false;
      try { await refetchEntries(); } catch { entriesFailed = true; }
      if (entriesFailed) return { kind: result.kind === "Complete" ? "Partial" : result.kind, announcement: `${result.announcement}. couldn’t refresh entries.` };
      switch (suggested) {
        case "Refreshed": case "Finding": case "NotApplicable": return result;
        case "Repair": case "Failed": return {
          kind: result.kind === "Complete" ? "Partial" : result.kind,
          announcement: `${result.announcement}. ${suggested === "Repair" ? "suggestions need repair." : "couldn’t refresh suggestions."}`,
        };
        default: return assertNever(suggested);
      }
    },
    [id, refetchEntries, refreshSuggestionFeed],
  );
  const addContent: PanePrimaryAction | undefined = live && remoteReady() && library?.can_add_content
    ? {
      kind: "command",
      id: "ViewAction.Library.AddContent",
      label: "add content",
      icon: <Plus size={20} aria-hidden="true" />,
      restoreFocusOnClose: false,
      onSelect: ({ triggerEl }) =>
        requestNexusOpen({
          kind: "Add",
          seed: { kind: "Content", initialDestinations: library.is_default ? [] : [{ id, name: library.name, order_revision: library.order_revision }] },
        }, triggerEl),
    }
    : undefined;
  const emptyFeedback = emptyEntriesFeedback({ params, isAll, change: recover });
  const emptyTitle = text
    ? "no entries match this filter." : emptyFeedback.content.title;
  const readFeedback = useIndexReadFeedback({
    value: list, requestedKey: descriptor.key, active, unit: UNIT,
    waiting: !invalidView && list.status === "loading",
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
            content: <PaneFilterRowsStatus announceQueryChanges={(list.status === "ready") && failure === null} id={queryStatusId} status={filterRows.rowStatus} query={filterRows.query} />,
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

  const name = library === null ? "" : libraryDisplayName(library);
  const captureReady = live && list.status === "ready" && list.fresh && list.error === null && !list.refreshing && order.state.pending === null;
  const capture = useCallback<PlaybackSource>(async selected_media_id => {
    const sourceSort = (["title_asc", "title_desc", "creator_asc", "creator_desc", "published_asc", "published_desc", "remaining_asc", "remaining_desc", "added_asc", "added_desc"] as const).find(value => value === sort) ?? null;
    const entry_type = (["web_article", "epub", "pdf", "video", "podcast_episode"] as const).find(value => value === type) ?? null;
    const sourceProjection = (["unfiled", "in_progress"] as const).find(value => value === projection) ?? null;
    const view = { library_id: id, sort: sourceSort, entry_type, projection: sourceProjection, completion: hideFinished ? "unfinished" as const : null };
    if (source.kind === "catalog")
      return captureSavedView(visible.map(entry => entry.media_summary), selected_media_id);
    if (!captureReady || !remoteReady()) throw new ApiError(409, "E_RESOURCE_CONFLICT", "load the current library before starting this queue");
    return capturePlaybackSource({ source: { kind: "Library", query: text, ...view }, selected_media_id });
  }, [sort, type, projection, hideFinished, id, source, visible, text, captureReady]);

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
          libraryErrorFeedback(failure, "couldn’t load entries", throwDefect) ?? {
            tone: "Danger",
            title: "couldn’t load entries",
          }
        }
        announcement="Polite"
        actions={[{ label: "try again", onClick: retry, busy: detail.status === "failed" && detail.retrying }]}
      /> : <PaneLoadingState label="loading entries…" announcement="Polite" />}
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

  const loadFailure =
    failure;
  const empty = <FeedbackNotice
    content={{ tone: "Neutral", title: emptyTitle }}
    announcement="None"
    actions={!text && (list.status === "ready") ? emptyFeedback.actions : undefined}
  />;
  const firstLoad =
    list.status === "failed" && loadFailure !== null
      ? libraryErrorFeedback(loadFailure, "Library entries couldn’t be loaded", throwDefect)
      : null;



  return (
    <>
      {readFeedback.announcement}
      <PaneSurface
        state={<>
          {ordering !== undefined ? renderOrderNotice({ order: order.state, active, paneId: runtime?.paneId ?? null }) : null}
          {readFeedback.notice}
          <MediaSummaryNotice error={summaries.error} retry={summaries.retry} busy={summaries.retrying}
            returnFocus={() => inputRef.current} />
        </>}
      >
        <LibraryPodcastsSection library={library} active={active} source={shows} />
        <PlaybackSourceContext.Provider value={capture}>
        <CollectionView
          returnScope="Library.Entries"
          rows={rows}
          empty={empty}
          status={list.status === "failed" ? "error" : list.status}
          error={
            firstLoad ? (
              <FeedbackNotice
                content={firstLoad}
                announcement="Polite"
                actions={[{ label: "try again", onClick: retry, busy }]}
              />
            ) : null
          }
          ariaLabel={name}
          rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: text }}
          rowActionsAvailable={(list.status === "ready")}
          collectionBusy={busy}
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
