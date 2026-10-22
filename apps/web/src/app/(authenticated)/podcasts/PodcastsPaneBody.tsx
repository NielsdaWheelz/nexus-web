"use client";

// The followed shows. The url owns filter, sort and library scope and passes
// them to the server, which validates them; the text filter stays local.
// A selected scope owns its label read independently of the closed choices.

import { useCallback, useId, useState } from "react";
import { Plus } from "lucide-react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { viewHref } from "@/lib/collections/view";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import RadioGroup from "@/components/ui/RadioGroup";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import { usePaneChrome, type PanePrimaryAction } from "@/lib/panes/paneChrome";
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
  paneFilterRowsStatusVisible,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import {
  listSubscriptions,
  type PodcastSubscriptionRow,
} from "@/lib/podcasts/api";
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

const VISIT = definePaneVisitDataKey<ListSnapshot<PodcastSubscriptionRow>>(
  "Podcasts.Subscriptions",
);
const LIBRARIES = definePaneVisitDataKey<ListSnapshot<Library>>("Podcasts.LibraryChoices");
const SELECTED_LIBRARY = definePaneVisitDataKey<Visit<Library>>("Podcasts.SelectedLibrary");
const REFRESH = podcastRefresh({ kind: "Podcasts" });
const UNIT = { singular: "show", plural: "shows" };
const BROWSE: PanePrimaryAction = {
  kind: "link",
  id: "Podcasts.Browse",
  label: "browse podcasts",
  icon: <Plus size={20} aria-hidden="true" />,
  href: "/browse?kind=Podcast",
};
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

const fields = (row: PodcastSubscriptionRow) => [
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
  const list = useServerList<PodcastSubscriptionRow>({
    key: `/podcasts/subscriptions?${key}`,
    stale: `${useChangeStamp("Podcasts")}:${useMediaQueryRevision()}`,
    pageSize: 100,
    active,
    visit: VISIT,
    id: (row) => row.podcast_id,
    fetchPage: (cursor, limit, signal) =>
      listSubscriptions(pageQuery(key, cursor, limit), signal),
  });
  const libraries = useServerList<Library>({
    key: "podcasts:member-libraries",
    stale: librariesRevision,
    pageSize: 200,
    active: active && librariesOpen,
    visit: LIBRARIES,
    id: library => library.id,
    fetchPage: (cursor, limit, signal) => librariesPage(pageQuery("", cursor, limit), signal),
  });
  const selectedLibraryId = libraryId !== null && !libraries.items.some(library => library.id === libraryId) ? libraryId : null;
  const selectedLibrary = useServerValue<Library>({
    key: selectedLibraryId,
    stale: librariesRevision,
    visit: SELECTED_LIBRARY,
    load: signal => {
      if (selectedLibraryId === null) throw new Error("selected library read requires a library id");
      return getLibrary(selectedLibraryId, signal);
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
          <CollectionExhaustionNotice list={libraries} unit={{ singular: "library", plural: "libraries" }} returnFocus={() => inputRef.current} />
        </>,
      }}
      sort={{ label: "Sort", value: sort, choices: sortChoices, onChange: (value) => replaceView({ sort: value === "recent_episode" ? null : value }) }}
      chips={{ items: chips, onRemove: (id) => replaceView({ [id]: null }) }}
      status={{
        placement: "Inline",
        id: queryStatusId,
        visible: paneFilterRowsStatusVisible({
          status: filterRows.rowStatus,
          filtering: filterRows.query.trim() !== "" || chips.length > 0,
        }),
        content: <PaneFilterRowsStatus id={queryStatusId} status={filterRows.rowStatus} query={filterRows.query} />,
      }}
      onReset={canReset ? () => {
        filterRows.clearQuery();
        replaceView({ sort: null, filter: null, library_id: null });
      } : undefined}
    />,
  };
  usePaneChrome({
    header: { kind: "Section", meta: headerMeta },
    primaryAction: BROWSE,
    menuActions: [BROWSE],
    query: queryControls,
    refresh: {
      kind: "Refreshable",
      sourceKey: `Podcasts.Subscriptions:${key}`,
      execute: REFRESH,
    },
  });
  usePaneReturnReady(list.status !== "loading");

  if (list.status === "failed" && list.failure !== null) {
    const invalidView = list.failure.error.code === "E_INVALID_REQUEST";
    return (
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
    );
  }

  const text = filterRows.query.trim();
  const visible = (rows ?? []).filter((row) =>
    matchesPaneFilterQuery(text, fields(row)),
  );
  const filtered = filter !== "all" || libraryId !== null;
  return (
    <CollectionView
      returnScope="Podcasts.Subscriptions"
      rows={visible.map((row) =>
        presentPodcast({
          id: row.podcast_id,
          title: row.title,
          imageUrl: row.image_url,
          contributors: row.contributors,
          unplayedCount:
            row.unplayed_count > 0
              ? { value: row.unplayed_count }
              : null,
          syncStatus: row.sync_status,
        }),
      )}
      status={list.status === "loading" ? "loading" : "ready"}
      ariaLabel="Followed podcasts"
      rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: text }}
      notice={
        list.status === "ready" && list.failure && list.failure.op !== "More" ? (
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
        ) : undefined
      }
      empty={
        text ? (
          <FeedbackNotice
            content={{
              tone: "Neutral",
              title: complete
                ? "No shows match this filter."
                : "No matching show found so far.",
            }}
            announcement="None"
          />
        ) : filtered ? (
          <FeedbackNotice
            content={{
              tone: "Neutral",
              title: complete ? "no podcasts match the current filters." : "no matching show found so far.",
            }}
            announcement="None"
            actions={[{ label: "clear filters", onClick: () => replaceView({ filter: null, library_id: null }) }]}
          />
        ) : (
          <FeedbackNotice
            content={{ tone: "Neutral", title: complete ? "no followed podcasts yet." : "no shows loaded so far." }}
            announcement="None"
            actions={[{ label: "browse podcasts", href: "/browse?kind=Podcast" }]}
          />
        )
      }
      footer={<CollectionExhaustionNotice list={list} unit={UNIT} returnFocus={() => inputRef.current} />}
    />
  );
}
