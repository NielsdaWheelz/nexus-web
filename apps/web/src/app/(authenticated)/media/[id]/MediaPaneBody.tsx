"use client";

import { fetchImportDetail } from "@/lib/imports/api";
import { useImports } from "@/lib/imports/ImportsProvider";

// The media pane: the media record and its states, the shared document reader
// over the media's publication and cursor, the annotations painted over it,
// find, the chrome around it, and reading activity. Everything positional is
// the reader's; this file only composes.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
} from "react";
import { useOutcome } from "@/components/feedback/Feedback";
import { useActiveRegion, useTransportVerbs } from "@/components/feedback/stage";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import type { Line, Retract } from "@/components/feedback/stage";
import Button from "@/components/ui/Button";
import ReaderCitation from "@/components/ui/ReaderCitation";
import HostedContents from "./HostedContents";
import { useShareController } from "@/lib/sharing/controller";
import { resourceShareTarget } from "@/lib/sharing/targets";
import { anchoredShareOpenOptions } from "@/lib/sharing/openOptions";
import { useChangeStamp } from "@/lib/api/changes";
import LecternNextPrompt from "@/components/LecternNextPrompt";
import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { catalogLine } from "@/lib/catalog/copy";
import { useCatalogState } from "@/lib/catalog/provider";
import { catalogMedia } from "@/lib/catalog/selectors";
import { groupContributorCredits, selectMediaAuthors } from "@/lib/contributors/credits";
import { installedApp, remoteReady, remoteAdmission, subscribeAdmission } from "@/lib/native/admission";
import { localContentAvailable } from "@/lib/offline/localContent";
import DownloadedEpisode, { useSavedEpisode } from "./DownloadedEpisode";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { canonicalResourceRef } from "@/lib/sharing/targets";
import { MediaFacts, MediaTitle } from "@/components/media/MediaIdentity";
import ResourceMetadata from "@/components/resources/ResourceMetadata";
import { bibliographyMetadata } from "@/lib/resources/metadata";
import type { MediaSummary } from "@/lib/media/mediaSummary";
import { usePaneFreeServerValue, type ServerValue } from "@/lib/api/serverState";
import { assertNever } from "@/lib/assertNever";
import { openStream } from "@/lib/api/stream";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { localPoint, readingPublicationIdentity } from "@/lib/documentReader/model";
import { PositionRibbon } from "@/lib/documentReader/chrome/MapRail";
import {
  ReaderRuling,
  useDocumentReader,
  useReaderState,
  type Decorations,
  type Inspection,
  type Reader,
} from "@/lib/documentReader/DocumentReader";
import type { ReaderOptions } from "@/lib/documentReader/runtime";
import { useFind } from "@/lib/find/useFind";
import { holdProgress } from "@/lib/consumption/state";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { lecternItems, lecternNext, useLectern } from "@/lib/lectern/lectern";
import type { LecternItem } from "@/lib/lectern/api";
import { mediaDetailFromResponse, type MediaDetail } from "@/lib/media/mediaDetail";
import { mediaSourceLine } from "@/lib/media/mediaErrorMessage";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { useMediaMetadataOperations } from "@/lib/media/mediaMetadataOperations";
import { useMediaProcessingStatus } from "@/lib/media/useMediaProcessingStatus";
import { fetchAcceptedSource } from "@/lib/imports/ingest";
import { offerLine } from "@/lib/imports/copy";
import {
  paneSourceKey,
  requirePaneRuntime,
  usePaneIsActive,
  usePaneIsVisible,
  usePaneParam,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { usePlayerCommands } from "@/lib/player/playerRuntime";
import { useArrivalFailure, useSourceArrival, type SourceArrivalContext, type SourceArrivalOutcome } from "@/lib/reader/sourceArrival";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { sourceTargetFromHref } from "@/lib/resources/sourceTarget";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { OpenIntent, TargetActivationEvent } from "@/lib/ui/targetActivation";
import { openAsyncResult } from "@/lib/panes/openResult";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { useMobileChrome } from "@/lib/mobileShell/chrome";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import { useReaderActivity } from "./activity";
import { useFailedReadRepair } from "@/lib/api/serverState";
import { createMediaAnnotations } from "./annotations";
import { createReaderAnnotations, locatePassage, type ReaderAnnotation } from "@/lib/documentReader/annotations";
import { AnnotationList, PLACEMENT_COPY } from "@/lib/documentReader/chrome/ReaderAnnotation";
import { useAuthoredStore } from "@/lib/authored/provider";
import { useReaderChrome } from "./chrome";
import EmbedCard, { PostActions, PostSaveReadFailure } from "./Embeds";
import { usePostSaveStates } from "@/lib/media/xPostSaves";
import EvidencePane from "./evidence/EvidencePane";
import type { EvidenceActions } from "./evidence/EvidenceRow";
import type { EvidenceOpenRequest } from "./evidence/EvidenceRow";
import { matches as matchesEvidence } from "./evidence/model";
import type { ReaderDestination } from "@/lib/documentReader/location";
import {
  hostedProgress,
  usePositionFeedback,
  hostedSource,
  inspectionOfLocator,
  targetOfLocator,
  targetOfSourcePoint,
  useReaderVisit,
  readerDestinationHref,
  destinationTarget,
} from "./hostedReader";
import SelectionDock from "./SelectionDock";
import { HostedReaderView, TranscriptChrome, TranscriptState } from "./Transcript";
import { useAnnotationVerbs, type AnnotationVerbs } from "./useAnnotationVerbs";
import styles from "./media.module.css";

export default function MediaPaneBody() {
  const id = usePaneParam("id");
  const runtime = requirePaneRuntime(usePaneRuntime(), "MediaPaneBody");
  if (!id) throw new Error("media route requires an id");
  const attemptId = runtime.searchParams.get("source_attempt_id");
  const target = sourceTargetFromHref(runtime.href);
  if (attemptId !== null && target?.kind !== "invalid_destination")
    return <AcceptedSourcePane key={attemptId} attemptId={attemptId} postRevision={target?.kind === "x_post" ? target.revision_id : null} />;
  return <MediaRoute key={id} id={id} />;
}

/** A failed import, where the reader would stand. When the source blocked the server, nexus
 * capture can save it from the reader's own browser. */
function FailedSource({ mediaId, code, line }: { mediaId: string; code: string | null; line: Line }) {
  const { observation } = useImports();
  const speak = useActiveRegion();
  const detail = usePaneFreeServerValue({
    key: `failed-source:${mediaId}`,
    stale: observation,
    load: signal => fetchImportDetail(`media:${mediaId}`, signal),
  });
  const offer = detail.status === "ready" ? detail.data.item.obligations.source?.recovery : null;
  if (offer?.kind !== "BrowserCapture") return <Fact line={line} speak={speak} />;
  const fact = code === "E_SOURCE_ACCESS_DENIED" ? "this page blocked the import."
    : code === "E_SOURCE_NOT_READABLE" ? "nexus found no readable article." : line.fact;
  return <Fact line={{ fact, reason: offerLine(offer) }} speak={speak}
    verbs={[{ label: "open original", href: offer.source_url, target: "_blank" }]} />;
}

/** Acceptance survives deduplication; mount the reader only after its identity settles. */
function AcceptedSourcePane({ attemptId, postRevision }: { readonly attemptId: string; readonly postRevision: string | null }) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "AcceptedSourcePane");
  const visible = usePaneIsVisible();
  const speak = useActiveRegion();
  const transportVerbs = useTransportVerbs();
  usePaneChrome({ titleRole: "Pointer" });
  const source = usePaneFreeServerValue({
    key: `source-attempt:${attemptId}`,
    stale: "",
    load: (signal) => fetchAcceptedSource(attemptId, signal),
  });
  const result = source.status === "ready" ? source.data : null;
  const settled = result?.settled === true;
  const error = source.status === "loading" ? null : source.error;
  const allImports = { label: "all imports", href: "/imports", onActivate: (event: TargetActivationEvent) =>
    activateTargetLink({ event, runtime, target: { href: "/imports" } }) };
  // justify-polling: an accepted source has no identity event stream. Only visible,
  // unsettled handoffs poll. Failed reads stop; the existing read owner repairs them
  // on admission, online or focus changes, or through an explicit retry.
  useIntervalPoll({
    enabled: visible && result !== null && !settled && error === null,
    pollIntervalMs: 2_000,
    onPoll: () => {
      // The read's busy state survives hiding and revealing its pane.
      if (document.visibilityState === "visible" && source.status === "ready" && !source.refreshing)
        return source.refetch().catch(() => { /* The read owner renders failures and rethrows defects. */ });
    },
  });
  useEffect(() => {
    if (settled && result !== null) runtime.router.replace(`/media/${result.media_id}${postRevision === null ? "" : `?post_revision=${postRevision}`}`, { activate: false });
  }, [result, runtime.router, settled, postRevision]);
  if (error !== null) {
    if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
    if (error.code === "E_IMPORT_NOT_FOUND" || error.code === "E_INVALID_REQUEST")
      return <Fact key="refused" line={{ fact: "couldn’t find this import." }} verbs={[allImports]} speak={speak} />;
    const transport = transportOf(error);
    const remedy = transportVerbs(transport, { retry: {
      label: "retry", commandKey: "retry import source", run: source.refetch,
      busy: source.status === "failed" ? source.retrying : source.status === "ready" && source.refreshing,
    } });
    return <Fact key="failed" line={TRANSPORT_LINES[transport].command("couldn’t open this import.")}
      verbs={remedy === null ? [allImports] : [remedy[0], allImports]} speak={speak} />;
  }
  if (settled || source.status === "loading") return <Ruling />;
  return <Fact key="pending" line={{ fact: "importing…", reason: "this opens by itself when it’s ready." }}
    verbs={[allImports]} speak={speak} />;
}

function MediaRoute({ id }: { readonly id: string }) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "MediaRoute");
  const admission = useSyncExternalStore(subscribeAdmission, remoteAdmission, () => "Ready" as const);
  const admitted = admission === "Ready";
  const catalog = useCatalogState();
  const saved = useSavedEpisode(id);
  const view = runtime.searchParams.get("view");
  const [openedOffline, setOpenedOffline] = useState(false);
  const [interacted, setInteracted] = useState(false);
  const pinSaved = useCallback(() => setInteracted(true), []);
  const metadataStamp = useChangeStamp("Metadata");
  const metadata = useMediaMetadataOperations(usePaneIsVisible() ? id : null);
  const operation = metadata.view?.operation;
  const titleJob = operation?.purpose === "title" ? operation.job_id : null;
  const speak = useActiveRegion();
  const { profile } = useReaderContext();
  const record = usePaneFreeServerValue({
    key: `/media/${id}`,
    stale: JSON.stringify([metadataStamp, metadata.view?.last_enriched_at ?? null, titleJob]),
    load: async (signal) =>
      mediaDetailFromResponse(
        await apiFetch<ApiJson<"/media/{media_id}", "get">>(`/api/media/${encodeURIComponent(id)}`, { signal }),
        id,
      ),
  });
  // only an installed device has a saved catalog to stand in for an unreachable server.
  const catalogOnly = installedApp && !admitted && !catalog.loading;
  usePaneReturnReady(record.status === "failed" || catalogOnly && record.status !== "ready");
  const failure = record.status === "loading" ? null : record.error;
  // media's own code comes ahead of transport: only E_MEDIA_NOT_FOUND says the item is gone, so a
  // mismatch 403 reads sign-in and any other refusal reads as one.
  const gone = failure?.code === "E_MEDIA_NOT_FOUND";
  const savedReady = saved.kind === "Ready";
  // Only an entry whose own record read failed with the server out of reach opens on the saved
  // copy, and stays there once the record lands. Another read's dropped response, or a refresh
  // failure over a live pane, latches nothing: it heals.
  useEffect(() => {
    if (savedReady && view !== "live" && record.status === "failed" && (admission === "Unavailable" || admission === "SignInRequired" || admission === "UpdateRequired")) setOpenedOffline(true);
  }, [admission, record.status, savedReady, view]);
  const showSaved = savedReady && (view === "downloaded" || record.status !== "ready" || view !== "live" && (openedOffline || interacted));
  const switchView = (next: "live" | "downloaded") => {
    const query = new URLSearchParams(runtime.searchParams); query.set("view", next);
    runtime.router.push(`/media/${id}?${query}`);
  };
  if (showSaved && saved.kind === "Ready") return <div className={styles.layout}>
    <div className={styles.savedSwitch}>
      <span>downloaded copy</span>
      <Button aria-busy={view === "live" && record.status === "loading" && admitted || undefined} onClick={() => switchView("live")}>view current version</Button>
    </div>
    {gone ? <Fact line={{ fact: "the original isn’t available.", reason: "this downloaded copy is kept." }} speak={speak} />
      : view === "live" && record.status === "failed" && admitted ? <Failed error={record.error} noun="the current version’s details"
        retry={{ run: record.refetch, busy: record.retrying }} /> : null}
    <DownloadedEpisode key={saved.manifest.package_id} saved={saved} onIntent={pinSaved} />
  </div>;
  const viewCurrent = { label: "view current version", commandKey: "ViewCurrentVersion", run: () => switchView("live") };
  if (view === "downloaded" && !savedReady) return saved.kind === "Loading" ? <Ruling />
    : saved.kind === "Failed" ? <Fact line={{ fact: "couldn’t open the downloaded copy." }} speak={speak}
      verbs={[{ label: "retry", commandKey: "RetryDownloadedCopy", run: saved.retry }, viewCurrent]} />
    : <Fact line={{ fact: "this episode isn’t downloaded." }} speak={speak} verbs={[viewCurrent]} />;
  if (record.status === "ready") return <div className={styles.layout}>
    {savedReady ? <div className={styles.savedSwitch}><Button onClick={() => switchView("downloaded")}>view downloaded copy</Button></div> : null}
    {record.error !== null ? <div className={styles.state}><Failed error={record.error} noun="the updated details"
      retry={{ run: record.refetch, busy: record.refreshing }} /></div> : null}
    <MediaPane id={id} record={record} />
  </div>;
  if (localContentAvailable && saved.kind === "Loading") return <Ruling />;
  if (localContentAvailable && saved.kind === "Failed") return <Fact speak={speak}
    line={{ fact: "couldn’t open the downloaded copy.", reason: "saved files and listening history are kept." }}
    verbs={[{ label: "retry", commandKey: "RetryDownloadedCopy", run: saved.retry }, { label: "manage downloads", href: "/downloads",
      onActivate: (event) => activateTargetLink({ event, runtime, target: { href: "/downloads" } }) }]} />;
  if (failure !== null && failure.status === 426) return <>
    <Failed error={failure} noun="this item’s details" />
    <LocalAnnotations mediaId={id} />
  </>;
  if (gone) return <>
    <Fact line={{ fact: "this item isn’t available to you." }} speak={speak} />
    <LocalAnnotations mediaId={id} />
  </>;
  const summary = catalog.data === null ? null : catalogMedia(catalog.data, id);
  if (summary !== null) return <><SavedMedia summary={summary} record={record} /><LocalAnnotations mediaId={id} /></>;
  if (catalogOnly) return <>
    <UnavailableSavedMedia error={catalog.data !== null ? { code: "E_CATALOG_COVERAGE" } : catalog.error ?? { code: "E_CATALOG_UNAVAILABLE" }} />
    <LocalAnnotations mediaId={id} />
  </>;
  return record.status === "failed" ? <>
    <Failed error={record.error} noun="this item’s details" retry={{ run: record.refetch, busy: record.retrying }} />
    <LocalAnnotations mediaId={id} />
  </> : <ReaderRuling profile={profile} />;
}

/** Writing about a source this device can't open: its quotes and notes stay local and editable. */
function LocalAnnotations({ mediaId }: { readonly mediaId: string }) {
  const authored = useAuthoredStore();
  const [annotations] = useState(() => createReaderAnnotations(authored, mediaId));
  useEffect(() => { annotations.bind(null); }, [annotations]);
  const state = useSyncExternalStore(annotations.subscribe, annotations.getState, annotations.getState);
  if (!state.annotations.length) return null;
  return <div className={styles.state}>
    <Fact line={{ fact: PLACEMENT_COPY.unavailable }} />
    <AnnotationList annotations={state.annotations} />
  </div>;
}

function UnavailableSavedMedia({ error }: { readonly error: { readonly code: string } }) {
  usePaneChrome({ displayTitle: "source", header: { kind: "Resource", resource: { status: "Unavailable" } } });
  usePaneReturnReady(true);
  const speak = useActiveRegion();
  const line = catalogLine(error);
  return line === null ? <Failed error={error} noun="the saved catalog" /> : <Fact line={line} speak={speak} />;
}

function SavedMedia({ summary, record }: { readonly summary: MediaSummary; readonly record: ServerValue<MediaDetail> }) {
  const speak = useActiveRegion();
  const authors = groupContributorCredits(selectMediaAuthors(summary.contributors)).find(group => group.role === "author");
  usePaneChrome({
    displayTitle: summary.title,
    resourceRef: canonicalResourceRef({ scheme: "media", id: summary.media_id }),
    header: { kind: "Resource", resource: { status: "Ready", creditGroups: authors ? [{ kind: "Authors", credits: authors.credits }] : [] } },
  });
  usePaneReturnReady(true);
  const subject = { kind: "Stored" as const, summary };
  return <div className={styles.stateScrollport}><div className={styles.state}>
    <h1><MediaTitle subject={subject} /></h1>
    <p><ResourceMetadata parts={bibliographyMetadata(selectMediaAuthors(summary.contributors), summary.original_published_date)} linkSource={false} /></p>
    {summary.part_source ? <p>from {summary.part_source.title}</p> : null}
    <p><MediaFacts summary={summary} /></p>
    {summary.processing_status === "failed" ? <p>nexus couldn’t process this item.</p> : null}
    {!remoteReady() ? <Fact line={{ fact: "this text isn’t on this device." }} speak={speak} />
      : record.status === "failed" ? <Failed error={record.error} noun="this item’s details" retry={{ run: record.refetch, busy: record.retrying }} />
      : <Ruling />}
  </div></div>;
}

/** The pane over a read record: its route renders it only once the record is ready. */
function MediaPane({ id, record }: { readonly id: string; readonly record: Extract<ServerValue<MediaDetail>, { status: "ready" }> }) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "MediaPaneBody");
  const { requestSecondarySurface } = runtime;
  const paneActive = usePaneIsActive();
  const paneVisible = usePaneIsVisible();
  const isMobile = useIsMobileViewport();
  const { profile } = useReaderContext();
  const lectern = lecternItems(useLectern());
  const { ctx, run } = useActionRuntime();
  const { openShare } = useShareController();
  // J4: the media's Lectern row (membership is the Lectern's) and its read state (the summary
  // owner's, which follows Consumption, so a reading auto-finish shows here at once).
  const row = lectern.find((item) => item.media_summary.media_id === id);
  const summaries = useMediaSummaries(row ? [row.media_summary] : []);
  const { playAudio } = usePlayerCommands();
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useCallback(
    () => root.current?.querySelector<HTMLElement>("[data-pane-content]") ?? root.current,
    [],
  );

  const detail = record.data;
  const { snapshot } = useMediaProcessingStatus(detail.id);
  const media = useMemo(() => snapshot === null ? detail : {
      ...detail,
      processing_status: snapshot.processing_status,
      last_error_code: snapshot.last_error_code,
      retrieval_status: snapshot.retrieval_status,
      retrieval_status_reason: snapshot.retrieval_status_reason,
      capabilities: snapshot.capabilities,
      transcript_state: snapshot.transcript_state,
      transcript_coverage: snapshot.transcript_coverage,
      reader_generation: snapshot.reader_generation,
    }, [detail, snapshot]);
  const transcript = media.kind === "podcast_episode" || media.kind === "video";
  const readable = media.capabilities?.can_read === true;

  // ---- the reader ----
  const readerRef = useRef<Reader | null>(null);
  const verbsRef = useRef<{ readonly isMobile: boolean; readonly verbs: AnnotationVerbs } | null>(null);
  const arrivalRef = useRef<ReturnType<typeof useSourceArrival> | null>(null);
  const findRef = useRef<ReturnType<typeof useFind>>(null);
  const navigationRuntime = useRef(runtime);
  navigationRuntime.current = runtime;
  const outcome = useOutcome();
  // A link in the text that won't open is a one-off miss; the next navigation retracts it.
  const fork = useRef<{ readonly outcome: typeof outcome; retract: Retract }>({ outcome, retract: () => {} });
  fork.current = { ...fork.current, outcome };
  const forkMiss = useCallback((fact: string | null) => {
    fork.current.retract();
    fork.current.retract = fact === null ? () => {} : fork.current.outcome.say({ fact });
  }, []);
  const savedView = useReaderVisit(readerRef);
  const entry = useMemo(() => ({ fresh: null, cold: null, view: savedView }), [savedView]);
  const chrome = useMobileChrome();
  const viewport = useMobileViewport();
  const readerScrollport = useRef<HTMLElement | null>(null);
  const reader = useDocumentReader(
    id,
    useMemo<ReaderOptions>(
      () => ({
        source: hostedSource(id),
        progress: hostedProgress(id),
        entry,
        host: { scrollport: (element: HTMLElement, geometryChanged: (reason: "Occlusion" | "Layout") => void) => {
          readerScrollport.current = element;
          const releaseChrome = chrome.registerReaderScrollport(element);
          const releaseViewport = viewport.registerReaderScrollport(element, geometryChanged);
          return () => {
            if (readerScrollport.current === element) readerScrollport.current = null;
            releaseChrome();
            releaseViewport();
          };
        }, onIntent: (intent) => {
          arrivalRef.current?.supersede({
            preserveSignal: intent.kind === "Navigate" ? intent.signal : null,
            retireFailure: intent.kind === "Navigate",
          });
          if (intent.kind === "Navigate") {
            if (verbsRef.current?.isMobile) verbsRef.current.verbs.dismissSelection();
            forkMiss(null);
          }
        }, navigation: {
          href: (destination: ReaderDestination) => readerDestinationHref(id, destination),
          activate: (destination: ReaderDestination, intent: OpenIntent, onDefault: () => void) => {
            forkMiss(null);
            if (intent === "default") { onDefault(); return "Accepted"; }
            const href = readerDestinationHref(id, destination);
            if (href === null) { forkMiss("this link is too long to open."); return "Refused"; }
            const result = navigationRuntime.current.activateTarget({ target: { href }, disposition: { kind: "Fork" } });
            return !result || result.kind === "Cancelled" ? "Refused" : "Accepted";
          },
        } },
      }),
      [chrome, viewport, entry, forkMiss, id],
    ),
    readable,
  );
  readerRef.current = reader;
  const restored = useReaderState(reader, (s) => s.restored);
  const viewRestoration = useReaderState(reader, (s) => s.viewRestoration);
  const navigationMode = useReaderState(reader, (s) => s.navigation.mode);
  const doc = useReaderState(reader, (s) => (s.document.status === "ready" ? s.document.doc : null));
  const postSaves = usePostSaveStates(doc);
  useEffect(() => { forkMiss(null); }, [doc?.identity, forkMiss, runtime.visitId]);
  const articleEmbeds = doc?.kind === "text"
    ? doc.embeds.filter((embed) => embed.provider === "x" && embed.kind === "link_preview")
    : [];
  const articleIds = [...new Set(articleEmbeds.flatMap((embed) =>
    embed.target.media_id !== null ? [embed.target.media_id] : []))].sort().join(",");
  useEffect(() => {
    if (!paneVisible || !articleIds) return;
    const stops = articleIds.split(",").map((childId) =>
      openStream<Schema<"MediaProcessingSnapshotOut">, Schema<"MediaProcessingSnapshotOut">>({
        path: `/api/stream/media/${childId}/events`,
        decode: (_type, data) => data,
        isTerminal: () => false,
        onEvent: () => reader.reload(),
        // A paused stream over shown text says nothing; it resumes on its own.
        onSuspended: () => {},
        // A final stream refusal gets one fresh projection through the reader's error owner.
        onError: () => reader.reload(),
      }),
    );
    return () => stops.forEach((close) => close());
  }, [articleIds, paneVisible, reader]);
  useEffect(() => {
    if (readable && doc && media.reader_generation != null && Number(doc.identity.slice(1).split(":", 1)[0]) !== media.reader_generation)
      reader.reload(media.reader_generation);
    else if (readable && doc && !transcript && doc.title !== media.title)
      reader.reload();
  }, [doc, media.reader_generation, media.title, readable, reader, transcript]);
  useEffect(() => {
    if (readable && snapshot !== null && doc?.kind === "text" && doc.format === "transcript"
      && (doc.transcriptNavigation?.key !== snapshot.transcript_reader_key
        || doc.transcriptCoverage !== snapshot.transcript_coverage)) reader.reload();
  }, [doc, readable, reader, snapshot]);
  const pendingTranscriptFocus = useRef(false);
  const holdTranscriptFocus = useCallback(() => {
    const element = root.current;
    if (!element) return;
    pendingTranscriptFocus.current = true;
    element.focus({ preventScroll: true });
  }, []);
  const cancelTranscriptFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) pendingTranscriptFocus.current = false;
  }, []);
  useLayoutEffect(() => {
    if (!paneActive) pendingTranscriptFocus.current = false;
    else if (pendingTranscriptFocus.current && readable && restored) {
      pendingTranscriptFocus.current = false;
      if (document.activeElement === root.current) reader.focusSource();
    }
  }, [paneActive, readable, reader, restored]);
  // Unread, reset and undo of this media: unsaved progress settles first, the server's cursor after.
  useEffect(
    () =>
      holdProgress({
        prepare: (mediaId) => (mediaId === id ? reader.prepareProgressFence() : Promise.resolve()),
        reconcile: (mediaId) => (mediaId === id ? reader.reconcileProgressFence() : Promise.resolve()),
      }),
    [id, reader],
  );

  // ---- annotations ----
  const authored = useAuthoredStore();
  const citationStamp = useChangeStamp("Entries", "Metadata");
  useEffect(() => readable ? authored.evidence_changed(() => reader.reload()) : undefined, [authored, readable, reader]);
  useEffect(() => {
    if (readable && reader.getState().document.status === "ready") reader.reload();
  }, [citationStamp, readable, reader]);
  useEffect(() => {
    if (paneActive && readable && reader.getState().document.status === "ready") reader.reload();
  }, [paneActive, readable, reader]);
  const [store] = useState(() => createMediaAnnotations(authored, id));
  const chatStamp = useChangeStamp("Chats");
  useEffect(() => store.invalidateChats(chatStamp), [store, chatStamp]);
  const documentFailed = useReaderState(reader, (s) => s.document.status === "failed");
  const sourceAbsent = documentFailed || !readable;
  useEffect(() => { if (doc) store.bind(doc); else if (sourceAbsent) store.bind(null); }, [doc, sourceAbsent, store]);
  const annotations = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  useFailedReadRepair(annotations.remoteRead.failed, annotations.remoteRead.running, store.refresh);
  const positionFeedback = usePositionFeedback();
  const [openKey, setOpenKey] = useState<EvidenceOpenRequest | null>(null);
  const latestOpenRequest = useRef<EvidenceOpenRequest | null>(null);
  const pendingEvidenceArrival = useRef<AbortSignal | null>(null);
  const requestVisit = useRef<string | null>(runtime.visitId);
  requestVisit.current = runtime.visitId;
  // One visit owns the latest reveal; retiring it settles delivery exactly once.
  const requestEvidence = useCallback((item: string, context: SourceArrivalContext | null): Promise<boolean> => {
    if (requestVisit.current !== runtime.visitId || context?.signal.aborted) return Promise.resolve(false);
    latestOpenRequest.current?.onResolved(null);
    return new Promise((resolve) => {
      const abort = () => request.onResolved(null);
      const request: EvidenceOpenRequest = {
        id: item,
        isCurrent: () => latestOpenRequest.current === request && requestVisit.current === runtime.visitId && !context?.signal.aborted,
        onResolved: (element) => {
          if (latestOpenRequest.current !== request) return;
          const current = request.isCurrent();
          latestOpenRequest.current = null;
          context?.signal.removeEventListener("abort", abort);
          setOpenKey((owned) => owned === request ? null : owned);
          if (current && element && context?.mayFocus(element)) {
            const focus = element.querySelector<HTMLElement>("[data-resource-primary]") ?? element;
            if (focus.tabIndex < 0) focus.tabIndex = -1;
            focus.focus({ preventScroll: true });
          }
          resolve(current && element !== null);
        },
      };
      latestOpenRequest.current = request;
      context?.signal.addEventListener("abort", abort, { once: true });
      setOpenKey(request);
    });
  }, [runtime.visitId]);
  useLayoutEffect(() => {
    requestVisit.current = runtime.visitId;
    return () => {
      if (requestVisit.current === runtime.visitId) requestVisit.current = null;
      latestOpenRequest.current?.onResolved(null);
    };
  }, [runtime.visitId]);

  // ---- playback: the global player, or a video's own embed ----
  const [videoAt, setVideoAt] = useState<number | null>(null);
  const seek = useCallback((ms: number) => {
    if (media.kind === "video") return setVideoAt(ms);
    if (media.kind !== "podcast_episode") return;
    run({
      ref: `media:${id}`, id: "Playback", label: "play", feedbackLabel: "play", title: media.title,
      confirmation: null, tracked: false,
      execute: () => playAudio({ mediaId: id, knownDescriptor: media.playerDescriptor, positionMs: ms, source: null, recapture: false }),
    });
  }, [id, media, playAudio, run]);

  // The chosen pane alone resolves, positions and paints a source arrival.
  const [inspection, setInspection] = useState<(Inspection & { activationId: string }) | null>(null);
  async function deliverEvidence(itemId: string, identity: string, context: SourceArrivalContext): Promise<SourceArrivalOutcome> {
    if (context.restored) return "Applied";
    latestOpenRequest.current?.onResolved(null);
    pendingEvidenceArrival.current = context.signal;
    try {
      // local items are complete once read; remote evidence may still be arriving.
      const found = await new Promise<boolean | null>((resolve) => {
        let unsubscribe = () => {};
        const settle = (value: boolean | null) => { unsubscribe(); context.signal.removeEventListener("abort", abort); resolve(value); };
        const abort = () => settle(null);
        const check = () => {
          const current = store.getState();
          if (current.local.status === "loading") return;
          if (current.local.annotations.some(annotation => annotation.id === itemId || annotation.ref === itemId)) return settle(true);
          if (current.remote.status === "loading") return;
          settle(current.remote.status === "ready" && current.remote.data.identity === identity &&
            current.remote.data.evidence.roots.some((root) => matchesEvidence(root, itemId)));
        };
        unsubscribe = store.subscribe(check);
        context.signal.addEventListener("abort", abort, { once: true });
        if (context.signal.aborted) abort(); else check();
      });
      if (context.signal.aborted || found === null) return "Cancelled";
      if (!found) return "Unavailable";
      const delivered = requestEvidence(itemId, context);
      requestSecondarySurface("resource-connections");
      const applied = await delivered;
      return context.signal.aborted ? "Cancelled" : applied ? "Applied" : "Unavailable";
    } finally {
      if (pendingEvidenceArrival.current === context.signal) pendingEvidenceArrival.current = null;
    }
  }
  /** A highlight arrives from local authored state: its placed passage, else its evidence row. */
  async function deliverHighlight(highlightId: string, context: SourceArrivalContext): Promise<SourceArrivalOutcome> {
    if (context.restored) return "Applied";
    const annotation = await new Promise<ReaderAnnotation | null | undefined>((resolve) => {
      let unsubscribe = () => {};
      const settle = (value: ReaderAnnotation | null | undefined) => { unsubscribe(); context.signal.removeEventListener("abort", abort); resolve(value); };
      const abort = () => settle(undefined);
      const check = () => { if (store.getState().local.status !== "loading") settle(store.annotation(highlightId)); };
      unsubscribe = store.subscribe(check);
      context.signal.addEventListener("abort", abort, { once: true });
      if (context.signal.aborted) abort(); else check();
    });
    if (annotation === undefined || context.signal.aborted) return "Cancelled";
    if (!annotation || !doc) return "Unavailable";
    if (annotation.placement.kind !== "placed") return deliverEvidence(annotation.id, doc.identity, context);
    const anchor = annotation.placement.anchor;
    const outcome = await reader.inspect({ signal: context.signal, target: anchor.kind === "text"
      ? { kind: "range", unit: anchor.unit, start: anchor.start, end: anchor.end } : { kind: "quads", page: anchor.page, quads: anchor.quads } });
    switch (outcome.kind) {
      case "Unavailable": return "FailureHandled";
      case "Cancelled": return "Cancelled";
      case "Arrived":
      case "Unchanged": break;
      default: assertNever(outcome);
    }
    setInspection({ identity: doc.identity, anchors: [anchor], pages: [], precision: "exact", activationId: context.activationId });
    context.signal.addEventListener("abort", () => {
      setInspection((current) => current?.activationId === context.activationId ? null : current);
    }, { once: true });
    if (context.mayFocus()) reader.focusSource();
    return "Applied";
  }
  const arrival = useSourceArrival({
    ready: restored || !readable,
    sourceIdentity: doc?.identity ?? null,
    restoreVisit: {
      visitId: runtime.visitId,
      sourceIdentity: doc?.identity ?? null,
      outcome: !readable ? "Absent" : !restored ? "Pending" : !savedView || savedView.identity !== doc?.identity ? "Absent"
        : viewRestoration?.snapshot === savedView && viewRestoration.sourceIdentity === doc?.identity ? viewRestoration.outcome : "Pending",
    },
    onAttempt: (_signal, target) => {
      if (target.kind === "reader_destination" && target.destination.target.kind === "pdf_find") findRef.current?.clear();
      reader.retireNavigationAttempt();
      forkMiss(null);
    },
    apply: async (result, context) => {
      if (context.signal.aborted) return "Cancelled";
      if (result.kind === "chat_destination" || result.kind === "resource") return "Unavailable";
      if (result.kind === "highlight") return deliverHighlight(result.highlight_id, context);
      if (result.kind === "passage") {
        if (!doc) return "Unavailable";
        let location = locatePassage(doc, id, result.passage, result.canonical_source_ref);
        if (!location && doc.kind === "pdf" && result.passage.source_ref === `media:${id}`) {
          const page = await reader.locatePdfPassage(result.passage, context.signal);
          if (page !== null) location = { target: { kind: "point", point: { kind: "pdf", page, y: 0 } },
            inspection: { identity: doc.identity, anchors: [], pages: [page], precision: "page" } };
        }
        if (context.signal.aborted) return "Cancelled";
        if (!location) return "Unavailable";
        if (!context.restored) {
          const outcome = await reader.inspect({ target: location.target, signal: context.signal });
          switch (outcome.kind) {
            case "Unavailable": return "FailureHandled";
            case "Cancelled": return "Cancelled";
            case "Arrived":
            case "Unchanged": break;
            default: assertNever(outcome);
          }
        }
        const current = reader.getState().document;
        if (context.signal.aborted) return "Cancelled";
        if (current.status !== "ready" || current.doc.identity !== doc.identity) return "Unavailable";
        setInspection({ ...location.inspection, activationId: context.activationId });
        context.signal.addEventListener("abort", () => {
          setInspection(current => current?.activationId === context.activationId ? null : current);
        }, { once: true });
        if (context.mayFocus()) reader.focusSource();
        return "Applied";
      }
      const destination: ReaderDestination | null = result.kind === "reader_destination" ? result.destination : null;
      let sourcePoint: ReturnType<typeof targetOfSourcePoint> = null;
      if (result.kind === "source" && result.source.location.kind === "point") {
        if (!doc) return "Unavailable";
        sourcePoint = targetOfSourcePoint(result.source.location, doc);
        if (sourcePoint === null) return "Unavailable";
      }
      if (destination !== null || sourcePoint !== null) {
        if (!doc) return "Unavailable";
        if (destination?.target.kind === "evidence_item") {
          return deliverEvidence(destination.target.item_id, destination.source_identity, context);
        }
        const target = sourcePoint ?? (destination !== null ? destinationTarget(destination, reader) : null);
        if (!target) return "Unavailable";
        if (!context.restored) {
          const outcome = await reader.inspect({ target, signal: context.signal });
          switch (outcome.kind) {
            case "Unavailable": {
              if (target.kind !== "pdf_find") return "FailureHandled";
              const failure = reader.getState().navigation.failure;
              if (failure) reader.dismissNavigationFailure(failure);
              return "Unavailable";
            }
            case "Cancelled": return "Cancelled";
            case "Arrived":
            case "Unchanged": break;
            default: assertNever(outcome);
          }
        } else if (target.kind === "pdf_find" && !await reader.restorePdfFind(target, context.signal)) {
          return context.signal.aborted ? "Cancelled" : "Unavailable";
        }
        if (context.signal.aborted) return "Cancelled";
        if (target.kind === "range") {
          setInspection({ identity: doc.identity, anchors: [{ kind: "text", unit: target.unit, start: target.start, end: target.end }], pages: [], precision: "exact", activationId: context.activationId });
          context.signal.addEventListener("abort", () => {
            setInspection((current) => current?.activationId === context.activationId ? null : current);
          }, { once: true });
        }
        if (context.mayFocus()) reader.focusSource();
        return "Applied";
      }
      if (result.kind !== "source") return "Unavailable";
      const source = result.source;
      if (source.location.kind === "resource") {
        if (context.mayFocus()) {
          if (doc) reader.focusSource();
          else if (root.current) { root.current.tabIndex = -1; root.current.focus({ preventScroll: true }); }
        }
        return "Applied";
      }
      if (source.location.kind === "x_post") {
        if (doc?.kind !== "text") return "Unavailable";
        const captureId = source.location.capture_id;
        const units = doc.units.filter(unit => unit.xPost?.relation === "primary" && unit.xPost.owner?.capture_id === captureId);
        if (units.length !== 1) return "Unavailable";
        if (!context.restored) {
          const outcome = await reader.inspect({ target: { kind: "point", point: { kind: "text", unit: units[0].id, offset: 0 } }, signal: context.signal });
          if (outcome.kind === "Cancelled") return "Cancelled";
          if (outcome.kind === "Unavailable") return "FailureHandled";
        }
        if (context.signal.aborted) return "Cancelled";
        if (context.mayFocus()) reader.focusSource();
        return "Applied";
      }
      if (!doc || source.location.kind !== "located") return "Unavailable";
      const { locator, precision, source_identity, apparatus_reference_id } = source.location;
      if (locator.type === "x_capture_offsets") {
        if (source_identity !== locator.capture_id || doc.kind !== "text") return "Unavailable";
        const unit = doc.units.find(item => {
          const owner = item.xPost?.owner;
          return owner != null && owner.capture_id === locator.capture_id && owner.fragment_id === locator.fragment_id;
        });
        if (!unit || locator.end_offset > unit.length || locator.text_quote_selector && Array.from(unit.text).slice(locator.start_offset, locator.end_offset).join("") !== locator.text_quote_selector.exact) return "Unavailable";
      } else if (source_identity === null || source_identity !== readingPublicationIdentity(doc)) return "Unavailable";
      if (apparatus_reference_id !== null) {
        return deliverEvidence(`reader_apparatus_item:${apparatus_reference_id}`, doc.identity, context);
      }
      if ((locator.type === "web_text_offsets" || locator.type === "epub_fragment_offsets") && doc.kind === "text") {
        const unit = doc.units.find((unit) => unit.id === locator.fragment_id || unit.xPost?.owner?.fragment_id === locator.fragment_id);
        if (!unit) return "Unavailable";
        const start = localPoint(doc, { unit: unit.id, offset: locator.start_offset });
        const end = localPoint(doc, { unit: unit.id, offset: locator.end_offset });
        if (start === null || end === null || start.unit !== end.unit) return "Unavailable";
        if (locator.text_quote_selector) {
          // Same quote identity as text_quote.py; a relocation retains its original words.
          const normalized = (value: string) => value.normalize("NFC")
            .replace(/[\p{White_Space}\u001c-\u001f]+/gu, " ").replace(/^ | $/g, "");
          const selected = Array.from(unit.text).slice(start.offset, end.offset).join("");
          if (normalized(selected) !== normalized(locator.text_quote_selector.exact)) return "Unavailable";
        }
      }
      if (locator.type === "transcript_time_range" && doc.kind === "text" && locator.text_quote_selector) {
        const actual = doc.units.filter((unit) => unit.time && unit.time.endMs > locator.t_start_ms && unit.time.startMs < locator.t_end_ms).map((unit) => unit.text).join("\n");
        if (actual !== locator.text_quote_selector.exact) return "Unavailable";
      }
      const target = targetOfLocator(locator, doc);
      const paint = inspectionOfLocator(locator, doc, precision);
      if (!target || !paint) return "Unavailable";
      if (!context.restored) {
        const outcome = await reader.inspect({ target, signal: context.signal });
        switch (outcome.kind) {
          case "Unavailable": return "FailureHandled";
          case "Cancelled": return "Cancelled";
          case "Arrived":
          case "Unchanged": break;
          default: assertNever(outcome);
        }
      }
      const current = reader.getState().document;
      if (context.signal.aborted) return "Cancelled";
      if (current.status !== "ready" || current.doc.identity !== doc.identity) return "Unavailable";
      setInspection({ ...paint, activationId: context.activationId });
      context.signal.addEventListener("abort", () => {
        setInspection((current) => current?.activationId === context.activationId ? null : current);
      }, { once: true });
      if (context.mayFocus()) reader.focusSource();
      return "Applied";
    },
  });
  arrivalRef.current = arrival;
  useArrivalFailure(arrival.failure);
  const { clear: clearArrival } = arrival;
  useEffect(() => {
    if (inspection && navigationMode === "Reading") clearArrival();
  }, [clearArrival, inspection, navigationMode]);

  const openEvidence = useCallback((item: string | null) => {
    if (requestVisit.current !== runtime.visitId) return;
    // Clear only a pending evidence arrival, including its initial map wait.
    if (pendingEvidenceArrival.current && !pendingEvidenceArrival.current.aborted) clearArrival();
    if (item) void requestEvidence(item, null);
    else latestOpenRequest.current?.onResolved(null);
    requestSecondarySurface("resource-connections");
  }, [clearArrival, requestEvidence, requestSecondarySurface, runtime.visitId]);
  const canQuote = media.capabilities?.can_quote === true;
  const marks = annotations.local.status === "ready" ? annotations.decorations.marks : null;
  // the host knows its own title and a part's source title; other owners keep their stubs.
  const sourceLabel = useCallback((sourceRef: string) => sourceRef === `media:${id}` ? { kind: media.kind, label: media.title }
    : doc?.kind === "text" && doc.units.some(unit => unit.xPost?.owner && `fragment:${unit.xPost.owner.fragment_id}` === sourceRef) ? { kind: "x_capture", label: "post" }
    : media.part_source && doc?.kind === "text" && doc.part && sourceRef === `media:${doc.part.mediaId}` ? { kind: "media", label: media.part_source.title }
    : null, [doc, id, media]);
  const verbs = useAnnotationVerbs({ reader, mediaId: id, sourceLabel, isMobile, active: paneActive && paneVisible, store, marks, openEvidence,
    quoteReview: arrival.quoteReview ? { target: arrival.quoteReview, finish: arrival.finishQuoteReview } : null });
  verbsRef.current = { isMobile, verbs };

  const decorations = useMemo<Decorations>(
    () => ({ ...annotations.decorations, focused: verbs.focused, hovered: verbs.hovered }),
    [annotations.decorations, verbs.focused, verbs.hovered],
  );

  // ---- find ----
  const findSource = useReaderState(reader, (s) => s.restored ? s.find : null);
  const find = useFind({ ownerKey: paneSourceKey(runtime), source: findSource,
    onSearchIntent: () => arrival.supersede({ preserveSignal: null, retireFailure: true }),
  });
  findRef.current = find;

  // ---- evidence and chrome ----
  const { noteEdit, annotate, hovered, hover, closeNoteEdit, relocate } = verbs;
  const actions = useMemo<EvidenceActions>(
    () => ({
      verbs: { noteEdit, annotate, hovered, hover, closeNoteEdit, relocate },
      sourceContext: media.kind !== "text_part",
      mediaLabel: media.title,
      refresh: store.refresh,
    }),
    [annotate, closeNoteEdit, hover, hovered, media.kind, media.title, noteEdit, relocate, store],
  );
  const evidence = useMemo(
    () => (
      <EvidencePane
        key={runtime.visitId}
        state={annotations}
        reader={reader}
        actions={actions}
        openKey={openKey}
        onRetry={store.refresh}
        sourceAbsent={sourceAbsent}
      />
    ),
    [actions, annotations, openKey, reader, runtime.visitId, sourceAbsent, store],
  );
  const contents = useMemo(
    () =>
      doc?.kind === "text" && (media.kind === "text_part" || media.kind === "epub" || media.kind === "web_article" || doc.toc.length > 0 || doc.sourceIssues.length > 0) ? (
        <HostedContents id={id} media={media} reader={reader} focusTarget={() => root.current?.querySelector<HTMLElement>("[data-pane-content]") ?? null} />
      ) : undefined,
    [doc, id, media, reader],
  );
  const markerTarget = useCallback((marker: string): ReaderDestination["target"] => {
    const embed = doc?.kind === "text" ? doc.embeds.find((entry) => `embed:${entry.id}` === marker) : null;
    const unit = embed?.fragment_id;
    return unit ? { kind: "point", point: { kind: "text", unit, offset: embed?.locator.canonical_start_offset ?? 0 } }
      : { kind: "evidence_item", item_id: marker };
  }, [doc]);
  const onMarker = useCallback((marker: string) => {
    const target = markerTarget(marker);
    if (target.kind === "evidence_item") openEvidence(target.item_id);
    else void reader.inspect({ target });
  }, [markerTarget, openEvidence, reader]);
  const apparatusDestination = useCallback((key: string): ReaderDestination | null => {
    const remote = annotations.remote;
    if (!doc || remote.status !== "ready" || remote.data.identity !== doc.identity) return null;
    const root = remote.data.evidence.roots.find((root) => matchesEvidence(root, key));
    return root ? { source_identity: doc.identity, target: { kind: "evidence_item", item_id: key } } : null;
  }, [annotations.remote, doc]);
  const speak = useActiveRegion();
  const bounds = verbs.bounds;
  const boundsPrompt: Line | null = !bounds ? null : bounds.issue ?? (bounds.phase === "Submitting" ? null : { fact: bounds.scope.kind === "quote"
    ? "select text matching the original quote." : bounds.scope.kind === "page" ? "select the new passage on this page." : "select the new passage in this section." });
  useReaderChrome({
    media,
    // a refresh that finds the item gone retires its inspector; any other refresh failure says nothing.
    gone: record.error?.code === "E_MEDIA_NOT_FOUND",
    reader,
    find,
    readable,
    contents,
    evidence,
    markers: annotations.markers,
    onMarker,
    markerTarget,
    isMobile,
    paneActive,
  });
  useReaderActivity(id, reader, root, paneActive, isMobile);

  // ---- render ----
  const sourceLine = mediaSourceLine(media.processing_status, media.last_error_code);
  const transcriptChrome = transcript ? (
    <TranscriptChrome media={media} paneActive={paneActive} videoAt={videoAt} onSeek={seek} reader={reader}
      transcriptReaderKey={snapshot?.transcript_reader_key ?? null} />
  ) : null;
  const captureHint = media.capabilities.can_replace_x_article && media.canonical_source_url
    ? <Fact line={{ fact: "nexus capture can update this saved article." }} speak={speak}
      verbs={[{ label: "open on x", href: media.canonical_source_url }]} />
    : null;
  if (!readable)
    return (
      <div className={styles.stateScrollport} data-mobile={isMobile} ref={root} tabIndex={-1} onBlurCapture={cancelTranscriptFocus}>
        <div className={styles.state}>
          {transcriptChrome}
          {captureHint}
          {transcript && media.processing_status !== "suspended" ? (
            <TranscriptState media={media} holdFocus={holdTranscriptFocus} />
          ) : sourceLine ? (
            media.processing_status === "failed" ? <FailedSource mediaId={id} code={media.last_error_code} line={sourceLine} />
              : <Fact line={sourceLine} speak={speak} verbs={[{ label: "view imports", href: "/imports",
                onActivate: (event) => activateTargetLink({ event, runtime, target: { href: "/imports" } }) }]} />
          ) : (
            <Fact line={{ fact: "preparing this item for reading." }} speak={speak} />
          )}
        </div>
      </div>
    );

  const finished = row && summaries.resolve(row.media_summary)?.consumption.state === "Finished";
  const next = finished ? lecternNext(lectern, id, "Readable") : null;
  // Finish and leave the Lectern (its Undo puts the row back), then open the row the prompt named.
  const openNext = (target: LecternItem, intent: OpenIntent) => run({
    ref: `media:${id}`,
    id: "Consumption",
    label: "finish and open next",
    feedbackLabel: "finish and open next",
    title: media.title,
    confirmation: null,
    tracked: true,
    execute: () => openAsyncResult({ ctx, originPaneId: runtime.paneId, intent, create: async () => {
      await ctx.consumption.finish(id, { title: media.title, leaveLectern: true });
      const { media_id: mediaId, title } = target.media_summary;
      return { target: { href: `/media/${mediaId}`, labelHint: title }, title: "marked finished", openLabel: "open next" };
    } }),
  });
  const prompt = next ? <LecternNextPrompt title={next.media_summary.title} onSelect={(intent) => openNext(next, intent)} /> : null;
  const embeds = doc?.kind === "text" ? doc.embeds : [];

  return (
    <div className={styles.layout} ref={root} tabIndex={-1} data-focus-mode={profile.focus_mode} onBlurCapture={cancelTranscriptFocus}>
      <HostedReaderView
        mediaId={id}
        transcriptReaderKey={snapshot?.transcript_reader_key ?? null}
        reader={reader}
        profile={profile}
        isMobile={isMobile}
        showCaptureTitle={false}
        failure={(error, retry) => isApiError(error) ? <Failed error={error} noun="this document’s contents" retry={retry} /> : null}
        saveFailure={positionFeedback.saveFailure}
        loadFailure={positionFeedback.loadFailure}
        decorations={decorations}
        inspection={inspection}
        activePassage={verbs.composer.activePassage}
        onSelection={media.capabilities?.can_highlight === false ? undefined : verbs.onSelection}
        onMarks={verbs.onMarks}
        onApparatus={(key, _rect, kind, intent) => {
          if (kind !== "activate") return;
          if (intent !== "new_pane") return openEvidence(key);
          const destination = apparatusDestination(key);
          if (!destination) return forkMiss("couldn’t open that location.");
          reader.navigation!.activate(destination, intent, () => openEvidence(key));
        }}
        apparatusDestination={apparatusDestination}
        onSeekTime={transcript ? seek : undefined}
        renderPostActions={(unit) => unit.xPost ? <PostActions key={JSON.stringify([unit.id, unit.xPost.owner?.capture_id ?? null])} post={unit.xPost} hostMediaId={id} state={postSaves} /> : null}
        renderCitation={citation => <ReaderCitation {...citation} />}
        renderEmbed={(occurrence) => {
          const embed = embeds.find((e) => e.occurrence_key === occurrence);
          return embed ? <EmbedCard embed={embed} reader={reader} /> : null;
        }}
        before={
          <>
            <PostSaveReadFailure state={postSaves} />
            {documentFailed && annotations.local.annotations.length ? <>
              <Fact line={{ fact: PLACEMENT_COPY.unavailable }} />
              <AnnotationList annotations={annotations.local.annotations} />
            </> : null}
            {transcriptChrome}
          </>
        }
        lane={
          <>
            {!isMobile && boundsPrompt ? <Fact line={boundsPrompt} speak={speak}
              verbs={bounds?.phase === "Selecting" ? [{ label: "cancel", commandKey: "CancelHighlightBounds", run: verbs.cancelBounds }] : undefined} /> : null}
            {inspection && inspection.precision !== "exact" ? <Fact speak={speak}
              line={{ fact: inspection.precision === "time" ? "located by time, not by text." : "this location is approximate." }} /> : null}
            {media.provider === "x" && media.processing_status === "failed" ? <Fact speak={speak}
              line={media.last_error_code === "E_X_IDENTITY_CONFLICT"
                ? { fact: "these saved threads overlap and need repair.", reason: "both are kept." }
                : { fact: "couldn’t refresh from x.", reason: "the saved copy is kept." }} /> : null}
            {doc?.kind === "text" && doc.transcriptCoverage === "partial" ? <Fact line={{ fact: "this transcript is partial." }} /> : null}
            {captureHint}
          </>
        }
        end={
          doc?.kind === "text" && doc.format !== "transcript" ? (
            <>
              <p>{media.kind === "text_part" ? "end of piece" : doc.format === "epub" ? "End of book" : "End of article"}</p>
              {prompt}
            </>
          ) : null
        }
      />
      {media.kind === "pdf" ? prompt : null}
      {isMobile ? <PositionRibbon reader={reader} /> : null}
      <SelectionDock
        verbs={verbs}
        reader={reader}
        readerScrollport={readerScrollport}
        store={store}
        isMobile={isMobile}
        canQuote={canQuote}
        returnFocus={returnFocus}
        sharePiece={media.kind === "text_part" ? trigger => openShare(resourceShareTarget(`media:${id}`), anchoredShareOpenOptions(trigger, () => root.current)) : null}
      />
    </div>
  );
}
