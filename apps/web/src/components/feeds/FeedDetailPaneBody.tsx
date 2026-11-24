"use client";

// One source: detail and its complete entry order share one observation.
// One visible polling lane refreshes publication, lifecycle and transcript facts.
// Reviewed commands belong to the account owner. Observation stops outside
// the visible pane.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlaybackSourceContext, captureSavedView, capturePlaybackSource } from "@/lib/actions/playbackSource";
import CollectionView from "@/components/collections/CollectionView";
import { useIndexReadFeedback } from "@/components/collections/useCollectionReadFeedback";
import IndexedMediaRow from "@/components/collections/IndexedMediaRow";
import { libraryDisplayName } from "@/lib/collections/presenters/library";
import type { FeedActionSubject } from "@/lib/actions/inlineActions";
import { projectCollectionConsumptionAction, projectPodcastTranscriptAction, projectFeedLibraryRemovalAction } from "@/lib/actions/project";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import ConnectionsSurface from "@/components/connections/ConnectionsSurface";
import { useOutcome } from "@/components/feedback/Feedback";
import { Fact, Failed } from "@/components/feedback/Fact";
import { useActiveRegion } from "@/components/feedback/stage";
import { catalogLine } from "@/lib/catalog/copy";
import { Ruling } from "@/components/feedback/Ruling";
import FeedImportProgress from "@/components/feeds/FeedImportProgress";
import FeedTitlePage from "@/components/feeds/FeedTitlePage";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { viewHref } from "@/lib/collections/view";
import type { PaneCollation } from "@/lib/panes/collation";
import PaneSurface from "@/components/ui/PaneSurface";
import PaneSection from "@/components/ui/PaneSection";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { useResourceInspector } from "@/components/resource-inspector/useResourceInspector";
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
import { listFeedEntries, requestFeedRefresh, type FeedDetail } from "@/lib/feeds/api";
import { type EntryState } from "@/lib/feeds/api";
import { publishChange } from "@/lib/api/changes";
import { useCatalogRead, useCatalogState, usePromoteLiveGroup } from "@/lib/catalog/provider";
import { unstamped } from "@/lib/consumption/listening";
import { catalogFeedEntries } from "@/lib/catalog/selectors";
import { remoteReady } from "@/lib/native/admission";
import { ApiError, isApiError } from "@/lib/api/client";
import { modeledApiError, useServerValue, useThrowLater, type ServerValue, type Visit } from "@/lib/api/serverState";
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

const CHECKED = definePaneVisitDataKey<boolean>("FeedDetail.SourceCheck");
const DETAILS = definePaneVisitDataKey<boolean>("FeedDetail.Details");
const EPISODES = definePaneVisitDataKey<Visit<Awaited<ReturnType<typeof listFeedEntries>>>>("FeedDetail.Entries");
export default function FeedDetailPaneBody({ kind }: { readonly kind: "podcast" | "article" }) {
  const feedId = usePaneParam(kind === "podcast" ? "podcastId" : "feedId");
  const runtime = usePaneRuntime();
  if (feedId === null || runtime === null) throw new Error("source detail route requires its identity");
  return <FeedDetailPane key={`${runtime.visitId}:${feedId}`} feedId={feedId} kind={kind} paneId={runtime.paneId} />;
}

function FeedDetailPane({ feedId, kind, paneId }: { readonly feedId: string; readonly kind: "podcast" | "article"; readonly paneId: string }) {
  const noun = kind === "podcast" ? "episodes" : "articles";
  const singular = kind === "podcast" ? "episode" : "article";
  const scheme = kind === "podcast" ? "podcast" : "feed";
  const href = `/${kind === "podcast" ? "podcasts" : "feeds"}/${feedId}`;
  const STATES: readonly { value: EntryState; label: string }[] = [{ value: "all", label: `all ${noun}` }, { value: "unread", label: kind === "podcast" ? "unplayed" : "unread" }, { value: "in_progress", label: "in progress" }, { value: "finished", label: kind === "podcast" ? "played" : "finished" }];
  const speak = useActiveRegion();
  const router = usePaneRouter();
  const params = usePaneSearchParams();
  const active = usePaneIsActive();
  const observing = useObservationDemand(usePaneIsPresented());
  const capturedDetails = useRef<boolean | null>(null);
  const savedDetails = usePaneVisitData(DETAILS, () => capturedDetails.current);
  const [expanded, setExpanded] = useState(savedDetails ?? false);
  capturedDetails.current = expanded;
  const { ctx, run } = useActionRuntime();
  const state = params.get("state") ?? "all";
  const sort = params.get("sort") ?? "newest";
  const orderKnown = ["newest", "oldest", ...(kind === "podcast" ? ["duration_asc", "duration_desc"] : [])].includes(sort);
  const catalog = useCatalogState();
  const query = new URLSearchParams({ state, sort }).toString();
  const { read: descriptor, group } = useFeedEntriesRead();
  const savedRead = useCatalogRead(value => {
    const data = catalogFeedEntries(value, feedId, new URLSearchParams(query));
    return data === null ? null : { data, consumption_revision: value.value.consumption_revision };
  });
  const raw = useServerValue({ ...descriptor, catalog: savedRead, visit: EPISODES, enabled: observing });
  const readError = raw.status === "loading" ? null : raw.error;
  const denied = readError?.code === "E_FEED_NOT_FOUND" || readError?.status === 403 || readError?.status === 404;
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
  const snapshot: typeof raw = denied && readError !== null
    ? { status: "failed", error: readError, retrying: indexReading(raw), refetch: raw.refetch, revalidate: raw.revalidate }
    : group.live || saved === null ? raw : {
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
  const following = destinations.length > 0;
  const history = ready?.data.imports ?? [];
  const recurring = ready?.data.recurring;
  const matching = (text: string) => episodeItems.filter(episode =>
    matchesPaneFilterQuery(text, [episode.title, ...episode.other_filter_fields]));

  const working = history.some(operation => operation.work_in_flight) || recurring?.work_in_flight === true || recurring?.history.work_in_flight === true;
  const provisioning = episodeItems.some(episode => episode.processing_status !== "suspended" && episode.transcript_state !== null && shouldPollTranscriptProvisioning(episode.transcript_state));
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
    if (showTitle !== null) {
      const previousShow = observedShow.current;
      observedShow.current = { key: showKey, title: showTitle };
      if (previousShow?.key === showKey && previousShow.title !== showTitle) publishChange("Feeds");
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
    getRowStatus: (text) => indexRowStatus(episodes, episodeItems.length, matching(text).length, { singular, plural: noun }),
  });
  const replaceView = useCallback(
    (changes: Readonly<Record<string, string | null>>) =>
      router.replace(viewHref(href, params, changes)),
    [params, href, router],
  );
  const collation: PaneCollation = {
    words: {
      label: `filter ${noun}`, value: filterRows.query, applied: filterRows.query,
      onChange: filterRows.onQueryChange, onClear: filterRows.clearQuery,
      standing: false, onSubmit: null, notice: null, verbs: [],
      rows: { status: filterRows.rowStatus, announce: episodes.status === "ready" && episodeFailure === null },
    },
    dimensions: [],
    order: orderKnown ? {
      value: sort === "newest" ? null : sort, rest: "newest first",
      keys: [
        { label: "oldest", ways: [{ value: "oldest", label: null, word: "oldest first" }] },
        ...(kind === "podcast" ? [{ label: "duration", ways: [
          { value: "duration_asc", label: "shortest", word: "shortest first" },
          { value: "duration_desc", label: "longest", word: "longest first" },
        ] }] : []),
      ],
      onChange: value => replaceView({ sort: value }), note: null,
    } : null,
    reset: orderKnown && sort !== "newest" ? () => {
      filterRows.clearQuery();
      replaceView({ sort: null });
    } : null,
  };
  const execute = useMemo(
    () => feedRefresh({ kind: "Feed", feed_id: feedId }, kind),
    [feedId, kind],
  );
  const feedTitle = ready?.data.feed.title ?? null;
  const connections = useMemo(
    () => (
      <ConnectionsSurface resourceRef={{ scheme, id: feedId }} resourceLabel={feedTitle} />
    ),
    [feedId, scheme, feedTitle],
  );
  useResourceInspector({
    scheme,
    handle: ready !== null && headError?.status !== 404 && headError?.status !== 403 ? feedId : null,
    bodies: { linkedItems: connections },
  });
  const text = filterRows.query.trim();
  const known = STATES.find(option => option.value === state)?.value;
  const podcast = ready?.data.feed;
  const paneFallback = () => findPaneLandmarkFocusTarget(paneId);
  const blocked = !live || !remoteReady() || head.status !== "ready" || head.error !== null || head.refreshing || !head.fresh
    ? "TemporarilyUnavailable" : null;
  const episodeState = known === "unread" ? "unplayed" : known === "finished" ? "played" : known;
  const bulkActions = known === undefined || known === "all" || podcast === undefined ? [] : [
    projectCollectionConsumptionAction({ selection: { kind: "Feed", feed_id: feedId, feed_kind: kind, state: known }, desiredState: "finished", title: podcast.title, blocked, ctx, run, returnFocus: paneFallback }),
    projectCollectionConsumptionAction({ selection: { kind: "Feed", feed_id: feedId, feed_kind: kind, state: known }, desiredState: "unread", title: podcast.title, blocked, ctx, run, returnFocus: paneFallback }),
    ...(kind === "podcast" ? [projectPodcastTranscriptAction({ podcastId: feedId, title: podcast.title, state: episodeState!, blocked, ctx, run, returnFocus: paneFallback })] : []),
  ];
  const subject: FeedActionSubject | null = !live || !remoteReady() || podcast === undefined ? null : {
    target: { kind: "Canonical", feed_id: feedId }, feedKind: kind, title: podcast.title,
    facts: headError !== null
      ? { kind: "Failed", observedSubscribed: ready?.source.kind === "live" ? following : null, error: headError, retry: head.refetch, retrying: head.status === "failed" ? head.retrying : head.status === "ready" && head.refreshing }
      : head.status !== "ready" || head.refreshing || !head.fresh
        ? { kind: "Resolving", observedSubscribed: ready?.source.kind === "live" ? following : null } : { kind: "Ready", resolution: { kind: "Canonical", feed_id: feedId, feed_kind: kind, subscribed: following } },
  };
  usePaneChrome({
    displayTitle: podcast?.title,
    views: {
      label: kind === "podcast" ? "episode view" : "article view", value: state, items: STATES,
      onSelect: value => replaceView({ state: value === "all" ? null : value }),
    },
    menuActions: bulkActions,
    resourceActions: subject === null ? undefined : { kind: "Feed", subject },
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
    query: { kind: "Collation", collation },
  });
  usePaneReturnReady(
    head.status === "failed" ||
      (ready !== null && episodes.status !== "loading"),
  );

  const visible = matching(text);
  const emptyTitle = text !== ""
    ? `no ${noun} match this filter.`
    : known === "all"
        ? `no ${noun}.`
        : `no ${known === "in_progress" ? "in-progress" : kind === "podcast" ? episodeState : known} ${noun}.`;
  const readFeedback = useIndexReadFeedback({ value: episodes, requestedKey: descriptor.key, active, waiting: known !== undefined && episodes.status === "loading", outcome: visible.length > 0 ? null : emptyTitle });
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
          {ready && podcast ? <FeedTitlePage feed={podcast} knownCount={ready.data.entry_counts.known_count} destinations={destinations}
            playbackSettings={ready.data.playback_settings}
            editPlayback={live && remoteReady() ? () => ctx.overlays.open({ kind: "PodcastSettings", podcastId: feedId }) : null}
            subject={subject}
            removal={(destination, focus) => !live || destination.is_default ? null : projectFeedLibraryRemovalAction({
              feedId, feedKind: kind, title: podcast.title, libraryId: destination.library_id, libraryName: libraryDisplayName(destination),
              canRemove: destination.can_add_content, blocked, ctx, run, focus,
            })}
            lines={{
              checks: live && (recurring?.state === "pending" || recurring?.state === "running" || recurring?.error_code !== null && recurring?.error_code !== undefined || recurring?.had_coverage_gaps || recurring?.history.work_in_flight || recurring?.history.had_coverage_gaps || recurring?.history.error_code) ? <>
                {recurring?.state === "pending" || recurring?.state === "running" ? <div>checking for {noun}…</div> : null}
                {recurring?.error_code !== null && recurring?.error_code !== undefined || recurring?.had_coverage_gaps ? <Fact
                  line={{ fact: `the last check couldn’t load every ${singular}.`, reason: following ? "nexus checks again on its own." : undefined }}
                  verbs={[{ label: "retry", commandKey: `check podcast ${feedId}`, run: checkAgain, busy: checking }]} /> : null}
                {recurring?.history.work_in_flight ? <div>checking available history…</div> : null}
                {recurring?.history.had_coverage_gaps || recurring?.history.error_code ? <Fact line={{ fact: "available history is incomplete.", reason: "the publisher or an earlier page could not be read." }} /> : null}
              </> : null,
              additions: live && history.length > 0 ? history.map(operation => <FeedImportProgress key={operation.id} operation={operation} title={podcast.title} />) : null,
            }}
            detailsOpen={expanded} onDetails={setExpanded} /> : null}
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
              if (kind === "article" || source.kind === "catalog")
                return captureSavedView(visible.map(episode => ({ media_id: episode.id, media_kind: episode.media_kind, can_play: episode.can_play })), selected_media_id);
              const sourceSort = (["newest", "oldest", "duration_asc", "duration_desc"] as const).find(value => value === sort);
              if (sourceSort === undefined) throw new Error("invalid podcast queue sort");
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
              rows={visible.map(episode => ({
                id: episode.id, kind: episode.media_kind === "podcast_episode" ? "podcast_episode" : "media",
                presentation: "Index", title: { text: episode.title }, contributors: [], publicationDate: null, context: null,
                primary: { kind: "link", href: `/media/${episode.id}`, paneLabelHint: episode.title },
                resourceRef: canonicalResourceRef({ scheme: "media", id: episode.id }), selected: false,
              }))}
              status={episodes.status === "loading" ? "loading" : "ready"}
              ariaLabel={noun}
              renderRow={props => <IndexedMediaRow {...props} mediaId={props.row.id}
                saved={source.kind === "catalog" ? catalog.data?.media.get(props.row.id)?.summary : undefined}
                containingPodcastId={kind === "podcast" ? feedId : undefined} />}
              collectionBusy={busy}
              anchorKey={text}
              empty={<Fact line={{ fact: emptyTitle }} />}
              notice={episodeFailure === null ? null : <Failed error={episodeFailure} noun={noun} retry={{ run: retry, busy }} />}
              rowActionsAvailable={episodeFailure === null}
            />
            </PaneSection>
            </PlaybackSourceContext.Provider>
          )}
      </PaneSurface>
    </>
  );
}
