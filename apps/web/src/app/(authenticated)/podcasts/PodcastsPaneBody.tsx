"use client";

// The followed shows. The url owns filter, sort and library scope and passes
// them to the server, which validates them; the text filter stays local.

import { useCallback, useMemo } from "react";
import Link from "next/link";
import { Compass } from "lucide-react";
import CollectionView from "@/components/collections/CollectionView";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import PodcastViewBar, {
  podcastViewHref,
} from "@/components/podcasts/PodcastViewBar";
import Button from "@/components/ui/Button";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneCollectionInput } from "@/components/workspace/PaneCollectionBar";
import { absent, present } from "@/lib/api/presence";
import { useResource } from "@/lib/api/useResource";
import { presentPodcast } from "@/lib/collections/presenters/podcast";
import { listMemberLibraries } from "@/lib/libraries/client";
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
    load: (signal) => listMemberLibraries({ signal }),
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
      router.replace(podcastViewHref("/podcasts", params, changes), {
        viewTransition: { kind: "collection-reflow" },
      }),
    [params, router],
  );
  const { inputRef, focusInput } = usePaneCollectionInput();
  const collection = useMemo(() => {
    const options = libraries.status === "ready" ? libraries.data : [];
    const library = {
      param: "library_id",
      label: "Library",
      value: libraryId ?? "",
      defaultValue: "",
      options: [
        { value: "", label: "All libraries" },
        ...options.map((option) => ({ value: option.id, label: option.name })),
      ],
      disabled: libraries.status === "loading",
    };
    return {
      label: "Filter followed podcasts",
      content: (
        <PodcastViewBar
          inputRef={inputRef}
          inputLabel="Filter followed podcasts"
          placeholder="Filter shows"
          filterRows={filterRows}
          sort={{
            param: "sort",
            label: "Sort shows",
            value: sort,
            defaultValue: "recent_episode",
            options: SORTS,
          }}
          filters={[
            {
              param: "filter",
              label: "Show",
              value: filter,
              defaultValue: "all",
              options: FILTERS,
            },
            library,
          ]}
          onChange={replaceView}
        />
      ),
      focusInput,
    };
  }, [
    filter,
    filterRows,
    focusInput,
    inputRef,
    libraries,
    libraryId,
    replaceView,
    sort,
  ]);
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
    collection,
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
              ? present({ value: row.unplayed_count })
              : absent(),
          syncStatus: present(row.sync_status),
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
