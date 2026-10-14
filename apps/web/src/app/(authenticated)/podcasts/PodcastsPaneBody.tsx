"use client";

// The followed shows. The url owns filter, sort and library scope and passes
// them to the server, which validates them; the text filter stays local.

import { useCallback, useId } from "react";
import Link from "next/link";
import { Compass } from "lucide-react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { viewHref } from "@/lib/collections/view";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import RadioGroup from "@/components/ui/RadioGroup";
import Button from "@/components/ui/Button";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { useResource } from "@/lib/api/useResource";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { memberLibraries } from "@/lib/libraries/api";
import { useMediaQueryRevision } from "@/lib/media/MediaSummaryProvider";
import { usePaneRouter, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import {
  matchesPaneFilterQuery,
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
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";

const VISIT = definePaneVisitDataKey<ListSnapshot<PodcastSubscriptionRow>>(
  "Podcasts.Subscriptions",
);
const REFRESH = podcastRefresh({ kind: "Podcasts" });
const UNIT = { singular: "show", plural: "shows" };
const ACTIONS: readonly ActionDescriptor[] = [
  {
    kind: "link",
    id: "Podcasts.Browse",
    label: "Browse",
    icon: <Compass size={16} aria-hidden="true" />,
    href: "/browse?kind=Podcast",
  },
];
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
  const params = usePaneSearchParams();
  const sort = params.get("sort") ?? "recent_episode";
  const filter = params.get("filter") ?? "all";
  const libraryId = params.get("library_id");
  const query = new URLSearchParams({ sort, filter });
  if (libraryId !== null) query.set("library_id", libraryId);
  const key = query.toString();
  const list = useServerList<PodcastSubscriptionRow>({
    key,
    stale: `${useChangeStamp("Podcasts")}:${useMediaQueryRevision()}`,
    pageSize: 100,
    drain: false,
    active: true,
    visit: VISIT,
    id: (row) => row.podcast_id,
    fetchPage: (cursor, limit, signal) =>
      listSubscriptions(pageQuery(key, cursor, limit), signal),
  });
  const libraries = useResource({
    cacheKey: "podcasts:member-libraries",
    load: memberLibraries,
  });
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
        viewTransition: { kind: "collection-reflow" },
      }),
    [params, router],
  );
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const libraryChoices = [
    { value: "", label: "All libraries" },
    ...(libraries.status === "ready" ? libraries.data.map((library) => ({ value: library.id, label: library.name })) : []),
  ];
  if (libraryId !== null && !libraryChoices.some((choice) => choice.value === libraryId)) {
    libraryChoices.push({ value: libraryId, label: libraryId });
  }
  const showChoices = FILTERS.some((choice) => choice.value === filter) ? FILTERS : [...FILTERS, { value: filter, label: filter }];
  const sortChoices = SORTS.some((choice) => choice.value === sort) ? SORTS : [...SORTS, { value: sort, label: sort }];
  const chips = [
    ...(filter === "all" ? [] : [{ id: "filter", label: `Show: ${showChoices.find((choice) => choice.value === filter)?.label}` }]),
    ...(libraryId === null ? [] : [{ id: "library_id", label: `Library: ${libraryChoices.find((choice) => choice.value === libraryId)?.label}` }]),
  ];
  const queryControls = {
    kind: "Controls" as const,
    label: "Filter followed podcasts",
    focusInput,
    content: <PaneQueryToolbar
      inputRef={inputRef}
      input={{ label: "Filter followed podcasts", placeholder: "Filter shows", value: filterRows.query, appliedValue: filterRows.query, onChange: filterRows.onQueryChange, onClear: filterRows.clearQuery }}
      options={{
        label: "Filters", activeCount: chips.length,
        onClear: () => replaceView({ filter: null, library_id: null }),
        content: <>
          <RadioGroup label="Show" value={filter} choices={showChoices} onChange={(value) => replaceView({ filter: value === "all" ? null : value })} />
          <RadioGroup label="Library" value={libraryId ?? ""} choices={libraryChoices} disabled={libraries.status === "loading"} onChange={(value) => replaceView({ library_id: value || null })} />
        </>,
      }}
      sort={{ label: "Sort", value: sort, choices: sortChoices, onChange: (value) => replaceView({ sort: value === "recent_episode" ? null : value }) }}
      chips={{ items: chips, onRemove: (id) => replaceView({ [id]: null }) }}
      status={{ id: queryStatusId, content: <PaneFilterRowsStatus id={queryStatusId} status={filterRows.rowStatus} query={filterRows.query} /> }}
      onReset={sort !== "recent_episode" || chips.length > 0 || filterRows.query ? () => {
        filterRows.clearQuery();
        replaceView({ sort: null, filter: null, library_id: null });
      } : undefined}
    />,
  };
  usePaneChrome({
    header: {
      kind: "Section",
      meta: complete
        ? { kind: "Count", value: rows?.length ?? 0, unit: "show" }
        : list.status === "loading"
          ? { kind: "Pending" }
          : { kind: "None" },
    },
    menuActions: ACTIONS,
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
            : { label: "Retry", onClick: list.retry },
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
          contributors: row.contributors,
          unplayedCount:
            row.unplayed_count > 0
              ? { value: row.unplayed_count }
              : null,
          syncStatus: row.sync_status,
          publicationDate: row.latest_episode_published_at,
        }),
      )}
      status={list.status === "loading" ? "loading" : "ready"}
      ariaLabel="Followed podcasts"
      rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: text }}
      notice={
        list.status === "ready" && list.failure ? (
          <FeedbackNotice
            content={podcastErrorMessage(
              list.failure.error,
              list.failure.op === "More"
                ? "More followed podcasts couldn’t be loaded"
                : "Followed podcasts couldn’t be refreshed",
            )}
            announcement="Polite"
            actions={[{ label: "Retry", onClick: list.retry }]}
          />
        ) : libraries.status === "error" ? (
          <FeedbackNotice
            content={podcastErrorMessage(
              libraries.error,
              "Podcast libraries couldn’t be loaded",
            )}
            announcement="Polite"
            actions={[{ label: "Retry", onClick: libraries.retry }]}
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
              title: "No podcasts match the current filters.",
            }}
            announcement="None"
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => replaceView({ filter: null, library_id: null })}
            >
              Clear filters
            </Button>
          </FeedbackNotice>
        ) : (
          <FeedbackNotice
            content={{ tone: "Neutral", title: "No followed podcasts yet." }}
            announcement="None"
          >
            <Button asChild variant="ghost" size="sm">
              <Link href="/browse?kind=Podcast">Browse podcasts</Link>
            </Button>
          </FeedbackNotice>
        )
      }
      footer={
        list.current && !list.complete ? (
          <LoadMoreFooter
            hasMore
            loading={list.running === "More"}
            onLoadMore={list.more}
          />
        ) : undefined
      }
    />
  );
}
