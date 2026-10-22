"use client";

// One show: exact listening counts and visit-local detail above episode pages.
// Head reads observe lifecycle/settings; episode and ordering changes reload pages.
// Preparation belongs to this visit until confirmation hands off an immutable
// command to the account owner. Observation stops outside the visible pane.

import { useCallback, useId, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import CollectionExhaustionNotice from "@/components/collections/CollectionExhaustionNotice";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import PodcastDestinationPicker from "@/components/podcasts/PodcastDestinationPicker";
import PodcastImportProgress from "@/components/podcasts/PodcastImportProgress";
import PodcastArtwork from "@/components/podcasts/PodcastArtwork";
import { ContributorCreditList, ContributorRoleGroups } from "@/components/contributors/ContributorCredits";
import { selectMediaAuthors } from "@/lib/contributors/credits";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { viewHref } from "@/lib/collections/view";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import RadioGroup from "@/components/ui/RadioGroup";
import Button from "@/components/ui/Button";
import PaneSurface from "@/components/ui/PaneSurface";
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
  usePaneIsVisible,
  usePaneRuntime,
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
  forecastEpisodeTranscripts,
  prepareEpisodeConsumption,
  getPodcastDetail,
  listEpisodes,
  requestPodcastRefresh,
  type EpisodeState,
  type PodcastDetail,
  type PodcastEpisodeRow,
} from "@/lib/podcasts/api";
import { publishChange, useChangeStamp } from "@/lib/api/changes";
import { modeledApiError, useThrowLater, useServerValue, type Visit } from "@/lib/api/serverState";
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
  usePaneVisitData,
} from "@/lib/workspace/paneReturnMemento";
import styles from "./page.module.css";

const HEAD = definePaneVisitDataKey<Visit<PodcastDetail>>("PodcastDetail.Head");
const DETAILS = definePaneVisitDataKey<boolean>("PodcastDetail.Details");
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
const HEAD_POLL_INTERVAL_MS = 60_000;

export default function PodcastDetailPaneBody() {
  const podcastId = usePaneParam("podcastId");
  const runtime = usePaneRuntime();
  if (podcastId === null || runtime === null) {
    // justify-defect: the podcastDetail route always binds its podcastId.
    throw new Error("Podcast detail pane without a podcastId");
  }
  return <PodcastDetailPane key={`${runtime.visitId}:${podcastId}`} podcastId={podcastId} />;
}

function PodcastDetailPane({ podcastId }: { readonly podcastId: string }) {
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const active = usePaneIsActive();
  const paneVisible = usePaneIsVisible();
  const [documentVisible, setDocumentVisible] = useState(true);
  useEffect(() => {
    const changed = () => setDocumentVisible(document.visibilityState === "visible");
    changed();
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const observing = active && paneVisible && documentVisible;
  const foreground = useRefreshStamp(active && paneVisible, 0);
  const capturedDetails = useRef<boolean | null>(null);
  const savedDetails = usePaneVisitData(DETAILS, () => capturedDetails.current);
  const [expanded, setExpanded] = useState(savedDetails ?? false);
  capturedDetails.current = expanded;
  const detailId = useId();
  const detailsButton = useRef<HTMLButtonElement>(null);
  const detailPanel = useRef<HTMLDivElement>(null);
  const { ctx } = useActionRuntime();
  const state = params.get("state") ?? "all";
  const sort = params.get("sort") ?? "newest";
  const consumption = useChangeStamp("Consumption");
  const seenConsumption = useRef(consumption);
  if (observing) seenConsumption.current = consumption;
  const entries = useChangeStamp("Entries", "Metadata");
  const queryRevision = useMediaQueryRevision();
  const head = useServerValue<PodcastDetail>({
    key: `podcast-head:${podcastId}`,
    stale: `${useChangeStamp("Podcasts")}:${entries}:${queryRevision}:${seenConsumption.current}:${foreground}`,
    visit: HEAD,
    load: signal => getPodcastDetail(podcastId, signal),
  });
  const ready = head.status === "ready" ? head : null;
  const destinations = ready?.data.destinations ?? [];
  const following = destinations.length > 0;
  const history = ready?.data.imports ?? [];
  const recurring = ready?.data.recurring;
  const sourceRevision = JSON.stringify([recurring?.last_checked_at, history.map(operation => [operation.id, operation.updated_at])]);
  const query = new URLSearchParams({ state, sort }).toString();
  const episodes = useServerList<PodcastEpisodeRow>({
    key: ready === null ? null : `/podcasts/${podcastId}/episodes?${query}`,
    stale: `${sourceRevision}:${entries}:${queryRevision}:${useChangeStamp("PodcastEpisodes")}:${state === "all" ? "-" : consumption}`,
    pageSize: 100,
    active: observing,
    visit: EPISODES,
    id: (episode) => episode.id,
    fetchPage: (cursor, limit, signal) =>
      listEpisodes(podcastId, pageQuery(query, cursor, limit), signal),
  });
  const loaded = episodes.status === "ready" ? episodes.items : null;
  const summaries = useMediaSummaries(
    (loaded ?? []).map((episode) => episode.media_summary),
  );
  const transcriptSignature = episodes.current && episodes.status === "ready" && episodes.failure === null
    ? JSON.stringify(episodes.items.map(episode => [episode.id, episode.transcript_state] as const).sort((a, b) => a[0].localeCompare(b[0])))
    : null;
  const observedTranscripts = useRef<string | null>(null);
  const retrySummaries = summaries.retry;
  useEffect(() => {
    if (transcriptSignature === null || observedTranscripts.current === transcriptSignature) return;
    observedTranscripts.current = transcriptSignature;
    retrySummaries();
  }, [transcriptSignature, retrySummaries]);
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

  const working = history.some(operation => operation.state === "pending" || operation.state === "running") || recurring?.state === "pending" || recurring?.state === "running";
  // justify-polling: podcast publication has no push stream. The existing visible
  // pane owner revalidates quickly during work, otherwise on its settled cadence.
  useIntervalPoll({ enabled: observing && (following || working), pollIntervalMs: working ? 3000 : HEAD_POLL_INTERVAL_MS,
    onPoll: () => { if (head.status === "ready" && !head.refreshing) head.refetch(); },
  });
  const observedPublication = useRef<string | null>(null);
  useEffect(() => {
    if (ready === null || observedPublication.current === sourceRevision) return;
    const previous = observedPublication.current; observedPublication.current = sourceRevision;
    if (previous !== null) publishChange("Entries");
  }, [ready, sourceRevision]);

  // justify-polling: transcript provisioning has no push stream here; the
  // queued or running episodes end the schedule.
  useIntervalPoll({
    enabled:
      observing &&
      (loaded ?? []).some((episode) =>
        shouldPollTranscriptProvisioning(episode.transcript_state),
      ),
    pollIntervalMs: 3000,
    // a failed reread shows as the list's failure
    onPoll: episodes.revalidate,
  });

  const command = useCommand();
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
      router.replace(viewHref(`/podcasts/${podcastId}`, params, changes)),
    [params, podcastId, router],
  );
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const playbackChoices = STATES.some((choice) => choice.value === state) ? STATES : [...STATES, { value: state, label: state }];
  const sortChoices = SORTS.some((choice) => choice.value === sort) ? SORTS : [...SORTS, { value: sort, label: "Unsupported order" }];
  const chips = state === "all" ? [] : [{ id: "state", label: `Playback: ${playbackChoices.find((choice) => choice.value === state)?.label}` }];
  const canReset = sort !== "newest" || chips.length > 0;
  const headerMeta: PaneHeaderMeta = ready !== null
    ? { kind: "Count", value: destinations.length, unit: "destination" }
    : head.status === "loading" ? { kind: "Pending" } : { kind: "None" };
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
  const text = filterRows.query.trim();
  const known = STATES.find(option => option.value === state)?.value;
  const podcast = ready?.data.podcast;
  const pending = ctx.podcastEpisodes.pending(podcastId);
  const sessionSignal = ctx.sessionSignal();
  const preparationLifetime = useRef<{ controller: AbortController; busy: boolean; state: string; text: string; observing: boolean; accountId: string } | null>(null);
  const [preparation, setPreparation] = useState<{ signal: AbortSignal; content: FeedbackContent; checking: boolean } | null>(null);
  const fail = useThrowLater();
  // This component is keyed by pane visit and show. Sort never changes selection.
  useLayoutEffect(() => {
    const lifetime = { controller: new AbortController(), busy: false, state, text, observing, accountId: ctx.accountId };
    preparationLifetime.current = lifetime;
    setPreparation(null);
    const retire = () => lifetime.controller.abort();
    sessionSignal.addEventListener("abort", retire);
    return () => {
      retire();
      sessionSignal.removeEventListener("abort", retire);
      if (preparationLifetime.current === lifetime) preparationLifetime.current = null;
    };
  }, [ctx.accountId, sessionSignal, podcastId, state, text, observing]);
  const unavailable = pending !== null ? "resolve the pending episode action first."
    : text !== "" ? "clear the text filter to use episode-wide actions."
    : head.status === "failed" || (episodes.failure !== null && episodes.failure.op !== "More") ? "retry loading this view first."
    : ready === null || known === undefined || !episodes.current ? "wait for the selected episode view to load."
    : episodes.complete && episodes.items.length === 0 ? "no episodes in this selection."
    : preparation?.checking ? "checking selected episodes…" : undefined;
  const scope = known === "all" || known === undefined ? "" : ` ${known === "in_progress" ? "in-progress" : known}`;
  const scopeLabel = `all${scope} episodes`;
  const prepare = async (desired: "played" | "unplayed" | "transcripts") => {
    const lifetime = preparationLifetime.current;
    if (unavailable !== undefined || !observing || podcast === undefined || known === undefined || lifetime === null || lifetime.busy || lifetime.state !== state || lifetime.text !== text || lifetime.observing !== observing || lifetime.accountId !== ctx.accountId) return;
    const signal = lifetime.controller.signal;
    const current = () => preparationLifetime.current === lifetime && !signal.aborted && !sessionSignal.aborted && ctx.isActive() && document.visibilityState === "visible";
    if (!current() || ctx.podcastEpisodes.pending(podcastId) !== null) return;
    lifetime.busy = true;
    setPreparation({ signal, checking: true, content: { tone: "Neutral", title: "checking selected episodes…" } });
    try {
      if (desired === "transcripts") {
        const forecast = await forecastEpisodeTranscripts(podcastId, known, signal);
        if (!current() || ctx.podcastEpisodes.pending(podcastId) !== null) return;
        if (forecast.eligible_count === 0) {
          setPreparation({ signal, checking: false, content: { tone: "Neutral", title: "no eligible episodes to transcribe." } });
          return;
        }
        const count = forecast.eligible_count;
        if (!window.confirm(`transcribe ${count} eligible ${count === 1 ? "episode" : "episodes"} from “${podcast.title}”?\n\nselection: ${scopeLabel}, including any episodes not loaded in this pane.`)) return;
        if (!current()) return;
        ctx.podcastEpisodes.submit({ podcastId, title: podcast.title, scopeLabel, command: {
          kind: "Transcripts", body: { target: { kind: "PodcastEpisodeQuery", podcast_id: podcastId, selection: { state: known }, reason: "search" }, selection_fingerprint: forecast.selection_fingerprint },
        } });
      } else {
        const prepared = await prepareEpisodeConsumption(podcastId, known, signal);
        if (!current() || ctx.podcastEpisodes.pending(podcastId) !== null) return;
        if (prepared.items.length === 0) {
          setPreparation({ signal, checking: false, content: { tone: "Neutral", title: "no episodes in this selection." } });
          return;
        }
        const count = prepared.items.length;
        if (!window.confirm(`mark ${count} ${count === 1 ? "episode" : "episodes"} from “${podcast.title}” as ${desired}?\n\nselection: ${scopeLabel}, including any episodes not loaded in this pane. listening positions and history are kept. selected playback pauses while progress is saved.`)) return;
        if (!current()) return;
        ctx.podcastEpisodes.submit({ podcastId, title: podcast.title, scopeLabel, command: { kind: "Consumption", body: { desired_state: desired, items: prepared.items } } });
      }
    } catch (error) {
      if (!current()) return;
      const modeled = modeledApiError(error, fail);
      if (modeled !== null) setPreparation({ signal, checking: false, content: podcastErrorMessage(modeled, "selected episodes couldn’t be checked") });
    } finally {
      lifetime.busy = false;
      if (current()) setPreparation(value => value?.signal === signal && value.checking ? null : value);
    }
  };
  const bulkActions: readonly ActionDescriptor[] = (["played", "unplayed", "transcripts"] as const).map(target => {
    const reason = unavailable ?? (target === known ? `these episodes are already ${target}.` : undefined);
    return { kind: "command", id: target === "transcripts" ? "transcribe-episodes" : `mark-all-${target}`,
      label: target === "transcripts" ? `transcribe all${scope} episodes` : `mark all${scope} episodes as ${target}`,
      disabled: reason !== undefined, disabledReason: reason, onSelect: () => { void prepare(target); } };
  });
  usePaneChrome({
    menuActions: bulkActions,
    // Only a subscription refreshes; until the head loads that is unknown.
    refresh:
      following
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
  usePaneReturnReady(
    head.status === "failed" ||
      (ready !== null && episodes.status !== "loading"),
  );

  const visible = resolved.filter((episode) =>
    matchesPaneFilterQuery(text, mediaListFilterFields(episode.media_summary)),
  );
  const checkAgain = () => command.run("the episode check wasn’t confirmed", async () => {
    await requestPodcastRefresh({ kind: "Podcast", podcast_id: podcastId });
  });
  return (
    <PaneSurface>
        {head.status === "loading" ? (
          <PaneLoadingState label="Loading podcast…" announcement="Polite" />
        ) : null}
        {ready && podcast ? (
          <PaneSection className={styles.overview}>
            <div className={styles.identity}>
              <PodcastArtwork title={podcast.title} image={podcast.image_url !== null ? { kind: "Remote", url: podcast.image_url } : { kind: "Absent" }} size={56} className={styles.artwork} />
              <div className={styles.identityCopy}>
                <ContributorCreditList credits={selectMediaAuthors(podcast.contributors)} />
                <p className={styles.counts}>
                  {ready.data.episode_counts.available_count === 0 ? "0 available" : `${ready.data.episode_counts.unfinished_count} unfinished · ${ready.data.episode_counts.available_count} available`}
                </p>
              </div>
              <Button ref={detailsButton} className={styles.detailButton}
                aria-expanded={expanded} aria-controls={detailId}
                onClick={() => {
                  if (expanded && detailPanel.current?.contains(document.activeElement)) detailsButton.current?.focus();
                  setExpanded(!expanded);
                }}>details</Button>
            </div>
            <div id={detailId} ref={detailPanel} hidden={!expanded}>
              {expanded ? <div className={styles.detailContent}>
                <p>{podcast.description?.trim() || "no description from the publisher."}</p>
                <ContributorRoleGroups credits={podcast.contributors.filter(credit => credit.role !== "author")} />
                <div className={styles.detailLinks}>
                  {podcast.website_url !== null ? <a href={podcast.website_url} target="_blank" rel="noopener noreferrer">website</a> : null}
                  <a href={podcast.feed_url} target="_blank" rel="noopener noreferrer">rss feed</a>
                </div>
                <div className={styles.playbackDefaults}>
                  <span>playback defaults · {formatPlaybackRate(ready.data.playback_settings.default_playback_speed ?? 1)} · skip silence on android: {ready.data.playback_settings.pause_shortening_mode === "Natural" ? "on" : "off"}</span>
                  <Button className={styles.detailButton} onClick={() => ctx.overlays.open({ kind: "PodcastSettings", podcastId })}>edit…</Button>
                </div>
              </div> : null}
            </div>
          </PaneSection>
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
        {ready && podcast ? <PaneSection title="automatic additions">
          {destinations.length > 0 ? <ul>{destinations.map(destination => <li key={destination.library_id}>
            <a href={`/libraries/${destination.library_id}`}>{destination.is_default ? "all" : destination.name}</a>
            {!destination.is_default ? <Button onClick={() => ctx.overlays.open({ kind: "StopPodcast", podcastId, title: podcast.title, libraryId: destination.library_id, episodes: "keep" })}>stop adding…</Button> : null}
          </li>)}</ul> : <p>no ongoing subscription.</p>}
          <Button onClick={() => ctx.overlays.open({ kind: "AddPodcast", target: { kind: "Canonical", podcast_id: podcastId }, title: podcast.title, libraryId: params.get("library_id") })}>add podcast…</Button>
          <PodcastDestinationPicker podcastId={podcastId} title={podcast.title} />
          {following ? <Button onClick={() => ctx.overlays.open({ kind: "StopPodcast", podcastId, title: podcast.title, libraryId: null, episodes: "keep" })}>stop everywhere…</Button>
            : ready.data.episode_counts.available_count > 0 ? <Button tone="danger" onClick={() => ctx.overlays.open({ kind: "StopPodcast", podcastId, title: podcast.title, libraryId: null, episodes: "remove", removeOnly: true })}>remove episodes everywhere…</Button> : null}
          {recurring?.error_code !== null && recurring?.error_code !== undefined || recurring?.had_coverage_gaps ? <FeedbackNotice content={{ tone: "Warning", title: "the last check could not load all available episodes.", message: "nexus will try again automatically." }} announcement="Polite" actions={[{ label: "check again", onClick: checkAgain, busy: command.running !== null }]} /> : null}
          {history.map(operation => <PodcastImportProgress key={operation.id} operation={operation} title={podcast.title} following={destinations.some(destination => destination.library_id === operation.library_id)} />)}
        </PaneSection> : null}
      {preparation !== null && preparation.signal === preparationLifetime.current?.controller.signal ? (
        preparation.checking ? <FeedbackStatus content={preparation.content} announcement="Polite" /> : <FeedbackNotice content={preparation.content} announcement="Polite" />
      ) : null}
      {command.failure ? <FeedbackNotice content={command.failure} announcement="Assertive" /> : null}
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
          <CollectionView
            surface={false}
            returnScope="PodcastDetail.Episodes"
            rows={visible.map(episode => presentMedia(episode.media_summary, {
              id: episode.id, primary: { kind: "link", href: `/media/${episode.id}` },
              resourceRef: canonicalResourceRef({ scheme: "media", id: episode.id }), selected: false,
            }))}
            status={episodes.status === "loading" ? "loading" : "ready"}
            ariaLabel="Episodes"
            rowActionsAvailable={episodes.current}
            collectionBusy={!episodes.current || !episodes.complete}
            rowChangePresentation={{ kind: "ImmediateOnKeyChange", key: text }}
            notice={<>
              {episodes.status === "ready" && episodes.failure !== null && episodes.failure.op !== "More" ? <FeedbackNotice
                content={podcastErrorMessage(episodes.failure.error, "episodes couldn’t be refreshed")}
                announcement="Polite" actions={[{ label: "retry", onClick: episodes.retry, busy: episodes.running !== null }]} /> : null}
              <MediaSummaryNotice error={summaries.error} retry={summaries.retry} busy={summaries.retrying} />
            </>}
            footer={<CollectionExhaustionNotice list={episodes} unit={{ singular: "episode", plural: "episodes" }} returnFocus={() => inputRef.current} />}
            empty={episodes.status === "loading" ? null : <FeedbackNotice content={{ tone: "Neutral", title:
              text !== "" ? episodes.complete ? "no episodes match this filter." : "no matching episode found so far."
              : !episodes.current ? "loading selected episodes…"
              : !episodes.complete ? "no episodes loaded so far."
              : known === "all" ? history.some(operation => operation.state === "pending" || operation.state === "running") && ready.data.episode_counts.available_count === 0 ? "loading episode history…" : "no episodes available."
              : `no ${known === "in_progress" ? "in-progress" : known} episodes.`,
            }} announcement="None" />}
          />
        )}
    </PaneSurface>
  );
}
