"use client";

// One library: its entries under the url's view, drag order for those who manage
// a named library, the Reading Slate, the inspector's Members and Linked items,
// and Leave for a member who is not its owner. The url owns sort, type, view and
// completion and hands them to the server, which validates and combines them;
// the text filter stays local.

import { useCallback, useId, useMemo, useState } from "react";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import CollectionView from "@/components/collections/CollectionView";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import SuggestionsSection, { suggestionTargetId } from "@/components/collections/SuggestionsSection";
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
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import {
  addPlacement,
  entriesPage,
  getLibrary,
  leaveLibrary,
  moveEntry,
  type Library,
  type LibraryEntry,
} from "@/lib/libraries/api";
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
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
import { usePaneChrome, type PaneRefreshExecute } from "@/lib/panes/paneChrome";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import { matchesPaneFilterQuery, paneFilterRowsStatusVisible, usePaneFilterRows } from "@/lib/panes/paneFilterRows";
import {
  usePaneIsActive,
  usePaneParam,
  usePaneRouter,
  usePaneRuntime,
  usePaneSearchParams,
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { podcastRefresh } from "@/lib/podcasts/paneState";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
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

/** The entry a one-row move moved, and the entry now after it. */
function moved(before: readonly LibraryEntry[], after: readonly LibraryEntry[]) {
  const first = after.findIndex((entry, i) => entry !== before[i]);
  if (first < 0) return null;
  const last = after.findLastIndex((entry, i) => entry !== before[i]);
  const index = after[last] === before[first] ? last : first;
  const entry = after[index]!;
  return { entry, before: after[index + 1] ?? null };
}

export default function LibraryPaneBody() {
  const id = usePaneParam("id");
  if (!id) throw new Error("library route requires an id");
  return <LibraryPane key={id} id={id} />;
}

function LibraryPane({ id }: { readonly id: string }) {
  const runtime = usePaneRuntime();
  const active = usePaneIsActive();
  const router = usePaneRouter();
  const params = usePaneSearchParams();
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
    ].join("|"),
    pageSize: 100,
    drain: true,
    active,
    visit: ENTRIES,
    id: libraryEntryId,
    fetchPage: (cursor, limit, signal) =>
      entriesPage(id, pageQuery(query, cursor, limit), signal),
  });
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
  // The dragged order shows until the reread lands.
  const [dragged, setDragged] = useState<readonly LibraryEntry[] | null>(null);
  const isAll = library?.is_default === true;
  const sortable =
    library?.can_manage === true &&
    query === "" &&
    text === "" &&
    list.complete &&
    list.running !== "Refetch";
  const ordered = dragged ?? visible;
  const reorder = async (next: readonly LibraryEntry[]) => {
    const move = moved(ordered, next);
    if (move === null || dragged !== null) return;
    setDragged(next);
    setFeedback(null);
    try {
      // A named library's rows are all stored entries.
      await moveEntry(id, move.entry.entry_id!, move.before?.entry_id ?? null);
    } catch (error) {
      setFeedback(libraryErrorFeedback(error, "Library order wasn’t saved", fail));
    }
    await list.refetch().catch(() => {});
    setDragged(null);
  };

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
      const result = await podcastRefresh({ kind: "Library", library_id: id })(context);
      refetchDetail();
      await refetchEntries().catch(() => {});
      return result;
    },
    [id, refetchDetail, refetchEntries],
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
  const menuActions: ActionDescriptor[] = [];
  if (library?.can_manage) {
    menuActions.push({
      kind: "command",
      id: "ViewAction.Library.AddContent",
      label: "Add content",
      restoreFocusOnClose: false,
      onSelect: () =>
        requestNexusOpen({
          kind: "Add",
          seed: { kind: "Content", initialDestinations: [{ id, name: library.name }] },
        }),
    });
  }
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
  useSetPaneLabel(library ? libraryDisplayName(library) : missing ? "Library" : null);
  usePaneChrome({
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
            id: queryStatusId,
            visible: paneFilterRowsStatusVisible({
              status: filterRows.rowStatus,
              identityCount: headerMeta.kind === "Count" ? headerMeta.value : null,
              atDefaultView: !canReset,
            }),
            content: <PaneFilterRowsStatus id={queryStatusId} status={filterRows.rowStatus} query={filterRows.query} />,
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
        actions={[{ label: "Retry", onClick: detail.refetch }]}
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
    <PaneSurface
      state={
        feedback || leaving || loadFailure || summaries.error ? (
          <>
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
        rows={ordered.map((entry) => presentLibraryEntry(entry, added))}
        empty={empty}
        status={list.status === "failed" ? "error" : list.status}
        error={
          firstLoad ? (
            <FeedbackNotice
              content={firstLoad}
              announcement="Assertive"
              actions={[{ label: "Retry", onClick: list.retry }]}
            />
          ) : null
        }
        ariaLabel={name}
        rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: text }}
        rowActionsAvailable={list.current}
        footer={visible.length > 0 ? <CollectionExhaustionNotice list={list} /> : undefined}
        collectionBusy={!list.current || !list.complete}
        surface={false}
        sortable={
          sortable
            ? {
                disabled: dragged !== null,
                onReorder: (rows) => {
                  const byId = new Map(ordered.map((entry) => [libraryEntryId(entry), entry]));
                  void reorder(rows.flatMap((row) => byId.get(row.id) ?? []));
                },
              }
            : undefined
        }
      />
      {list.complete ? (
        <SuggestionsSection
          kind="Library"
          library={{ id, name }}
          isActive={active}
          accept={async (target) => {
            await addPlacement({ kind: target.kind, id: suggestionTargetId(target) }, id);
            return "Accepted";
          }}
        />
      ) : null}
    </PaneSurface>
  );
}
