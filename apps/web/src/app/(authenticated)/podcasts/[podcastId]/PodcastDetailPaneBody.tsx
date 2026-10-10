"use client";

// One show: its head (detail and library count), then its episodes, which
// always reload after the head (a terminal subscription has committed its
// episodes). While the subscription is live and the pane active, its
// lifecycle stream refetches the head on every change.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import AcquisitionControl from "@/components/browse/AcquisitionControl";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import PodcastOverview from "@/components/podcasts/PodcastOverview";
import PodcastViewBar, {
  podcastViewHref,
} from "@/components/podcasts/PodcastViewBar";
import Button from "@/components/ui/Button";
import LoadMoreFooter from "@/components/ui/LoadMoreFooter";
import PaneSection from "@/components/ui/PaneSection";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePanePrimaryChrome } from "@/components/workspace/PanePrimaryChrome";
import usePaneCollectionInput from "@/components/workspace/usePaneCollectionInput";
import { presenceValueOr } from "@/lib/api/presence";
import { useConsumptionProjectionRevision } from "@/lib/consumption/projectionRevision";
import { useResourceInspector } from "@/lib/dossiers/useResourceInspector";
import { listLibraryPlacements } from "@/lib/libraries/libraryPlacement";
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
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { matchesPaneFilterQuery } from "@/lib/panes/paneRowFilter";
import usePaneFilterRows from "@/lib/panes/usePaneFilterRows";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import {
  getPodcastDetail,
  listEpisodes,
  observeSubscription,
  retryPodcastSubscriptionBackfill,
  subscribeToPodcast,
  usePodcastRevision,
  type EpisodeState,
  type PodcastDetail,
  type PodcastEpisodeRow,
  type PodcastLifecycle,
  type PodcastSubscription,
} from "@/lib/podcasts/api";
import {
  listRowStatus,
  podcastErrorMessage,
  podcastRefresh,
  useCommand,
  useServerList,
  useServerValue,
  type ListData,
  type Visit,
} from "@/lib/podcasts/paneState";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { pluralize } from "@/lib/text/pluralize";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";
import PodcastEpisodeList from "./PodcastEpisodeList";
import styles from "./page.module.css";

interface Head {
  readonly detail: PodcastDetail;
  readonly libraryCount: number;
}

const HEAD = definePaneVisitDataKey<Visit<Head>>("PodcastDetail.Head");
const EPISODES = definePaneVisitDataKey<Visit<ListData<PodcastEpisodeRow>>>(
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
  processedCount,
  addedCount,
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
  const speed = presenceValueOr(subscription.default_playback_speed, 1);
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
  subscription.sync_status === snapshot.syncStatus &&
  (["id", "state", "processedCount", "addedCount"] as const).every(
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
  const revision = usePodcastRevision();
  const mediaRevision = useMediaQueryRevision();
  const consumption = useConsumptionProjectionRevision();
  const head = useServerValue<Head>({
    key: podcastId,
    stale: `${revision}:${mediaRevision}`,
    visit: HEAD,
    load: async (signal) => {
      const [detail, placements] = await Promise.all([
        getPodcastDetail(podcastId, signal),
        listLibraryPlacements({ kind: "Podcast", id: podcastId }, { signal }),
      ]);
      const placed = placements.filter((row) => row.relation.kind !== "Absent");
      return { detail, libraryCount: placed.length };
    },
  });
  const ready = head.status === "ready" ? head : null;
  const query = new URLSearchParams({ state, sort }).toString();
  const episodes = useServerList<PodcastEpisodeRow>({
    key: ready === null ? null : `${podcastId}?${query}`,
    stale: `${ready?.generation}:${state === "all" ? 0 : consumption.revision}`,
    pageSize: 100,
    visit: EPISODES,
    fetchPage: (page, signal) =>
      listEpisodes(podcastId, new URLSearchParams(`${query}&${page}`), signal),
  });
  const loaded = episodes.status === "ready" ? episodes.items : null;
  const summaries = useMediaSummaries(
    (loaded ?? []).map((episode) => episode.mediaSummary),
  );
  const resolved = useMemo(
    () =>
      (loaded ?? []).flatMap((episode) => {
        const summary = summaries.resolve(episode.mediaSummary);
        return summary.kind === "Absent"
          ? []
          : [{ ...episode, mediaSummary: summary.value }];
      }),
    [loaded, summaries],
  );

  const subscription = ready?.data.detail.subscription ?? null;
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
    onPoll: episodes.refetch,
  });

  const command = useCommand();
  const complete = episodes.status === "ready" && episodes.complete;
  const getRowStatus = useCallback(
    (text: string) => {
      const visible = resolved.filter((episode) =>
        matchesPaneFilterQuery(
          text,
          mediaListFilterFields(episode.mediaSummary),
        ),
      );
      return listRowStatus(
        episodes.status,
        complete,
        resolved.length,
        visible.length,
        "episode",
      );
    },
    [complete, episodes.status, resolved],
  );
  const filterRows = usePaneFilterRows({
    sourceKey: `PodcastDetail.Episodes:${podcastId}`,
    getRowStatus,
  });
  const replaceView = useCallback(
    (changes: Readonly<Record<string, string | null>>) =>
      router.replace(
        podcastViewHref(`/podcasts/${podcastId}`, params, changes),
        {
          viewTransition: { kind: "collection-reflow" },
        },
      ),
    [params, podcastId, router],
  );
  const { inputRef, focusInput } = usePaneCollectionInput();
  const collection = useMemo(
    () => ({
      label: "Filter podcast episodes",
      content: (
        <PodcastViewBar
          inputRef={inputRef}
          inputLabel="Filter podcast episodes"
          placeholder="Filter episodes"
          filterRows={filterRows}
          sort={{
            param: "sort",
            label: "Sort episodes",
            value: sort,
            defaultValue: "newest",
            options: SORTS,
          }}
          filters={[
            {
              param: "state",
              label: "Playback",
              value: state,
              defaultValue: "all",
              options: STATES,
            },
          ]}
          onChange={replaceView}
        />
      ),
      focusInput,
    }),
    [filterRows, focusInput, inputRef, replaceView, sort, state],
  );
  const execute = useMemo(
    () => podcastRefresh({ kind: "Podcast", podcastId }),
    [podcastId],
  );
  const connections = useMemo(
    () => (
      <ConnectionsSurface resourceRef={{ scheme: "podcast", id: podcastId }} />
    ),
    [podcastId],
  );
  const { companionAction } = useResourceInspector({
    scheme: "podcast",
    handle: podcastId,
    bodies: { linkedItems: connections },
  });
  usePanePrimaryChrome({
    companionAction: companionAction ?? undefined,
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
    actionSubject: {
      ref: canonicalResourceRef({ scheme: "podcast", id: podcastId }),
    },
    header: {
      kind: "Section",
      meta: complete
        ? { kind: "Count", value: loaded?.length ?? 0, unit: "episode" }
        : episodes.status === "loading" && head.status !== "failed"
          ? { kind: "Pending" }
          : { kind: "None" },
    },
    collection,
  });
  const podcast = ready?.data.detail.podcast;
  useSetPaneLabel(
    podcast?.title ?? (head.status === "loading" ? null : "Podcast"),
  );
  usePaneReturnReady(
    head.status === "failed" ||
      (ready !== null && episodes.status !== "loading"),
  );

  const text = filterRows.query.trim();
  const known = STATES.find((option) => option.value === state)?.value;
  const visible = resolved.filter((episode) =>
    matchesPaneFilterQuery(text, mediaListFilterFields(episode.mediaSummary)),
  );
  return (
    <div className={styles.page}>
      <div className={styles.bar}>
        <Link href="/podcasts" className={styles.navLink}>
          Podcasts
        </Link>
        {ready ? (
          <AcquisitionControl
            kind="Subscribe"
            subscribed={subscription !== null}
            commit={async (acquisition) => {
              const result = await subscribeToPodcast({
                target: { kind: "Canonical", podcastId },
                ...acquisition,
              });
              return { href: result.href };
            }}
            onCommitted={() => undefined}
          />
        ) : null}
      </div>
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
            actions={[{ label: "Retry", onClick: head.refetch }]}
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
              `In ${pluralize(ready.data.libraryCount, "library", "libraries")}`,
              ...(subscription ? subscriptionFacts(subscription) : []),
            ]}
            links={[
              { label: "RSS feed", href: podcast.feed_url },
              ...(podcast.website_url
                ? [{ label: "Website", href: podcast.website_url }]
                : []),
            ]}
            note={
              subscription
                ? "Subscription is active. Manage playback defaults, episode updates, and library membership from this header."
                : "Subscribe to save playback defaults and add this show to your libraries."
            }
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
        {episodes.status === "failed" ? (
          <FeedbackNotice
            content={podcastErrorMessage(
              episodes.error,
              "Episodes couldn’t be loaded",
            )}
            announcement="Assertive"
            actions={[
              episodes.error.code === "E_INVALID_REQUEST"
                ? {
                    label: "Reset view",
                    onClick: () => replaceView({ state: null, sort: null }),
                  }
                : { label: "Retry", onClick: episodes.retry },
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
                {episodes.status === "ready" && episodes.error ? (
                  <FeedbackNotice
                    content={podcastErrorMessage(
                      episodes.error,
                      "Episodes couldn’t be refreshed",
                    )}
                    announcement="Polite"
                    actions={[{ label: "Retry", onClick: episodes.retry }]}
                  />
                ) : null}
                <MediaSummaryNotice
                  error={summaries.error}
                  retry={summaries.retry}
                />
              </>
            }
            footer={
              episodes.status === "ready" && !episodes.complete ? (
                <LoadMoreFooter
                  hasMore
                  loading={episodes.loadingMore}
                  onLoadMore={episodes.loadMore}
                />
              ) : undefined
            }
          />
        )}
      </PaneSection>
    </div>
  );
}
