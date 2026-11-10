"use client";

// One source: detail and its ordered entry prefix share one observation.
// One visible polling lane refreshes publication, lifecycle and transcript facts.
// Reviewed commands belong to the account owner. Observation stops outside
// the visible pane.

import { useCallback, useId, useEffect, useMemo, useRef, useState } from "react";
import * as Icon from "@/lib/ui/icons";
import { PlaybackSourceContext, captureSavedView, capturePlaybackSource } from "@/lib/actions/playbackSource";
import CollectionView from "@/components/collections/CollectionView";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import { presentMedia } from "@/lib/collections/presenters/media";
import { prepareActionSelect } from "@/lib/ui/actionDescriptor";
import CollectionRow from "@/components/collections/CollectionRow";
import type { CollectionRowView } from "@/lib/collections/types";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import { projectCollectionConsumptionAction, projectPodcastTranscriptAction, projectFeedLibrariesAction, projectFeedLibraryRemovalAction } from "@/lib/actions/project";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useOutcome } from "@/components/feedback/Feedback";
import { Fact, Failed } from "@/components/feedback/Fact";
import { useActiveRegion } from "@/components/feedback/stage";
import { catalogLine } from "@/lib/catalog/copy";
import { Ruling } from "@/components/feedback/Ruling";
import FeedImportProgress from "@/components/feeds/FeedImportProgress";
import Artwork, { remoteArtwork } from "@/components/ui/Artwork";
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
  usePaneIsPresented,
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
import { pluralize } from "@/lib/text/pluralize";
import { listFeedEntries, requestFeedRefresh, type FeedDetail, type FeedEntryRow } from "@/lib/feeds/api";
import { type EntryState } from "@/lib/feeds/api";
import { publishChange } from "@/lib/api/changes";
import { useCatalogRead, useCatalogState, usePromoteLiveGroup } from "@/lib/catalog/provider";
import { unstamped } from "@/lib/consumption/listening";
import { catalogFeedEntries } from "@/lib/catalog/selectors";
import { remoteReady } from "@/lib/native/admission";
import { ApiError, isApiError } from "@/lib/api/client";
import { modeledApiError, useThrowLater, type ServerValue } from "@/lib/api/serverState";
import { useServerList, type ListSnapshot } from "@/lib/api/useServerList";
import { indexRowStatus, indexReading } from "@/lib/panes/indexRows";
import { useFeedEntriesRead } from "@/lib/panes/indexPaneEntry";
import { LIVE_SOURCE } from "@/lib/catalog/types";
import { feedRefresh } from "@/lib/feeds/paneState";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { PASSIVE_OBSERVATION_MS, WORK_OBSERVATION_MS } from "@/lib/api/observationPolicy";
import { useObservationDemand } from "@/lib/api/useObservationDemand";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
  usePaneVisitData,
  usePaneVisitDataWriter,
} from "@/lib/workspace/paneReturnMemento";
import styles from "./FeedDetail.module.css";

const CHECKED = definePaneVisitDataKey<boolean>("FeedDetail.SourceCheck");
const DETAILS = definePaneVisitDataKey<boolean>("FeedDetail.Details");
const EPISODES = definePaneVisitDataKey<ListSnapshot<FeedEntryRow, Awaited<ReturnType<typeof listFeedEntries>>>>("FeedDetail.Entries");
export default function FeedDetailPaneBody({ kind }: { readonly kind: "podcast" | "article" }) {
  const feedId = usePaneParam(kind === "podcast" ? "podcastId" : "feedId");
  const runtime = usePaneRuntime();
  if (feedId === null || runtime === null) throw new Error("source detail route requires its identity");
  return <FeedDetailPane key={`${runtime.visitId}:${feedId}`} feedId={feedId} kind={kind} />;
}

function FeedDetailPane({ feedId, kind }: { readonly feedId: string; readonly kind: "podcast" | "article" }) {
  const noun = kind === "podcast" ? "episodes" : "articles";
  const singular = kind === "podcast" ? "episode" : "article";
  const scheme = kind === "podcast" ? "podcast" : "feed";
  const href = `/${kind === "podcast" ? "podcasts" : "feeds"}/${feedId}`;
  const STATES: readonly { value: EntryState; label: string }[] = [{ value: "all", label: `All ${noun}` }, { value: "unread", label: kind === "podcast" ? "Unplayed" : "Unread" }, { value: "in_progress", label: "In progress" }, { value: "finished", label: kind === "podcast" ? "Played" : "Finished" }];
  const SORTS = [{ value: "newest", label: "Newest published" }, { value: "oldest", label: "Oldest published" }, ...(kind === "podcast" ? [{ value: "duration_asc", label: "Shortest duration" }, { value: "duration_desc", label: "Longest duration" }] : [])];
  const speak = useActiveRegion();
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const active = usePaneIsActive();
  const observing = useObservationDemand(usePaneIsPresented());
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
  const { read: descriptor, group } = useFeedEntriesRead();
  const savedRead = useCatalogRead(value => {
    const data = catalogFeedEntries(value, feedId, new URLSearchParams(query));
    return data === null ? null : { items: data.items, next_cursor: null, metadata: { data, consumption_revision: value.value.consumption_revision } };
  });
  const entryList = useServerList<FeedEntryRow, Awaited<ReturnType<typeof listFeedEntries>>>({
    key: descriptor.key, stale: descriptor.stale, catalog: savedRead, visit: EPISODES, active: observing, drain: false, pageSize: 100,
    id: row => row.id,
    fetchPage: async (cursor, limit, signal) => {
      const pageQuery = new URLSearchParams(query);
      pageQuery.set("limit", String(limit));
      if (cursor !== null) pageQuery.set("cursor", cursor);
      const page = await listFeedEntries(feedId, pageQuery, signal);
      return { items: page.data.items, next_cursor: page.data.next_cursor, metadata: page };
    },
  });
  const raw: ServerValue<Awaited<ReturnType<typeof listFeedEntries>>> = entryList.metadata !== null && entryList.current ? {
    status: "ready", data: { ...entryList.metadata, data: { ...entryList.metadata.data, items: [...entryList.items] } }, source: entryList.source,
    acceptedStale: entryList.shownStale, fresh: entryList.fresh, generation: 0,
    error: entryList.failure?.error ?? null, refreshing: entryList.running !== null, refetch: entryList.refetch, revalidate: entryList.revalidate,
  } : entryList.failure !== null ? { status: "failed", error: entryList.failure.error, retrying: entryList.running !== null, refetch: entryList.refetch, revalidate: entryList.revalidate }
    : { status: "loading", refetch: entryList.refetch, revalidate: entryList.revalidate };
  const showEpisodes = useMemo(() => new Set((catalog.raw === null ? [] : [...catalog.raw.value.episodes, ...catalog.raw.value.articles]).flatMap(row => row.feed_id === feedId ? [row.media_id] : []) ), [catalog.raw, feedId]);
  usePromoteLiveGroup(group, raw.status === "ready" && raw.source.kind === "live" && raw.error === null && raw.fresh
    ? [raw.data.consumption_revision] : null, showEpisodes);
  const saved = useMemo(() => {
    if (catalog.data === null) return null;
    try {
      const data = catalogFeedEntries(catalog.data, feedId, new URLSearchParams(query));
      return data === null ? null : { data: { data, consumption_revision: catalog.data.value.consumption_revision },
        source: { kind: "catalog" as const, snapshot_id: catalog.data.value.snapshot_id, captured_at: catalog.data.value.captured_at } };
    } catch (error) { if (isApiError(error)) return null; throw error; }
  }, [catalog.data, feedId, query]);
  const snapshot: typeof raw = group.live || saved === null ? raw : {
    ...raw, status: "ready", data: saved.data, source: saved.source, fresh: false, acceptedStale: null, generation: 0,
    error: raw.status === "loading" ? null : raw.error, refreshing: indexReading(raw),
  };
  const episodes = unstamped(snapshot);
  const episodeItems = episodes.status === "ready" ? episodes.data.items : [];
  const source = episodes.status === "ready" ? episodes.source : LIVE_SOURCE;
  const episodeFailure = episodes.status === "loading" ? null : episodes.error;
  const catalogFailure = episodeFailure === null ? null : catalogLine(episodeFailure);
  const busy = indexReading(episodes);
  const retry = () => { void episodes.refetch().catch(() => {}); };
  const head: ServerValue<FeedDetail> = episodes.status === "ready" ? { ...episodes, data: episodes.data.feed } : episodes;
  const live = source.kind === "live";
  const headError = head.status === "loading" ? null : head.error;
  const ready = head.status === "ready" && head.data.feed.kind === kind ? head : null;
  const resolvedKind = head.status === "ready" ? head.data.feed.kind : null;
  useEffect(() => {
    if (resolvedKind !== null && resolvedKind !== kind) router.replace(`/${resolvedKind === "podcast" ? "podcasts" : "feeds"}/${feedId}`);
  }, [resolvedKind, kind, feedId, router]);
  const destinations = ready?.data.destinations ?? [];
  const namedDestinations = destinations.filter(destination => !destination.is_default);
  const namedById = new Map(namedDestinations.map(destination => [destination.library_id, destination]));
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
  const matching = (text: string) => resolved.filter(episode =>
    matchesPaneFilterQuery(text, mediaListFilterFields(episode.media_summary, { containingPodcastId: kind === "podcast" ? feedId : undefined })));

  const working = history.some(operation => operation.work_in_flight) || recurring?.work_in_flight === true || recurring?.history.work_in_flight === true;
  const provisioning = episodeItems.some(episode => episode.media_summary.processing_status !== "suspended" && episode.transcript_state !== null && shouldPollTranscriptProvisioning(episode.transcript_state));
  // justify-polling: one visible observation lane owns header and entry publication.
  useIntervalPoll({ enabled: live && remoteReady() && observing && (following || working || provisioning),
    pollIntervalMs: working || provisioning ? WORK_OBSERVATION_MS : PASSIVE_OBSERVATION_MS, onPoll: () => episodes.revalidate({ passive: true }) });
  const publicationKey = `${ctx.accountId}:${descriptor.key}`;
  const publicationData = raw.status === "ready" && raw.source.kind === "live" && raw.error === null && raw.fresh ? raw.data.data : null;
  const publication = useMemo(() => publicationData === null ? null : JSON.stringify([
    publicationData.items.map(episode => [episode.id, episode.transcript_state]),
    publicationData.feed.recurring.last_checked_at,
    publicationData.feed.imports.map(operation => [operation.id, operation.updated_at]).sort((a, b) => a[0].localeCompare(b[0])),
  ]), [publicationData]);
  const observedPublication = useRef<{ key: string; signature: string } | null>(null);
  const showKey = `${ctx.accountId}:${feedId}`;
  const showTitle = publicationData?.feed.feed.title ?? null;
  const observedShow = useRef<{ key: string; title: string } | null>(null);
  useEffect(() => {
    if (observedPublication.current?.key !== publicationKey) observedPublication.current = null;
    if (publication === null) return;
    const previous = observedPublication.current;
    observedPublication.current = { key: publicationKey, signature: publication };
    if (previous !== null && previous.signature !== publication) publishChange("Entries");
    if (showTitle !== null && (observedShow.current?.key !== showKey || observedShow.current.title !== showTitle)) {
      observedShow.current = { key: showKey, title: showTitle };
      publishChange("Feeds");
    }
  }, [publication, publicationKey, showKey, showTitle]);

  const { fail } = useOutcome();
  const throwLater = useThrowLater();
  const [checking, setChecking] = useState(false);
  const checked = useRef(false);
  const savedCheck = usePaneVisitData(CHECKED, () => checked.current);
  if (savedCheck === true) checked.current = true;
  const retainCheck = usePaneVisitDataWriter(CHECKED);
  const canCheckSource = observing && live && remoteReady() && ctx.online && head.status === "ready" && head.data.feed.kind === kind && head.error === null && !head.refreshing && !following;
  // The check on open is a write nobody pressed: its failure leaves the shown entries standing.
  useEffect(() => {
    if (checked.current || !canCheckSource) return;
    checked.current = true;
    retainCheck(true);
    void requestFeedRefresh({ kind: "Feed", feed_id: feedId }, ctx.sessionSignal())
      .catch(error => { modeledApiError(error, throwLater); });
  }, [canCheckSource, ctx, feedId, retainCheck, throwLater]);
  const filterRows = usePaneFilterRows({
    sourceKey: `FeedDetail.Episodes:${feedId}`,
    getRowStatus: (text) => episodes.status === "ready" && live && !entryList.complete
      ? { kind: entryList.failure === null ? "Partial" : "Failed", loadedCount: resolved.length,
        visibleCount: matching(text).length, unit: { singular, plural: noun } }
      : indexRowStatus(episodes, resolved.length, matching(text).length, { singular, plural: noun }),
  });
  const replaceView = useCallback(
    (changes: Readonly<Record<string, string | null>>) =>
      router.replace(viewHref(href, params, changes)),
    [params, href, router],
  );
  const { inputRef, focusInput } = usePaneQueryInput();
  const queryStatusId = useId();
  const playbackChoices = STATES.some((choice) => choice.value === state) ? STATES : [...STATES, { value: state, label: state }];
  const sortChoices = SORTS.some((choice) => choice.value === sort) ? SORTS : [...SORTS, { value: sort, label: "Unsupported order" }];
  const chips = state === "all" ? [] : [{ id: "state", label: `${kind === "podcast" ? "Playback" : "Reading"}: ${playbackChoices.find((choice) => choice.value === state)?.label}` }];
  const canReset = sort !== "newest" || chips.length > 0;
  const queryControls = {
    kind: "Controls" as const,
    focusInput,
    content: <PaneQueryToolbar
      inputRef={inputRef}
      input={{ label: `Filter ${noun}`, placeholder: `Filter ${noun}`, value: filterRows.query, appliedValue: filterRows.query, onChange: filterRows.onQueryChange, onClear: filterRows.clearQuery }}
      options={{
        label: "Filters", activeCount: chips.length,
        onClear: () => replaceView({ state: null }),
        content: <RadioGroup label={kind === "podcast" ? "Playback" : "Reading"} value={state} choices={playbackChoices} onChange={(value) => replaceView({ state: value === "all" ? null : value })} />,
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
    () => feedRefresh({ kind: "Feed", feed_id: feedId }, kind),
    [feedId, kind],
  );
  const connections = useMemo(
    () => (
      <ConnectionsSurface resourceRef={{ scheme, id: feedId }} />
    ),
    [feedId, scheme],
  );
  useResourceInspector({
    scheme,
    handle: ready !== null && headError?.status !== 404 && headError?.status !== 403 ? feedId : null,
    bodies: { linkedItems: connections },
  });
  const text = filterRows.query.trim();
  const known = STATES.find(option => option.value === state)?.value;
  const podcast = ready?.data.feed;
  const paneFallback = () => findPaneLandmarkFocusTarget(librariesCard.current?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId);
  const blocked = !live || !remoteReady() || head.status !== "ready" || head.error !== null || head.refreshing || !head.fresh
    ? "TemporarilyUnavailable" : null;
  const episodeState = known === "unread" ? "unplayed" : known === "finished" ? "played" : known;
  const bulkActions = known === undefined || known === "all" || podcast === undefined ? [] : [
    projectCollectionConsumptionAction({ selection: { kind: "Feed", feed_id: feedId, feed_kind: kind, state: known }, desiredState: "finished", title: podcast.title, blocked, ctx, run, returnFocus: paneFallback }),
    projectCollectionConsumptionAction({ selection: { kind: "Feed", feed_id: feedId, feed_kind: kind, state: known }, desiredState: "unread", title: podcast.title, blocked, ctx, run, returnFocus: paneFallback }),
    ...(kind === "podcast" ? [projectPodcastTranscriptAction({ podcastId: feedId, title: podcast.title, state: episodeState!, blocked, ctx, run, returnFocus: paneFallback })] : []),
  ];
  const librariesAction = podcast === undefined ? null : projectFeedLibrariesAction({ target: { kind: "Canonical", feed_id: feedId }, feedKind: kind, title: podcast.title, disabledReason: blocked === null ? null
    : !live || !remoteReady() ? "needs a connection." : headError !== null ? "couldn’t refresh this source." : "loading this source", ctx, run,
    focus: { trigger: null, returnFocus: () => librariesCard.current?.querySelector<HTMLButtonElement>("header button") ?? librariesCard.current ?? paneFallback(), afterRemoval: paneFallback },
  });
  usePaneChrome({
    displayTitle: podcast?.title,
    menuActions: bulkActions,
    resourceActions: !live || !remoteReady() || podcast === undefined ? undefined : { kind: "Feed", subject: {
      target: { kind: "Canonical", feed_id: feedId }, feedKind: kind, title: podcast.title,
      facts: headError !== null
        ? { kind: "Failed", observedSubscribed: ready?.source.kind === "live" ? following : null, error: headError, retry: head.refetch, retrying: head.status === "failed" ? head.retrying : head.status === "ready" && head.refreshing }
        : head.status !== "ready" || head.refreshing || !head.fresh
          ? { kind: "Resolving", observedSubscribed: ready?.source.kind === "live" ? following : null } : { kind: "Ready", resolution: { kind: "Canonical", feed_id: feedId, feed_kind: kind, subscribed: following } },
    } },
    refresh:
      live && remoteReady() && head.status === "ready"
        ? {
            kind: "Refreshable",
            sourceKey: `Podcast.Detail:${feedId}`,
            execute,
          }
        : head.status === "loading"
          ? { kind: "Resolving" }
          : undefined,
    resourceRef: ready === null ? undefined : canonicalResourceRef({ scheme, id: feedId }),
    header: { kind: "Section", meta: { kind: "None" } },
    query: queryControls,
  });
  usePaneReturnReady(
    head.status === "failed" ||
      (ready !== null && episodes.status !== "loading"),
  );

  const visible = matching(text);
  const emptyTitle = text !== ""
    ? `no ${live && !entryList.complete ? "loaded " : ""}${noun} match this filter.`
    : known === "all"
        ? `no ${noun}.`
        : `no ${known === "in_progress" ? "in-progress" : kind === "podcast" ? episodeState : known} ${noun}.`;
  const readFeedback = useIndexReadFeedback({ value: episodes, requestedKey: descriptor.key, active, waiting: known !== undefined && episodes.status === "loading", outcome: visible.length > 0 ? "results updated." : emptyTitle });
  const checkAgain = () => {
    if (checking) return;
    setChecking(true);
    void requestFeedRefresh({ kind: "Feed", feed_id: feedId })
      .catch(error => { fail(error, `couldn’t check for new ${noun}.`, { label: "retry", commandKey: `check podcast ${feedId}`, run: checkAgain }); })
      .finally(() => setChecking(false));
  };
  return (
    <>
      {readFeedback.announcement}
      <PaneSurface>
          {head.status === "loading" ? <Ruling /> : null}
          {ready && podcast ? (
            <PaneSection className={styles.overview}>
              <div className={styles.identity}>
                <Artwork title={podcast.title} source={remoteArtwork(podcast.image_url)} size={56} />
                <div className={styles.identityCopy}>
                  <ContributorCreditList credits={selectMediaAuthors(podcast.contributors)} />
                  <p className={styles.counts}>
                    {pluralize(ready.data.entry_counts.known_count, singular)}
                  </p>
                </div>
                <Button ref={detailsButton} className={styles.detailButton}
                  icon={<Icon.Disclose open={expanded} />}
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
                    {podcast.feed_url === null ? null : <a href={podcast.feed_url} target="_blank" rel="noopener noreferrer">rss feed</a>}
                  </div>
                  {ready.data.playback_settings !== null ? <div className={styles.playbackDefaults}>
                    <span>playback defaults · {formatPlaybackRate(ready.data.playback_settings.default_playback_speed ?? 1)} · skip silence on android: {ready.data.playback_settings.pause_shortening_mode === "Natural" ? "on" : "off"}</span>
                    {live && remoteReady() ? <Button className={styles.detailButton} onClick={() => ctx.overlays.open({ kind: "PodcastSettings", podcastId: feedId })}>edit…</Button> : <span>at last catalog save</span>}
                  </div> : null}
                </div> : null}
              </div>
            </PaneSection>
          ) : null}
          {ready && podcast ? <PaneSection ref={librariesCard} title="Library Subscriptions" aria-label="Library Subscriptions" tabIndex={-1}
            actions={librariesAction ? <Button iconOnly icon={librariesAction.icon} aria-label={`add to library: ${podcast.title}`}
              aria-haspopup="dialog" aria-disabled={librariesAction.disabled}
              tooltip={{ text: `add to library: ${podcast.title}${librariesAction.disabledReason ? `: ${librariesAction.disabledReason}` : ""}` }}
              onClick={event => { if (librariesAction.disabled) return; const detail = prepareActionSelect(event, event.currentTarget); if (detail) librariesAction.onSelect(detail); }} /> : null}>
            {libraryRows.length > 0 ? <CollectionView geometry="UniformIndex" surface={false} returnScope={`FeedDetail.Libraries:${feedId}`} ariaLabel="subscription libraries" status="ready"
              rows={libraryRows}
              renderRow={live && remoteReady() ? props => {
                const destination = namedById.get(props.row.id)!;
                const focus = {
                  trigger: null,
                  returnFocus: () => librariesCard.current?.querySelector<HTMLButtonElement>("header button") ?? librariesCard.current,
                  afterRemoval: props.afterRemoval,
                };
                const action = projectFeedLibraryRemovalAction({
                  feedId, feedKind: kind, title: podcast.title, libraryId: destination.library_id, libraryName: libraryDisplayName(destination),
                  canRemove: destination.can_add_content,
                  blocked: ready.error !== null || ready.refreshing || !ready.fresh ? "TemporarilyUnavailable" : null,
                  ctx, run, focus,
                });
                const reasonId = `${detailId}-library-${destination.library_id}`;
                return <CollectionRow {...props} primaryControl={<span>
                  <Button iconOnly icon={action.icon} aria-label={action.accessibleLabel} aria-haspopup="dialog"
                    aria-disabled={action.disabled} aria-describedby={action.disabledReason ? reasonId : undefined}
                    tooltip={{ text: action.disabledReason ? `${action.accessibleLabel}: ${action.disabledReason}` : action.accessibleLabel }}
                    onClick={event => { const detail = prepareActionSelect(event, event.currentTarget); if (detail) action.onSelect(detail); }} />
                  {action.disabledReason ? <span className="sr-only" id={reasonId}>{action.disabledReason}</span> : null}
                </span>} />;
              } : undefined} /> : null}
          </PaneSection> : null}
          {live && ready && podcast && (history.length > 0 || recurring?.state === "pending" || recurring?.state === "running" || recurring?.error_code !== null && recurring?.error_code !== undefined || recurring?.had_coverage_gaps || recurring?.history.work_in_flight || recurring?.history.had_coverage_gaps || recurring?.history.error_code) ? <PaneSection title={`${singular} checks and additions`}>
            {recurring?.state === "pending" || recurring?.state === "running" ? <p>checking for {noun}…</p> : null}
            {recurring?.error_code !== null && recurring?.error_code !== undefined || recurring?.had_coverage_gaps ? <Fact
              line={{ fact: `the last check couldn’t load every ${singular}.`, reason: following ? "nexus checks again on its own." : undefined }}
              verbs={[{ label: "retry", commandKey: `check podcast ${feedId}`, run: checkAgain, busy: checking }]} /> : null}
            {recurring?.history.work_in_flight ? <p>checking available history…</p> : null}
            {recurring?.history.had_coverage_gaps || recurring?.history.error_code ? <Fact line={{ fact: "available history is incomplete.", reason: "the publisher or an earlier page could not be read." }} /> : null}
            {history.map(operation => <FeedImportProgress key={operation.id} operation={operation} title={podcast.title} />)}
          </PaneSection> : null}
          {episodes.status === "failed" && episodeFailure !== null ? (
            episodeFailure.code === "E_INVALID_REQUEST"
              ? <Fact line={{ fact: `couldn’t load ${noun} for this view.` }}
                verbs={[{ label: "reset view", commandKey: "reset episodes view", run: () => replaceView({ state: null, sort: null }) }]} />
              : episodeFailure.code === "E_NOT_FOUND" || episodeFailure.code === "E_FEED_NOT_FOUND" || episodeFailure.code === "E_FORBIDDEN"
                ? <Fact line={{ fact: "this source isn’t available." }} />
              : catalogFailure !== null ? <Fact line={catalogFailure} speak={speak} />
              : <Failed error={episodeFailure} noun={noun} retry={{ run: retry, busy }} />
          ) : known === undefined || ready === null ? null : (
            <PlaybackSourceContext.Provider value={async selected_media_id => {
              if (kind === "article") return captureSavedView(visible.map(entry => entry.media_summary), selected_media_id);
              const sourceSort = (["newest", "oldest", "duration_asc", "duration_desc"] as const).find(value => value === sort);
              if (sourceSort === undefined) throw new Error("invalid podcast queue sort");
              if (source.kind === "catalog")
                return captureSavedView(visible.map(episode => episode.media_summary), selected_media_id);
              // The refusal's message is its reason, as the player's own refusals are.
              if (!live || !remoteReady()) throw new ApiError(409, "E_PLAYBACK_REFUSED", "this list needs a connection.");
              if (episodes.status !== "ready" || episodes.refreshing) throw new ApiError(409, "E_PLAYBACK_REFUSED", "this list is still loading.");
              if (!episodes.fresh || episodes.error !== null) throw new ApiError(409, "E_PLAYBACK_REFUSED", "this list couldn’t refresh.");
              return capturePlaybackSource({ source: { kind: "Podcast", podcast_id: feedId, query: text, state: episodeState!, sort: sourceSort }, selected_media_id });
            }}>
            <PaneSection title={noun}>
            <CollectionView geometry="UniformIndex"
              surface={false}
              returnScope="FeedDetail.Episodes"
              rows={visible.map(episode => presentMedia(episode.media_summary, {
                id: episode.id, primary: { kind: "link", href: `/media/${episode.id}` },
                resourceRef: canonicalResourceRef({ scheme: "media", id: episode.id }), selected: false,
              }))}
              status={episodes.status === "loading" ? "loading" : "ready"}
              ariaLabel={noun}
              renderRow={props => <CollectionRow {...props} containingPodcastId={kind === "podcast" ? feedId : undefined} />}
              collectionBusy={busy}
              anchorKey={text}
              empty={<Fact line={{ fact: emptyTitle }} />}
              footer={source.kind === "live" && !entryList.complete ? entryList.failure?.op === "More"
                ? <Failed error={entryList.failure.error} noun={`more ${noun}`} retry={{ run: entryList.retry, busy: entryList.running !== null }} />
                : <Button disabled={entryList.running !== null} onClick={entryList.more}>load more</Button> : null}
            />
            </PaneSection>
            </PlaybackSourceContext.Provider>
          )}
      </PaneSurface>
    </>
  );
}
