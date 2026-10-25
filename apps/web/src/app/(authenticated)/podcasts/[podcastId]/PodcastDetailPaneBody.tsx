"use client";

// One show: detail and its complete ordered episodes share one observation.
// One visible polling lane refreshes publication, lifecycle and transcript facts.
// Reviewed commands belong to the account owner. Observation stops outside
// the visible pane.

import { useCallback, useId, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { PlaybackSourceContext, captureSavedView, capturePlaybackSource } from "@/lib/actions/playbackSource";
import CollectionView from "@/components/collections/CollectionView";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import { presentMedia } from "@/lib/collections/presenters/media";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";
import type { CollectionRowView } from "@/lib/collections/types";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { projectCollectionConsumptionAction, projectPodcastTranscriptAction, projectPodcastLibrariesAction, projectPodcastLibraryRemovalAction } from "@/lib/actions/project";
import { findPaneCollectionRowFocusTarget, findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import PodcastImportProgress from "@/components/podcasts/PodcastImportProgress";
import PodcastArtwork from "@/components/podcasts/PodcastArtwork";
import { ContributorCreditList, ContributorRoleGroups } from "@/components/contributors/ContributorCredits";
import { selectMediaAuthors } from "@/lib/contributors/credits";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { viewHref } from "@/lib/collections/view";
import PaneQueryToolbar from "@/components/workspace/PaneQueryToolbar";
import PaneFilterRowsStatus from "@/components/workspace/PaneFilterRowsStatus";
import RadioGroup from "@/components/ui/RadioGroup";
import Button from "@/components/ui/Button";
import PaneSurface from "@/components/ui/PaneSurface";
import PaneSection from "@/components/ui/PaneSection";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneQueryInput } from "@/components/workspace/usePaneQueryInput";
import { useResourceInspector } from "@/components/resource-inspector/useResourceInspector";
import {
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
  usePaneFilterRows,
} from "@/lib/panes/paneFilterRows";
import { formatPlaybackRate } from "@/lib/player/playbackRate";
import {
  listEpisodes,
  requestPodcastRefresh,
  type EpisodeState,
  type PodcastDetail,
} from "@/lib/podcasts/api";
import { publishChange } from "@/lib/api/changes";
import { useCatalogRead, useCatalogState, usePromoteLiveGroup } from "@/lib/catalog/provider";
import { unstamped } from "@/lib/consumption/listening";
import { catalogEpisodes } from "@/lib/catalog/selectors";
import { remoteReady } from "@/lib/native/admission";
import { ApiError, isApiError } from "@/lib/api/client";
import { useServerValue, type Visit, type ServerValue } from "@/lib/api/serverState";
import { indexRowStatus, indexReading } from "@/lib/panes/indexRows";
import { usePodcastEpisodesRead } from "@/lib/panes/indexPaneEntry";
import { LIVE_SOURCE } from "@/lib/catalog/types";
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
  usePaneVisitDataWriter,
} from "@/lib/workspace/paneReturnMemento";
import styles from "./page.module.css";

const CHECKED = definePaneVisitDataKey<boolean>("PodcastDetail.SourceCheck");
const DETAILS = definePaneVisitDataKey<boolean>("PodcastDetail.Details");
const EPISODES = definePaneVisitDataKey<Visit<Awaited<ReturnType<typeof listEpisodes>>>>("PodcastDetail.Episodes");
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
  const capturedDetails = useRef<boolean | null>(null);
  const savedDetails = usePaneVisitData(DETAILS, () => capturedDetails.current);
  const [expanded, setExpanded] = useState(savedDetails ?? false);
  capturedDetails.current = expanded;
  const detailId = useId();
  const detailsButton = useRef<HTMLButtonElement>(null);
  const detailPanel = useRef<HTMLDivElement>(null);
  const { ctx, run } = useActionRuntime();
  const librariesCard = useRef<HTMLElement>(null);
  const state = params.get("state") ?? "all";
  const sort = params.get("sort") ?? "newest";
  const catalog = useCatalogState();
  const query = new URLSearchParams({ state, sort }).toString();
  const { read: descriptor, group } = usePodcastEpisodesRead();
  const savedRead = useCatalogRead(value => {
    const data = catalogEpisodes(value, podcastId, new URLSearchParams(query));
    return data === null ? null : { data, consumption_revision: value.value.consumption_revision };
  });
  const raw = useServerValue({ ...descriptor, catalog: savedRead, visit: EPISODES });
  const showEpisodes = useMemo(() => new Set(catalog.raw?.value.episodes.flatMap(row => row.podcast_id === podcastId ? [row.media_id] : []) ?? []), [catalog.raw, podcastId]);
  usePromoteLiveGroup(group, raw.status === "ready" && raw.source.kind === "live" && raw.error === null && raw.fresh
    ? [raw.data.consumption_revision] : null, showEpisodes);
  const saved = useMemo(() => {
    if (catalog.data === null) return null;
    try {
      const data = catalogEpisodes(catalog.data, podcastId, new URLSearchParams(query));
      return data === null ? null : { data: { data, consumption_revision: catalog.data.value.consumption_revision },
        source: { kind: "catalog" as const, snapshot_id: catalog.data.value.snapshot_id, captured_at: catalog.data.value.captured_at } };
    } catch (error) { if (isApiError(error)) return null; throw error; }
  }, [catalog.data, podcastId, query]);
  const snapshot: typeof raw = group.live || saved === null ? raw : {
    ...raw, status: "ready", data: saved.data, source: saved.source, fresh: false, acceptedStale: null, generation: 0,
    error: raw.status === "loading" ? null : raw.error, refreshing: indexReading(raw),
  };
  const episodes = unstamped(snapshot);
  const episodeItems = episodes.status === "ready" ? episodes.data.items : [];
  const source = episodes.status === "ready" ? episodes.source : LIVE_SOURCE;
  const episodeFailure = episodes.status === "loading" ? null : episodes.error;
  const busy = indexReading(episodes);
  const retry = () => { void episodes.refetch().catch(() => {}); };
  const head: ServerValue<PodcastDetail> = episodes.status === "ready" ? { ...episodes, data: episodes.data.podcast } : episodes;
  const live = source.kind === "live";
  const headError = head.status === "loading" ? null : head.error;
  const ready = head.status === "ready" ? head : null;
  const destinations = ready?.data.destinations ?? [];
  const namedDestinations = destinations.filter(destination => !destination.is_default);
  const libraryRows: CollectionRowView[] = namedDestinations.map(destination => ({
    id: destination.library_id, kind: "library", presentation: "Index",
    primary: { kind: "link", href: `/libraries/${destination.library_id}`, paneLabelHint: libraryDisplayName(destination) },
    title: { text: libraryDisplayName(destination) }, contributors: [], publicationDate: null,
    context: null, activity: null, exceptionalStatus: null,
    resourceRef: canonicalResourceRef({ scheme: "library", id: destination.library_id }), selected: false,
  }));
  const following = destinations.length > 0;
  const history = ready?.data.imports ?? [];
  const recurring = ready?.data.recurring;
  const loaded = episodes.status === "ready" ? episodeItems : null;
  const summaries = useMediaSummaries(
    (loaded ?? []).map((episode) => episode.media_summary), source,
  );
  const transcriptSignature = live && episodes.status === "ready" && episodeFailure === null
    ? JSON.stringify(episodeItems.map(episode => [episode.id, episode.transcript_state] as const).sort((a, b) => a[0].localeCompare(b[0])))
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
  const provisioning = episodeItems.some(episode => shouldPollTranscriptProvisioning(episode.transcript_state));
  // justify-polling: one visible observation lane owns header and episode publication.
  useIntervalPoll({ enabled: live && remoteReady() && observing && (following || working || provisioning),
    pollIntervalMs: working || provisioning ? 3000 : HEAD_POLL_INTERVAL_MS, onPoll: episodes.revalidate });
  const publicationKey = `${ctx.accountId}:${descriptor.key}`;
  const publicationData = raw.status === "ready" && raw.source.kind === "live" && raw.error === null && raw.fresh ? raw.data.data : null;
  const publication = useMemo(() => publicationData === null ? null : JSON.stringify([
    publicationData.items.map(episode => [episode.id, episode.transcript_state]),
    publicationData.podcast.recurring.last_checked_at,
    publicationData.podcast.imports.map(operation => [operation.id, operation.updated_at]).sort((a, b) => a[0].localeCompare(b[0])),
  ]), [publicationData]);
  const observedPublication = useRef<{ key: string; signature: string } | null>(null);
  useEffect(() => {
    if (observedPublication.current?.key !== publicationKey) observedPublication.current = null;
    if (publication === null) return;
    const previous = observedPublication.current;
    observedPublication.current = { key: publicationKey, signature: publication };
    if (previous !== null && previous.signature !== publication) publishChange("Entries");
  }, [publication, publicationKey]);

  const command = useCommand();
  const checked = useRef(false);
  const savedCheck = usePaneVisitData(CHECKED, () => checked.current);
  if (savedCheck === true) checked.current = true;
  const retainCheck = usePaneVisitDataWriter(CHECKED);
  const canCheckSource = observing && live && remoteReady() && ctx.online && head.status === "ready" && head.error === null && !head.refreshing && !following;
  const runCheck = command.run;
  useEffect(() => {
    if (checked.current || !canCheckSource) return;
    checked.current = true;
    retainCheck(true);
    runCheck("the episode check wasn’t confirmed", async () => {
      await requestPodcastRefresh({ kind: "Podcast", podcast_id: podcastId }, ctx.sessionSignal());
    });
  }, [canCheckSource, ctx, podcastId, retainCheck, runCheck]);
  const filterRows = usePaneFilterRows({
    sourceKey: `PodcastDetail.Episodes:${podcastId}`,
    getRowStatus: (text) => {
      const visible = resolved.filter(episode => matchesPaneFilterQuery(text, mediaListFilterFields(episode.media_summary)));
      return indexRowStatus(episodes, resolved.length, visible.length, { singular: "episode", plural: "episodes" });
    },
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
        visible: false,
        content: <PaneFilterRowsStatus announceQueryChanges={(episodes.status === "ready") && episodeFailure === null} id={queryStatusId} status={filterRows.rowStatus} query={filterRows.query} />,
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
    handle: ready !== null && headError?.status !== 404 && headError?.status !== 403 ? podcastId : null,
    bodies: { linkedItems: connections },
  });
  const text = filterRows.query.trim();
  const known = STATES.find(option => option.value === state)?.value;
  const podcast = ready?.data.podcast;
  const paneFallback = () => findPaneLandmarkFocusTarget(librariesCard.current?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId);
  const blocked = !live || !remoteReady() || head.status !== "ready" || head.error !== null || head.refreshing || !head.fresh
    ? "TemporarilyUnavailable" : null;
  const bulkActions = known === undefined || known === "all" || podcast === undefined ? [] : [
    projectCollectionConsumptionAction({ selection: { kind: "Podcast", podcast_id: podcastId, state: known }, desiredState: "finished", title: podcast.title, blocked, ctx, run, returnFocus: paneFallback }),
    projectCollectionConsumptionAction({ selection: { kind: "Podcast", podcast_id: podcastId, state: known }, desiredState: "unread", title: podcast.title, blocked, ctx, run, returnFocus: paneFallback }),
    projectPodcastTranscriptAction({ podcastId, title: podcast.title, state: known, blocked, ctx, run, returnFocus: paneFallback }),
  ];
  const librariesAction = podcast === undefined ? null : projectPodcastLibrariesAction({ target: { kind: "Canonical", podcast_id: podcastId }, title: podcast.title, disabledReason: blocked === null ? null : "requires a connection and current podcast facts.", ctx, run,
    focus: { trigger: null, returnFocus: () => librariesCard.current?.querySelector<HTMLButtonElement>("header button") ?? librariesCard.current ?? paneFallback(), afterRemoval: paneFallback },
  });
  usePaneChrome({
    displayTitle: podcast?.title,
    menuActions: bulkActions,
    resourceActions: !live || !remoteReady() || podcast === undefined ? undefined : { kind: "Podcast", subject: {
      target: { kind: "Canonical", podcast_id: podcastId }, title: podcast.title,
      facts: headError !== null
        ? { kind: "Failed", observedSubscribed: ready?.source.kind === "live" ? following : null, error: headError, retry: head.refetch, retrying: head.status === "failed" ? head.retrying : head.status === "ready" && head.refreshing }
        : head.status !== "ready" || head.refreshing || !head.fresh
          ? { kind: "Resolving", observedSubscribed: ready?.source.kind === "live" ? following : null } : { kind: "Ready", resolution: { kind: "Canonical", podcast_id: podcastId, subscribed: following } },
    } },
    refresh:
      live && remoteReady() && head.status === "ready"
        ? {
            kind: "Refreshable",
            sourceKey: `Podcast.Detail:${podcastId}`,
            execute,
          }
        : head.status === "loading"
          ? { kind: "Resolving" }
          : undefined,
    resourceRef: canonicalResourceRef({ scheme: "podcast", id: podcastId }),
    header: { kind: "Section", meta: { kind: "None" } },
    query: queryControls,
  });
  usePaneReturnReady(
    head.status === "failed" ||
      (ready !== null && episodes.status !== "loading"),
  );

  const visible = resolved.filter((episode) =>
    matchesPaneFilterQuery(text, mediaListFilterFields(episode.media_summary)),
  );
  const emptyTitle = text !== ""
    ? "no episodes match this filter."
    : known === "all"
        ? "no episodes found"
        : `no ${known === "in_progress" ? "in-progress" : known} episodes.`;
  const readFeedback = useIndexReadFeedback({
    value: episodes, requestedKey: descriptor.key, active, unit: { singular: "episode", plural: "episodes" },
    waiting: known !== undefined && episodes.status === "loading",
    outcome: visible.length > 0 ? "results updated." : emptyTitle,
    returnFocus: () => inputRef.current,
  });
  const checkAgain = () => command.run("the episode check wasn’t confirmed", async () => {
    await requestPodcastRefresh({ kind: "Podcast", podcast_id: podcastId });
  });
  return (
    <>
      {readFeedback.announcement}
      <PaneSurface>
          {head.status === "loading" ? (
            <PaneLoadingState label="loading episodes…" announcement="Polite" />
          ) : null}
          {ready && podcast ? (
            <PaneSection className={styles.overview}>
              <div className={styles.identity}>
                <PodcastArtwork title={podcast.title} image={podcast.image_url !== null ? { kind: "Remote", url: podcast.image_url } : { kind: "Absent" }} size={56} className={styles.artwork} />
                <div className={styles.identityCopy}>
                  <ContributorCreditList credits={selectMediaAuthors(podcast.contributors)} />
                  <p className={styles.counts}>
                    {ready.data.episode_counts.known_count} episodes
                  </p>
                </div>
                <Button ref={detailsButton} className={styles.detailButton}
                  icon={expanded ? <ChevronDown /> : <ChevronRight />}
                  aria-expanded={expanded} aria-controls={detailId}
                  onClick={() => {
                    if (expanded && detailPanel.current?.contains(document.activeElement)) detailsButton.current?.focus();
                    setExpanded(!expanded);
                  }}>{expanded ? "show less" : "show more"}</Button>
              </div>
              <div id={detailId} ref={detailPanel} hidden={!expanded}>
                {expanded ? <div className={styles.detailContent}>
                  <p className={styles.description}>{podcast.description?.trim() || "no description from the publisher."}</p>
                  <ContributorRoleGroups credits={podcast.contributors} />
                  <div className={styles.detailLinks}>
                    {podcast.website_url !== null ? <a href={podcast.website_url} target="_blank" rel="noopener noreferrer">website</a> : null}
                    <a href={podcast.feed_url} target="_blank" rel="noopener noreferrer">rss feed</a>
                  </div>
                  <div className={styles.playbackDefaults}>
                    <span>playback defaults · {formatPlaybackRate(ready.data.playback_settings.default_playback_speed ?? 1)} · skip silence on android: {ready.data.playback_settings.pause_shortening_mode === "Natural" ? "on" : "off"}</span>
                    {live && remoteReady() ? <Button className={styles.detailButton} onClick={() => ctx.overlays.open({ kind: "PodcastSettings", podcastId })}>edit…</Button> : <span>at last catalog save</span>}
                  </div>
                </div> : null}
              </div>
            </PaneSection>
          ) : null}
          {ready && podcast ? <PaneSection ref={librariesCard} title="Library Subscriptions" aria-label="Library Subscriptions" tabIndex={-1}
            actions={librariesAction ? <Button iconOnly icon={librariesAction.icon} aria-label={`add to library: ${podcast.title}`}
              aria-haspopup="dialog" aria-disabled={librariesAction.disabled}
              tooltip={{ text: `add to library: ${podcast.title}${librariesAction.disabledReason ? `: ${librariesAction.disabledReason}` : ""}` }}
              onClick={event => { if (librariesAction.disabled) return; const detail = prepareActionSelect(event, event.currentTarget); if (detail) librariesAction.onSelect(detail); }} /> : null}>
            {libraryRows.length > 0 ? <CollectionView surface={false} returnScope={`PodcastDetail.Libraries:${podcastId}`} ariaLabel="subscription libraries" status="ready"
              rows={libraryRows}
              rowControls={live && remoteReady() ? Object.fromEntries(namedDestinations.map(destination => {
                const focus = {
                  trigger: null,
                  returnFocus: () => librariesCard.current?.querySelector<HTMLButtonElement>("header button") ?? librariesCard.current,
                  get afterRemoval() {
                    const paneId = librariesCard.current?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
                    const rows = Array.from(librariesCard.current?.querySelectorAll<HTMLElement>("[data-collection-row-id]") ?? []);
                    const after = rows.slice(rows.findIndex(item => item.dataset.collectionRowId === destination.library_id) + 1).map(item => item.dataset.collectionRowId!);
                    return () => after.map(id => findPaneCollectionRowFocusTarget(paneId, id)).find(target => target !== null)
                      ?? librariesCard.current?.querySelector<HTMLButtonElement>("header button")
                      ?? librariesCard.current ?? findPaneLandmarkFocusTarget(paneId);
                  },
                };
                const action = projectPodcastLibraryRemovalAction({
                  podcastId, title: podcast.title, libraryId: destination.library_id, libraryName: libraryDisplayName(destination),
                  canRemove: destination.can_add_content,
                  blocked: ready.error !== null || ready.refreshing || !ready.fresh ? "TemporarilyUnavailable" : null,
                  ctx, run, focus,
                });
                const reasonId = `${detailId}-library-${destination.library_id}`;
                return [destination.library_id, <span key={destination.library_id}>
                  <Button iconOnly icon={action.icon} aria-label={action.accessibleLabel} aria-haspopup="dialog"
                    aria-disabled={action.disabled} aria-describedby={action.disabledReason ? reasonId : undefined}
                    tooltip={{ text: action.disabledReason ? `${action.accessibleLabel}: ${action.disabledReason}` : action.accessibleLabel }}
                    onClick={event => { const detail = prepareActionSelect(event, event.currentTarget); if (detail) action.onSelect(detail); }} />
                  {action.disabledReason ? <span className="sr-only" id={reasonId}>{action.disabledReason}</span> : null}
                </span>];
              })) : undefined} /> : null}
          </PaneSection> : null}
          {live && ready && podcast && (history.length > 0 || command.running !== null || recurring?.state === "pending" || recurring?.state === "running" || recurring?.error_code !== null && recurring?.error_code !== undefined || recurring?.had_coverage_gaps) ? <PaneSection title="episode checks and additions">
            {command.running !== null || recurring?.state === "pending" || recurring?.state === "running" ? <p>checking for episodes…</p> : null}
            {recurring?.error_code !== null && recurring?.error_code !== undefined || recurring?.had_coverage_gaps ? <FeedbackNotice content={{ tone: "Warning", title: "the last check could not load all available episodes.", message: following ? "subscribed shows are checked automatically. you can retry now." : "retry this check to look for more episodes." }} announcement="Polite" actions={[{ label: "check for new episodes", onClick: checkAgain, busy: command.running !== null }]} /> : null}
            {history.map(operation => <PodcastImportProgress key={operation.id} operation={operation} title={podcast.title} />)}
          </PaneSection> : null}
        {command.failure ? <FeedbackNotice content={command.failure} announcement="Assertive" actions={[{ label: "retry episode check", onClick: checkAgain, busy: command.running !== null }]} /> : null}
          {episodes.status === "failed" && episodeFailure !== null ? (
            <FeedbackNotice
              content={podcastErrorMessage(
                episodeFailure,
                "couldn’t load episodes",
              )}
              announcement="Polite"
              actions={[
                episodeFailure.code === "E_INVALID_REQUEST"
                  ? {
                      label: "Reset view",
                      onClick: () => replaceView({ state: null, sort: null }),
                    }
                  : { label: "try again", onClick: retry, busy },
              ]}
            />
          ) : known === undefined || ready === null ? null : (
            <PlaybackSourceContext.Provider value={async selected_media_id => {
              const sourceSort = (["newest", "oldest", "duration_asc", "duration_desc"] as const).find(value => value === sort);
              if (sourceSort === undefined) throw new Error("invalid podcast queue sort");
              if (source.kind === "catalog")
                return captureSavedView(visible.map(episode => episode.media_summary), selected_media_id);
              if (!live || !remoteReady() || episodes.status !== "ready" || !episodes.fresh || episodes.error !== null || episodes.refreshing) throw new ApiError(503, "E_REMOTE_UNAVAILABLE", "requires a connection and current episode facts");
              return capturePlaybackSource({ source: { kind: "Podcast", podcast_id: podcastId, query: text, state: known, sort: sourceSort }, selected_media_id });
            }}>
            <PaneSection title="episodes">
            <CollectionView
              surface={false}
              returnScope="PodcastDetail.Episodes"
              rows={visible.map(episode => presentMedia(episode.media_summary, {
                id: episode.id, primary: { kind: "link", href: `/media/${episode.id}` },
                resourceRef: canonicalResourceRef({ scheme: "media", id: episode.id }), selected: false,
              }))}
              status={episodes.status === "loading" ? "loading" : "ready"}
              ariaLabel="Episodes"
              rowActionsAvailable={(episodes.status === "ready")}
              collectionBusy={busy}
              anchorKey={text}
              notice={<>
                {episodes.status === "ready" && episodeFailure !== null ? <FeedbackNotice
                  content={podcastErrorMessage(episodeFailure, "couldn’t refresh episodes")}
                  announcement="None" actions={[{ label: "try again", onClick: retry, busy }]} returnFocus={() => inputRef.current} /> : null}
                <MediaSummaryNotice error={summaries.error} retry={summaries.retry} busy={summaries.retrying} />
              </>}
              empty={<FeedbackNotice content={{ tone: "Neutral", title: emptyTitle }} announcement="None" />}
            />
            </PaneSection>
            </PlaybackSourceContext.Provider>
          )}
      </PaneSurface>
    </>
  );
}
