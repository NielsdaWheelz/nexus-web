"use client";

import { useResourceComposer } from "@/components/resources/ResourceComposer";

// One show: its detail, then its episodes, which
// always reload after the head (a terminal subscription has committed its
// episodes). While the subscription is live and the pane active, its
// lifecycle stream refetches the head on every change.

import { useCallback, useId, useEffect, useMemo, useRef, useState } from "react";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import PodcastOverview from "@/components/podcasts/PodcastOverview";
import { viewHref } from "@/lib/collections/view";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import RadioGroup from "@/components/ui/RadioGroup";
import Button from "@/components/ui/Button";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import PaneSection from "@/components/ui/PaneSection";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import type { PaneHeaderMeta } from "@/lib/panes/paneHeaderModel";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import {
  useMediaQueryRevision,
  useMediaSummaries,
} from "@/lib/media/MediaSummaryProvider";
import { mediaListFilterFields } from "@/lib/media/mediaListFilter";
import { shouldPollTranscriptProvisioning } from "@/lib/media/transcriptView";
import {
  usePaneIsActive,
  usePaneParam,
  usePaneRouter,
  usePaneSearchParams,
} from "@/lib/panes/paneRuntime";
import {
  matchesPaneFilterQuery,
  paneFilterRowsStatusVisible,
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import {
  getPodcastDetail,
  listEpisodes,
  observeSubscription,
  retryPodcastSubscriptionBackfill,
  type EpisodeState,
  type PodcastDetail,
  type PodcastEpisodeRow,
  type PodcastLifecycle,
  type PodcastSubscription,
} from "@/lib/podcasts/api";
import { useChangeStamp } from "@/lib/api/changes";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import {
  listRowStatus,
  pageQuery,
  useServerList,
  type ListSnapshot,
} from "@/lib/api/useServerList";
import {
  podcastErrorMessage,
  podcastRefresh,
  useCommand,
} from "@/lib/podcasts/paneState";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";
import PodcastEpisodeList from "./PodcastEpisodeList";
import styles from "./page.module.css";

const HEAD = definePaneVisitDataKey<Visit<PodcastDetail>>("PodcastDetail.Head");
const EPISODES = definePaneVisitDataKey<ListSnapshot<PodcastEpisodeRow>>(
  "PodcastDetail.Episodes",
);
const STATES: readonly {
  readonly value: EpisodeState;
  readonly label: string;
}[] = [
  { value: "all", label: "All episodes" },
  { value: "unplayed", label: "Unplayed" },
  { value: "in_progress", label: "In progress" },
  { value: "played", label: "Played" },
];
const SORTS = [
  { value: "newest", label: "Newest released" },
  { value: "oldest", label: "Oldest released" },
  { value: "duration_asc", label: "Shortest duration" },
  { value: "duration_desc", label: "Longest duration" },
];
const TERMINAL = new Set(["Complete", "SourceLimited", "Failed"]);
const BACKLOG = "Podcast backlog retry wasn’t started";

const UPDATES: Readonly<Record<PodcastSubscription["sync_status"], string>> = {
  Pending: "Episode updates pending",
  Running: "Checking for new episodes",
  Complete: "Episode updates current",
  SourceLimited: "Episode updates source-limited",
  Failed: "Episode updates failed",
};

function backfillFact({
  state,
  processed_count: processedCount,
  added_count: addedCount,
}: PodcastSubscription["backfill"]) {
  const label =
    state === "Running"
      ? "Backfilling"
      : state === "SourceLimited"
        ? "Backfill source limited"
        : `Backfill ${state.toLowerCase()}`;
  return `${label} · ${processedCount} processed · ${addedCount} added`;
}

function subscriptionFacts(subscription: PodcastSubscription) {
  const speed = subscription.default_playback_speed ?? 1;
  const queue = subscription.auto_queue ? "on" : "off";
  return [
    UPDATES[subscription.sync_status],
    backfillFact(subscription.backfill),
    `${formatPlaybackRate(speed)} default speed · Auto-queue ${queue}`,
  ];
}

const sameLifecycle = (
  subscription: PodcastSubscription | null,
  snapshot: PodcastLifecycle,
) =>
  subscription !== null &&
  subscription.sync_status === snapshot.sync_status &&
  (["id", "state", "processed_count", "added_count"] as const).every(
    (field) => subscription.backfill[field] === snapshot.backfill[field],
  );

export default function PodcastDetailPaneBody() {
  const podcastId = usePaneParam("podcastId");
  if (podcastId === null) {
    // justify-defect: the podcastDetail route always binds its podcastId.
    throw new Error("Podcast detail pane without a podcastId");
  }
  return <PodcastDetailPane key={podcastId} podcastId={podcastId} />;
}

function PodcastDetailPane({ podcastId }: { readonly podcastId: string }) {
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const active = usePaneIsActive();
  const state = params.get("state") ?? "all";
  const sort = params.get("sort") ?? "newest";
  const consumption = useChangeStamp("Consumption");
  const head = useServerValue<PodcastDetail>({
    key: podcastId,
    stale: `${useChangeStamp("Podcasts")}:${useMediaQueryRevision()}`,
    visit: HEAD,
    load: (signal) => getPodcastDetail(podcastId, signal),
  });
  const ready = head.status === "ready" ? head : null;
  const query = new URLSearchParams({ state, sort }).toString();
  const episodes = useServerList<PodcastEpisodeRow>({
    key: ready === null ? null : `${podcastId}?${query}`,
    stale: `${ready?.generation}:${state === "all" ? "-" : consumption}`,
    pageSize: 100,
    drain: false,
    active,
    visit: EPISODES,
    id: (episode) => episode.id,
    fetchPage: (cursor, limit, signal) =>
      listEpisodes(podcastId, pageQuery(query, cursor, limit), signal),
  });
  const loaded = episodes.status === "ready" ? episodes.items : null;
  const summaries = useMediaSummaries(
    (loaded ?? []).map((episode) => episode.media_summary),
  );
  const resolved = useMemo(
    () =>
      (loaded ?? []).flatMap((episode) => {
        const summary = summaries.resolve(episode.media_summary);
        return summary === null
          ? []
          : [{ ...episode, media_summary: summary }];
      }),
    [loaded, summaries],
  );

  const subscription = ready?.data.subscription ?? null;
  const terminal =
    subscription === null ||
    (TERMINAL.has(subscription.sync_status) &&
      TERMINAL.has(subscription.backfill.state));
  const backfillId = subscription?.backfill.id ?? null;
  const subscriptionRef = useRef(subscription);
  subscriptionRef.current = subscription;
  const [lost, setLost] = useState<{
    readonly backfillId: string;
    readonly error: Error;
  } | null>(null);
  const refetchHead = head.refetch;
  useEffect(() => {
    if (!active || terminal || backfillId === null) return;
    const controller = new AbortController();
    observeSubscription(
      podcastId,
      controller.signal,
      (snapshot) => {
        setLost(null);
        if (!sameLifecycle(subscriptionRef.current, snapshot)) refetchHead();
      },
      (error) => {
        setLost({ backfillId, error });
        refetchHead();
      },
    );
    return () => controller.abort();
  }, [active, backfillId, podcastId, refetchHead, terminal]);
  // A lost stream matters only while that same subscription is still live.
  const lostNotice =
    lost !== null && lost.backfillId === backfillId && !terminal
      ? podcastErrorMessage(lost.error, "Podcast updates couldn’t be observed")
      : null;

  // justify-polling: transcript provisioning has no push stream here; the
  // queued or running episodes end the schedule.
  useIntervalPoll({
    enabled:
      active &&
      (loaded ?? []).some((episode) =>
        shouldPollTranscriptProvisioning(episode.transcript_state),
      ),
    pollIntervalMs: 3000,
    // a failed reread shows as the list's failure
    onPoll: () => episodes.refetch().catch(() => {}),
  });

  const command = useCommand();
  const complete = episodes.complete;
  const getRowStatus = useCallback(
    (text: string) => {
      const visible = resolved.filter((episode) =>
        matchesPaneFilterQuery(
          text,
          mediaListFilterFields(episode.media_summary),
        ),
      );
      return listRowStatus(episodes, resolved.length, visible.length, {
        singular: "episode",
        plural: "episodes",
      });
    },
    [episodes, resolved],
  );
  const filterRows = usePaneFilterRows({
    sourceKey: `PodcastDetail.Episodes:${podcastId}`,
    getRowStatus,
  });
  const replaceView = useCallback(
    (changes: Readonly<Record<string, string | null>>) =>
      router.replace(
        viewHref(`/podcasts/${podcastId}`, params, changes),
        {
          },
      ),
    [params, podcastId, router],
  );
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const playbackChoices = STATES.some((choice) => choice.value === state) ? STATES : [...STATES, { value: state, label: state }];
  const sortChoices = SORTS.some((choice) => choice.value === sort) ? SORTS : [...SORTS, { value: sort, label: "Unsupported order" }];
  const chips = state === "all" ? [] : [{ id: "state", label: `Playback: ${playbackChoices.find((choice) => choice.value === state)?.label}` }];
  const canReset = sort !== "newest" || chips.length > 0;
  const headerMeta: PaneHeaderMeta = complete
    ? { kind: "Count", value: loaded?.length ?? 0, unit: "episode" }
    : episodes.status === "loading" && head.status !== "failed"
      ? { kind: "Pending" }
      : { kind: "None" };
  const queryControls = {
    kind: "Controls" as const,
    label: "Filter podcast episodes",
    focusInput,
    content: <PaneQueryToolbar
      inputRef={inputRef}
      input={{ label: "Filter podcast episodes", placeholder: "Filter episodes", value: filterRows.query, appliedValue: filterRows.query, onChange: filterRows.onQueryChange, onClear: filterRows.clearQuery }}
      options={{
        label: "Filters", activeCount: chips.length,
        onClear: () => replaceView({ state: null }),
        content: <RadioGroup label="Playback" value={state} choices={playbackChoices} onChange={(value) => replaceView({ state: value === "all" ? null : value })} />,
      }}
      sort={{ label: "Sort", value: sort, choices: sortChoices, onChange: (value) => replaceView({ sort: value === "newest" ? null : value }) }}
      chips={{ items: chips, onRemove: () => replaceView({ state: null }) }}
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
        replaceView({ sort: null, state: null });
      } : undefined}
    />,
  };
  const execute = useMemo(
    () => podcastRefresh({ kind: "Podcast", podcast_id: podcastId }),
    [podcastId],
  );
  const connections = useMemo(
    () => (
      <ConnectionsSurface resourceRef={{ scheme: "podcast", id: podcastId }} />
    ),
    [podcastId],
  );
  useResourceInspector({
    scheme: "podcast",
    handle: podcastId,
    bodies: { linkedItems: connections },
  });
  const insertion = useResourceComposer({kind:"resource",ref:`podcast:${podcastId}`}, `podcast:${podcastId}`, "add item");
  usePaneChrome({
    menuActions: insertion.action ? [insertion.action] : [],
    // Only a subscription refreshes; until the head loads that is unknown.
    refresh:
      subscription !== null
        ? {
            kind: "Refreshable",
            sourceKey: `Podcast.Detail:${podcastId}`,
            execute,
          }
        : head.status === "loading"
          ? { kind: "Resolving" }
          : undefined,
    resourceRef: canonicalResourceRef({ scheme: "podcast", id: podcastId }),
    header: { kind: "Section", meta: headerMeta },
    query: queryControls,
  });
  const podcast = ready?.data.podcast;
  usePaneReturnReady(
    head.status === "failed" ||
      (ready !== null && episodes.status !== "loading"),
  );

  const text = filterRows.query.trim();
  const known = STATES.find((option) => option.value === state)?.value;
  const visible = resolved.filter((episode) =>
    matchesPaneFilterQuery(text, mediaListFilterFields(episode.media_summary)),
  );
  return (
    <div className={styles.page}>
      {insertion.content}
      <PaneSection>
        {head.status === "loading" ? (
          <PaneLoadingState label="Loading podcast…" announcement="Polite" />
        ) : null}
        {head.status !== "loading" && head.error ? (
          <FeedbackNotice
            content={podcastErrorMessage(
              head.error,
              "Podcast details couldn’t be loaded",
            )}
            announcement="Assertive"
            actions={[{ label: "Retry", onClick: head.refetch, busy: head.status === "failed" ? head.retrying : head.refreshing }]}
          />
        ) : null}
        {ready && podcast ? (
          <PodcastOverview
            title={podcast.title}
            image={
              podcast.image_url
                ? { kind: "Remote", url: podcast.image_url }
                : { kind: "Absent" }
            }
            contributors={podcast.contributors}
            description={podcast.description}
            facts={[
              subscription ? "Subscribed" : "Not subscribed",
              ...(subscription ? subscriptionFacts(subscription) : []),
            ]}
            links={[
              { label: "RSS feed", href: podcast.feed_url },
              ...(podcast.website_url
                ? [{ label: "Website", href: podcast.website_url }]
                : []),
            ]}
            error={
              subscription?.sync_error_code
                ? [
                    subscription.sync_error_code,
                    subscription.sync_error_message,
                  ]
                    .filter(Boolean)
                    .join(": ")
                : undefined
            }
          />
        ) : null}
        {lostNotice ? (
          <FeedbackNotice content={lostNotice} announcement="Polite" />
        ) : null}
        {subscription?.backfill.state === "Failed" ? (
          <div>
            <Button
              size="sm"
              variant="secondary"
              loading={command.running === BACKLOG}
              disabled={command.running !== null}
              onClick={() =>
                command.run(BACKLOG, () =>
                  retryPodcastSubscriptionBackfill(podcastId),
                )
              }
            >
              Retry backlog
            </Button>
          </div>
        ) : null}
      </PaneSection>
      <PaneSection>
        {episodes.status === "failed" && episodes.failure !== null ? (
          <FeedbackNotice
            content={podcastErrorMessage(
              episodes.failure.error,
              "Episodes couldn’t be loaded",
            )}
            announcement="Assertive"
            actions={[
              episodes.failure.error.code === "E_INVALID_REQUEST"
                ? {
                    label: "Reset view",
                    onClick: () => replaceView({ state: null, sort: null }),
                  }
                : { label: "Retry", onClick: episodes.retry, busy: episodes.running !== null },
            ]}
          />
        ) : known === undefined || ready === null ? null : (
          <PodcastEpisodeList
            podcastId={podcastId}
            state={known}
            episodes={visible}
            filter={text}
            complete={complete}
            loading={episodes.status === "loading"}
            command={command}
            notice={
              <>
                {command.failure ? (
                  <FeedbackNotice
                    content={command.failure}
                    announcement="Assertive"
                  />
                ) : null}
                {episodes.status === "ready" && episodes.failure ? (
                  <FeedbackNotice
                    content={podcastErrorMessage(
                      episodes.failure.error,
                      episodes.failure.op === "More"
                        ? "More episodes couldn’t be loaded"
                        : "Episodes couldn’t be refreshed",
                    )}
                    announcement="Polite"
                    actions={[{ label: "Retry", onClick: episodes.retry, busy: episodes.running !== null }]}
                  />
                ) : null}
                <MediaSummaryNotice
                  error={summaries.error}
                  retry={summaries.retry}
                busy={summaries.retrying}
                />
              </>
            }
            footer={
              episodes.current && !episodes.complete ? (
                <LoadMoreFooter
                  hasMore
                  loading={episodes.running === "More"}
                  onLoadMore={episodes.more}
                />
              ) : undefined
            }
          />
        )}
      </PaneSection>
    </div>
  );
}
