"use client";

import { useResourceComposer } from "@/components/resources/ResourceDisclosure";

// One library: its entries under the url's view, drag order for those who manage
// a named library, the Reading Slate, the inspector's Members and Linked items,
// and Leave for a member who is not its owner. The url owns sort, type, view and
// completion and hands them to the server, which validates and combines them;
// the text filter stays local.

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import LecternAddControl from "@/components/collections/LecternAddControl";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import SuggestionsSection from "@/components/collections/SuggestionsSection";
import { suggestionTargetId } from "@/lib/suggestions";
import { useSuggestions } from "@/lib/useSuggestions";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import LibraryMembers, { useLibraryMembers } from "@/components/libraries/LibraryMembers";
import ChoiceField from "@/components/ui/ChoiceField";
import PaneSurface from "@/components/ui/PaneSurface";
import RadioGroup from "@/components/ui/RadioGroup";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { useChangeStamp } from "@/lib/api/changes";
import { useServerValue, useThrowLater, type Visit } from "@/lib/api/serverState";
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
import { OrderNotice, orderStatus, presentOrder, useCollectionOrderOwner, useOrder } from "@/lib/collections/CollectionOrderProvider";
import { projectOrder, sameMembers, type Collection } from "@/lib/collections/order";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import {
  entriesPage,
  getLibrary,
  leaveLibrary,
  type Library,
  type LibraryEntry,
} from "@/lib/libraries/api";
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
import { useLibraryPlacementController } from "@/lib/libraries/placementController";
import {
  ENTRY_TYPES,
  EmptyEntries,
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
import { matchesPaneFilterQuery, paneFilterRowsStatusVisible, usePaneFilterRows } from "@/lib/panes/paneFilterRows";
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
import { findPaneCollectionRowFocusTarget } from "@/lib/workspace/paneDom";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneScrollRetention,
} from "@/lib/workspace/paneReturnMemento";
import { useLatestWorkspace } from "@/lib/workspace/store";

const DETAIL = definePaneVisitDataKey<Visit<Library>>("Library.Detail");
const ENTRIES = definePaneVisitDataKey<ListSnapshot<LibraryEntry>>("Library.Entries");
const UNIT = { singular: "entry", plural: "entries" };
const VIEW_KEYS = ["sort", "entry_type", "projection", "completion"];

const fields = (entry: LibraryEntry) =>
  mediaListFilterFields(entry.kind === "media" ? entry.media_summary : entry);

export default function LibraryPaneBody() {
  const id = usePaneParam("id");
  if (!id) throw new Error("library route requires an id");
  return <LibraryPane key={id} id={id} />;
}

function LibraryPane({ id }: { readonly id: string }) {
  const { addToLibrary } = useLibraryPlacementController();
  const runtime = usePaneRuntime();
  const active = usePaneIsActive();
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const collection = useMemo<Collection>(() => ({ kind: "Library", id }), [id]);
  const order = useOrder(collection);
  const orderOwner = useCollectionOrderOwner();
  const fail = useThrowLater();
  const query = new URLSearchParams(
    VIEW_KEYS.flatMap((key) => {
      const value = params.get(key);
      return value === null ? [] : [[key, value]];
    }),
  ).toString();

  const detail = useServerValue({
    key: `/libraries/${id}`,
    stale: useChangeStamp("Libraries"),
    visit: DETAIL,
    load: (signal) => getLibrary(id, signal),
  });
  // A 404 on the first read or a reread: the library is gone for the viewer.
  const missing = detail.status !== "loading" && detail.error?.status === 404;
  const library = !missing && detail.status === "ready" ? detail.data : null;
  const suggestionDestination = { kind: "Library" as const, id, name: library ? libraryDisplayName(library) : "library" };
  const suggestions = useSuggestions(suggestionDestination, active && library !== null);
  const { refresh: refreshSuggestionFeed } = suggestions;
  const consumption = useChangeStamp("Consumption");
  // Views whose rows or order move with reading and listening reread with it.
  const followsConsumption =
    params.has("projection") ||
    params.has("completion") ||
    (params.get("sort") ?? "").startsWith("remaining");
  const list = useServerList<LibraryEntry>({
    key: `/libraries/${id}/entries?${query}`,
    stale: [
      useChangeStamp("Entries"),
      followsConsumption ? consumption : "-",
      useMediaQueryRevision(),
      useRefreshStamp(active, 60_000),
    ].join("|"),
    pageSize: 100,
    drain: true,
    active,
    visit: ENTRIES,
    id: libraryEntryId,
    fetchPage: (cursor, limit, signal) =>
      entriesPage(id, pageQuery(query, cursor, limit), signal),
  });
  useEffect(() => {
    if (query === "" && list.complete && list.orderRevision !== null) {
      orderOwner.observe(collection, { revision: list.orderRevision,
        ids: list.items.map((entry) => {
          if (entry.entry_id === null) throw new Error("manual library entry requires an occurrence id");
          return entry.entry_id;
        }) });
    }
  }, [collection, list.complete, list.items, list.orderRevision, orderOwner, query]);
  const invalidView =
    list.failure?.op === "Load" && list.failure.error.code === "E_INVALID_REQUEST";
  usePaneReturnReady(list.current || list.status === "failed" || missing);
  const scroll = usePaneScrollRetention(list.items);
  const change = useCallback(
    (changes: ViewChanges) => {
      scroll();
      router.replace(viewHref(`/libraries/${id}`, params, changes), {
        viewTransition: { kind: "collection-reflow" },
      });
    },
    [id, params, router, scroll],
  );

  const summaries = useMediaSummaries(
    list.items.flatMap((entry) => (entry.kind === "media" ? [entry.media_summary] : [])),
  );
  // Live summaries; a row whose summary is gone leaves the list.
  const shown = list.items.flatMap((entry): LibraryEntry[] => {
    if (entry.kind !== "media") return [entry];
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

  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const isAll = library?.is_default === true;
  const supportsOrder = library?.can_manage === true && !isAll;
  const coverage = order.snapshot !== null && sameMembers(
    shown.flatMap((entry) => entry.entry_id === null ? [] : [entry.entry_id]), order.snapshot.ids);
  const ordered = query === "" && text === "" && !isAll
    ? projectOrder(shown, (entry) => entry.entry_id!, order.snapshot, order.pending)
    : visible;
  const ordering = supportsOrder ? presentOrder({ key: `library:${id}`, order,
    view: params.get("sort") ? "Sorted" : query || text ? "Filtered" : "Custom",
    complete: list.complete, coverage }) : undefined;
  const orderingStatus = orderStatus(ordering);
  const coverageKey = shown.map((entry) => entry.entry_id).join(",");
  const snapshotKey = order.snapshot?.ids.join(",") ?? null;
  const { complete: orderComplete, refetch: refreshOrderMetadata } = list;
  useEffect(() => {
    if (!supportsOrder || query !== "" || !orderComplete || coverage || snapshotKey === null) return;
    void orderOwner.refresh(collection).catch(() => {});
    void refreshOrderMetadata().catch(() => {});
  }, [collection, coverage, coverageKey, orderComplete, refreshOrderMetadata, orderOwner, query, snapshotKey, supportsOrder]);

  const members = useLibraryMembers(
    library,
    active &&
      runtime?.secondaryPane?.group_id === "resource-inspector" &&
      runtime.secondaryPane.visibility === "visible" &&
      runtime.secondaryPane.active_surface_id === "resource-members",
    detail.refetch,
  );
  useResourceInspector({
    scheme: "library",
    handle: library ? id : null,
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
  const canReset = sort.length > 0 || type.length > 0 || projection.length > 0 || hideFinished || filterRows.query.length > 0;
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
      const [result, requested] = await Promise.all([
        podcastRefresh({ kind: "Library", library_id: id })(context),
        refreshSuggestionFeed(context.signal),
      ]);
      refetchDetail();
      await refetchEntries().catch(() => {});
      return requested ? result : {
        kind: result.kind === "Complete" ? "Partial" : result.kind,
        announcement: `${result.announcement}. couldn’t request suggestions.`,
      };
    },
    [id, refetchDetail, refetchEntries, refreshSuggestionFeed],
  );
  // Leaving asks first in the pane; the left library's panes settle like a deleted one's.
  const workspace = useLatestWorkspace();
  const [leaving, setLeaving] = useState<"Asked" | "Running" | null>(null);
  const leave = async () => {
    if (leaving !== "Asked") return;
    setLeaving("Running");
    try {
      await leaveLibrary(id);
      settleDeletedResourcePanes({
        workspace: workspace(),
        deletedRef: `library:${id}`,
        fallbackHref: "/libraries",
      });
    } catch (error) {
      setFeedback(libraryErrorFeedback(error, "You didn’t leave the library", fail));
    }
    setLeaving(null);
  };
  const addContent: PanePrimaryAction | undefined = library?.can_manage
    ? {
      kind: "command",
      id: "ViewAction.Library.AddContent",
      label: "add content",
      restoreFocusOnClose: false,
      onSelect: () =>
        requestNexusOpen({
          kind: "Add",
          seed: { kind: "Content", initialDestinations: [{ id, name: library.name }] },
        }),
    }
    : undefined;
  const insertion = useResourceComposer(library ? {kind:"resource",ref:`library:${id}`} : null, `library:${id}`, "add item");
  const menuActions: ActionDescriptor[] = [...(insertion.action ? [insertion.action] : []), ...(addContent ? [addContent] : [])];
  if (library?.can_leave) {
    menuActions.push({
      kind: "command",
      id: "ViewAction.Library.Leave",
      label: "Leave library…",
      tone: "danger",
      restoreFocusOnClose: false,
      onSelect: () => setLeaving("Asked"),
    });
  }
  usePaneChrome({
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
            placement: "Details",
            id: queryStatusId,
            visible: orderingStatus !== null || paneFilterRowsStatusVisible({
              status: filterRows.rowStatus,
              identityCount: headerMeta.kind === "Count" ? headerMeta.value : null,
              atDefaultView: !canReset,
            }),
            content: <><PaneFilterRowsStatus id={queryStatusId} status={filterRows.rowStatus} query={filterRows.query} />{orderingStatus ? <span>{orderingStatus}</span> : null}</>,
          }}
          onReset={canReset ? () => {
            filterRows.clearQuery();
            change({ sort: null, ...clearFilters });
          } : undefined}
        />
      ),
    },
    refresh: library
      ? { kind: "Refreshable", sourceKey: `Library:${id}?${query}`, execute }
      : undefined,
    resourceRef: canonicalResourceRef({ scheme: "library", id }),
    menuActions,
    header: { kind: "Section", meta: headerMeta },
  });

  if (missing) {
    return (
      <FeedbackNotice
        content={{
          tone: "Danger",
          title: "Library not found",
          message: "It was deleted, or you are no longer a member.",
        }}
        announcement="Assertive"
      />
    );
  }
  if (library === null) {
    const failure = detail.status === "failed" ? detail.error : null;
    return failure ? (
      <FeedbackNotice
        content={
          libraryErrorFeedback(failure, "Library couldn’t be loaded", throwDefect) ?? {
            tone: "Danger",
            title: "Library couldn’t be loaded",
          }
        }
        announcement="Assertive"
        actions={[{ label: "Retry", onClick: detail.refetch, busy: detail.status === "failed" && detail.retrying }]}
      />
    ) : (
      <PaneLoadingState label="Loading library…" announcement="Polite" />
    );
  }
  if (invalidView) {
    return (
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
    );
  }

  const name = libraryDisplayName(library);
  const added = (params.get("sort") ?? "").startsWith("added")
    ? isAll
      ? "Added to Nexus"
      : "Added"
    : null;
  const loadFailure =
    list.failure !== null && list.failure.op !== "More" ? list.failure.error : null;
  const empty = text ? (
    <FeedbackNotice
      content={{
        tone: "Neutral",
        title: list.complete
          ? "No entries match this filter."
          : "No matching entry found so far.",
      }}
      announcement="Polite"
    />
  ) : list.status !== "ready" ? null : list.complete ? (
    <EmptyEntries params={params} isAll={isAll} change={recover} />
  ) : (
    <CollectionExhaustionNotice list={list} />
  );
  const firstLoad =
    list.status === "failed" && loadFailure !== null
      ? libraryErrorFeedback(loadFailure, "Library entries couldn’t be loaded", throwDefect)
      : null;

  return (
    <> {insertion.content}<PaneSurface
      state={
        feedback || leaving || loadFailure || summaries.error || ordering !== undefined ? (
          <>
            {ordering !== undefined ? <OrderNotice order={order} active={active} paneId={runtime?.paneId ?? null} /> : null}
            {leaving ? (
              <FeedbackNotice
                content={{
                  tone: "Warning",
                  title: `Leave “${name}”?`,
                  message: "You lose access to what only it files. An admin can invite you again.",
                }}
                announcement="Assertive"
                actions={[
                  { label: "Leave library", onClick: () => void leave() },
                  { label: "Cancel", onClick: () => setLeaving(null) },
                ]}
              />
            ) : null}
            {feedback ? <FeedbackNotice content={feedback} announcement="Assertive" /> : null}
            {list.status === "ready" ? (
              <MediaSummaryNotice
                error={loadFailure ?? summaries.error}
                busy={summaries.retrying || list.running !== null}
                retry={() => {
                  if (summaries.error !== null) summaries.retry();
                  if (loadFailure !== null) list.retry();
                }}
              />
            ) : null}
          </>
        ) : null
      }
    >
      <CollectionView
        returnScope="Library.Entries"
        rows={ordered.map((entry) => ({ ...presentLibraryEntry(entry, added),
          id: entry.entry_id ?? libraryEntryId(entry) }))}
        rowControls={Object.fromEntries(ordered.flatMap((entry) => {
          if (entry.kind !== "media" ||
            !["web_article", "epub", "pdf"].includes(entry.media_summary.media_kind)) return [];
          const rowId = entry.entry_id ?? libraryEntryId(entry);
          return [[rowId, (
            <LecternAddControl
              key={rowId}
              mediaId={entry.media_summary.media_id}
              title={entry.media_summary.title}
              returnFocus={() => findPaneCollectionRowFocusTarget(runtime?.paneId, rowId)}
            />
          )]];
        }))}
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
        footer={visible.length > 0 ? <CollectionExhaustionNotice list={list} /> : undefined}
        collectionBusy={!list.current || !list.complete}
        surface={false}
        order={ordering}
      />
      <SuggestionsSection
          destination={suggestionDestination}
          suggestions={suggestions}
          returnScope="Library.Suggestions"
          accept={async (target) => {
            const accepted = await addToLibrary({ kind: target.kind, id: suggestionTargetId(target) }, id);
            return accepted ? "Accepted" : "Retained";
          }}
        />
    </PaneSurface></>
  );
}
