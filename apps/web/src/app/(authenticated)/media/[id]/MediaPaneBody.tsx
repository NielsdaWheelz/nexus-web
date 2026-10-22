"use client";

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
} from "react";
import { FeedbackNotice, FeedbackState, FeedbackStatus } from "@/components/feedback/Feedback";
import LecternNextPrompt from "@/components/LecternNextPrompt";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { apiFetch } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { openStream } from "@/lib/api/stream";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { Contents, SourceIssuesNotice } from "@/lib/documentReader/chrome/Contents";
import { PositionRibbon } from "@/lib/documentReader/chrome/MapRail";
import DocumentReaderView, {
  useDocumentReader,
  useReaderState,
  type Decorations,
  type Inspection,
  type Reader,
} from "@/lib/documentReader/DocumentReader";
import type { FindSource } from "@/lib/find/find";
import { useFind } from "@/lib/find/useFind";
import { holdProgress } from "@/lib/consumption/state";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { lecternItems, lecternNext, useLectern } from "@/lib/lectern/lectern";
import type { LecternItem } from "@/lib/lectern/api";
import { mediaDetailFromResponse, type MediaDetail } from "@/lib/media/mediaDetail";
import { mediaErrorMessage } from "@/lib/media/mediaErrorMessage";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { useMediaMetadataOperations } from "@/lib/media/mediaMetadataOperations";
import { useMediaProcessingStatus } from "@/lib/media/useMediaProcessingStatus";
import { savedSourceReadFailure } from "@/lib/imports/copy";
import { fetchAcceptedSource } from "@/lib/imports/ingest";
import {
  paneSourceKey,
  requirePaneRuntime,
  usePaneIsActive,
  usePaneIsVisible,
  usePaneParam,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { usePlayerCommands, usePlayerSession } from "@/lib/player/playerRuntime";
import { useSourceArrival, type SourceArrivalContext } from "@/lib/reader/sourceArrival";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { sourceTargetFromHref } from "@/lib/resources/sourceTarget";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { OpenIntent, TargetActivationEvent } from "@/lib/ui/targetActivation";
import { openAsyncResult } from "@/lib/panes/openResult";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { useMobileChrome, useMobileChromeHold } from "@/lib/mobileShell/chrome";
import { useReaderActivity } from "./activity";
import { createAnnotationStore } from "./annotations";
import { useReaderChrome } from "./chrome";
import EmbedCard, { PostActions } from "./Embeds";
import { subscribeLinkMutations } from "@/lib/resourceGraph/links";
import EvidencePane from "./evidence/EvidencePane";
import type { EvidenceActions } from "./evidence/EvidenceRow";
import type { EvidenceOpenRequest } from "./evidence/EvidenceRow";
import { matches as matchesEvidence } from "./evidence/model";
import type { ReaderDestination } from "@/lib/documentReader/location";
import {
  hostedProgress,
  hostedSource,
  inspectionOfLocator,
  targetOfLocator,
  useReaderVisit,
  readerDestinationHref,
  destinationTarget,
} from "./hostedReader";
import SelectionDock from "./SelectionDock";
import { TranscriptChrome, TranscriptState } from "./Transcript";
import { useAnnotationVerbs } from "./useAnnotationVerbs";
import styles from "./media.module.css";

export default function MediaPaneBody() {
  const id = usePaneParam("id");
  const runtime = requirePaneRuntime(usePaneRuntime(), "MediaPaneBody");
  if (!id) throw new Error("media route requires an id");
  const attemptId = runtime.searchParams.get("source_attempt_id");
  if (attemptId !== null && sourceTargetFromHref(runtime.href)?.kind !== "invalid_destination")
    return <AcceptedSourcePane key={attemptId} attemptId={attemptId} />;
  return <MediaPane key={id} id={id} />;
}

/** Acceptance survives deduplication; mount the reader only after its identity settles. */
function AcceptedSourcePane({ attemptId }: { readonly attemptId: string }) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "AcceptedSourcePane");
  const visible = usePaneIsVisible();
  const source = usePaneFreeServerValue({
    key: `source-attempt:${attemptId}`,
    stale: "",
    load: (signal) => fetchAcceptedSource(attemptId, signal),
  });
  const result = source.status === "ready" ? source.data : null;
  const settled = result?.settled === true;
  const error = source.status === "loading" ? null : source.error;
  const viewImports = { label: "view imports", href: "/imports", onActivate: (event: TargetActivationEvent) =>
    activateTargetLink({ event, runtime, target: { href: "/imports" } }) };
  // justify-polling: an accepted source has no identity event stream. Only visible,
  // unsettled handoffs poll; failed reads stop until the reader explicitly retries.
  useIntervalPoll({
    enabled: visible && result !== null && !settled && error === null,
    pollIntervalMs: 2_000,
    onPoll: () => {
      if (document.visibilityState === "visible") source.refetch();
    },
  });
  useEffect(() => {
    if (settled && result !== null) runtime.router.replace(`/media/${result.media_id}`);
  }, [result, runtime.router, settled]);
  if (error !== null)
    return <FeedbackState content={savedSourceReadFailure(error)} announcement="Polite"
      actions={[{ label: "try again", onClick: source.refetch,
        busy: source.status === "failed" ? source.retrying : source.status === "ready" && source.refreshing },
      viewImports]} />;
  if (settled)
    return <PaneLoadingState label="opening your saved source" announcement="Polite" />;
  if (source.status === "loading")
    return <FeedbackState content={{ tone: "Neutral", title: "opening your saved source" }}
      announcement="Polite" actions={[viewImports]} />;
  return <FeedbackState content={{ tone: "Neutral", title: "source saved",
    message: "waiting for source processing. imports shows its progress and recovery options." }}
    announcement="Polite" actions={[viewImports]} />;
}

function MediaPane({ id }: { readonly id: string }) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "MediaPaneBody");
  const { requestSecondarySurface } = runtime;
  const paneActive = usePaneIsActive();
  const paneVisible = usePaneIsVisible();
  const isMobile = useIsMobileViewport();
  const { profile } = useReaderContext();
  const lectern = lecternItems(useLectern());
  const { ctx, run } = useActionRuntime();
  // J4: the media's Lectern row (membership is the Lectern's) and its read state (the summary
  // owner's, which follows Consumption, so a reading auto-finish shows here at once).
  const row = lectern.find((item) => item.media_summary.media_id === id);
  const summaries = useMediaSummaries(row ? [row.media_summary] : []);
  const { seekTo, resume } = usePlayerCommands();
  const player = usePlayerSession();
  const root = useRef<HTMLDivElement>(null);

  // ---- the media record ----
  const record = usePaneFreeServerValue({
    key: `/media/${id}`,
    stale: "",
    load: async (signal) =>
      mediaDetailFromResponse(
        await apiFetch<ApiJson<"/media/{media_id}", "get">>(`/api/media/${encodeURIComponent(id)}`, { signal }),
        id,
      ),
  });
  const loaded = record.status === "ready" ? record.data : null;
  const [media, setMedia] = useState<MediaDetail | null>(null);
  useEffect(() => {
    if (loaded) setMedia(loaded);
  }, [loaded]);
  const { snapshot } = useMediaProcessingStatus(media?.id ?? null);
  useEffect(() => {
    if (snapshot) setMedia((current) => current && { ...current, ...snapshot });
  }, [snapshot]);
  const transcript = media?.kind === "podcast_episode" || media?.kind === "video";
  const readable = media?.capabilities?.can_read === true;

  // ---- the reader ----
  const readerRef = useRef<Reader | null>(null);
  const navigationRuntime = useRef(runtime);
  navigationRuntime.current = runtime;
  const [navigationFailure, setNavigationFailure] = useState<string | null>(null);
  const savedView = useReaderVisit(readerRef);
  const entry = useMemo(() => ({ fresh: null, cold: null, view: savedView }), [savedView]);
  const chrome = useMobileChrome();
  const reader = useDocumentReader(
    id,
    useMemo(
      () => ({
        source: hostedSource(id),
        progress: hostedProgress(id),
        entry,
        host: { scrollport: chrome.registerReaderScrollport, navigation: {
          href: (destination: ReaderDestination) => readerDestinationHref(id, destination),
          activate: (destination: ReaderDestination, intent: OpenIntent, onDefault: () => void) => {
            setNavigationFailure(null);
            if (intent === "default") return onDefault();
            const href = readerDestinationHref(id, destination);
            if (href === null) return setNavigationFailure("location unavailable");
            navigationRuntime.current.activateTarget({ target: { href }, disposition: { kind: "Fork" } });
          },
        } },
      }),
      [chrome, entry, id],
    ),
    readable,
  );
  readerRef.current = reader;
  const restored = useReaderState(reader, (s) => s.restored);
  const navigationMode = useReaderState(reader, (s) => s.navigation.mode);
  const doc = useReaderState(reader, (s) => (s.document.status === "ready" ? s.document.doc : null));
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
        // A final stream refusal gets one fresh projection through the reader's error owner.
        onError: () => reader.reload(),
      }),
    );
    return () => stops.forEach((close) => close());
  }, [articleIds, paneVisible, reader]);
  useEffect(() => {
    if (readable && doc && media?.reader_generation != null && doc.identity !== `g${media.reader_generation}`)
      reader.reload(media.reader_generation);
  }, [doc, media?.reader_generation, readable, reader]);
  // Unread, reset and undo of this media: unsaved progress settles first, the server's cursor after.
  useEffect(
    () =>
      holdProgress({
        prepare: (mediaId) => (mediaId === id ? reader.prepareProgressFence() : Promise.resolve()),
        reconcile: (mediaId) => (mediaId === id ? reader.reconcileProgressFence() : Promise.resolve()),
      }),
    [id, reader],
  );

  // A title job is admitted with source publication, before naming may fail.
  // Manual title admission costs the same small reread; it does not reload progress.
  const metadata = useMediaMetadataOperations(paneVisible && media ? id : null);
  const stamp = metadata.view?.last_enriched_at != null ? metadata.view.last_enriched_at : null;
  const operation = metadata.view?.operation;
  const titleJob = operation?.purpose === "title" ? operation.job_id : null;
  useEffect(() => {
    if (!media) return;
    const recorded = media.metadata_enrichment.operation;
    const recordedTitleJob = recorded?.purpose === "title" ? recorded.job_id : null;
    const titleAdmitted = titleJob !== null && titleJob !== recordedTitleJob;
    const metadataPublished = stamp !== null && media.metadata_enriched_at !== stamp;
    if (!titleAdmitted && !metadataPublished) return;
    let active = true;
    void apiFetch<ApiJson<"/media/{media_id}", "get">>(`/api/media/${id}`).then((response) => {
      if (!active) return;
      const detail = mediaDetailFromResponse(response, id);
      setMedia(detail);
      // The readiness transition owns the first load; metadata refreshes an existing publication.
      if (readable && detail.capabilities.can_read && !transcript) reader.reload();
    });
    return () => { active = false; };
  }, [id, media, readable, reader, stamp, titleJob, transcript]);

  // ---- annotations ----
  const [store] = useState(() => createAnnotationStore(id));
  useEffect(() => { if (doc) store.bind(doc); }, [doc, store]);
  const subscribeAnnotations = useCallback(
    (listener: () => void) => readable ? store.subscribe(listener) : () => {},
    [readable, store],
  );
  useEffect(() => {
    if (readable) return subscribeLinkMutations(store.refresh);
  }, [readable, store]);
  const annotations = useSyncExternalStore(subscribeAnnotations, store.getState, store.getState);
  const notesStamp = useChangeStamp("Notes");
  const observedNotes = useRef(notesStamp);
  useEffect(() => {
    const notesChanged = observedNotes.current !== notesStamp;
    observedNotes.current = notesStamp;
    // Note writes change direct membership and previews independently of publication.
    if (readable && (notesChanged || doc && annotations.decorations.identity && annotations.decorations.identity !== doc.identity)) store.refresh();
  }, [annotations.decorations.identity, doc, notesStamp, readable, store]);
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
  /** Moves playback to a time; `play` also resumes the global player. */
  const cue = useCallback(
    (ms: number, play: boolean) => {
      if (media?.kind === "video") return setVideoAt(ms);
      if (player.state.kind !== "Loaded" || player.state.source.kind !== "Episode" || player.state.source.descriptor.media_id !== id) return;
      seekTo(ms);
      if (play) resume();
    },
    [id, media?.kind, player.state, resume, seekTo],
  );
  const seek = useCallback((ms: number) => cue(ms, true), [cue]);

  // The chosen pane alone resolves, positions and paints a source arrival.
  const [inspection, setInspection] = useState<(Inspection & { activationId: string }) | null>(null);
  const arrival = useSourceArrival({
    ready: restored || (media !== null && !readable),
    sourceIdentity: doc?.identity ?? null,
    apply: async (result, context) => {
      if (result.kind === "reader_destination") {
        if (!doc) return false;
        const { destination } = result;
        if (destination.target.kind === "evidence_item") {
          if (context.restored) return true;
          latestOpenRequest.current?.onResolved(null);
          pendingEvidenceArrival.current = context.signal;
          try {
            const map = await new Promise<ReturnType<typeof store.getState>["map"] | null>((resolve) => {
              let unsubscribe = () => {};
              const settle = (value: ReturnType<typeof store.getState>["map"] | null) => { unsubscribe(); context.signal.removeEventListener("abort", abort); resolve(value); };
              const abort = () => settle(null);
              const check = () => { const map = store.getState().map; if (map.status !== "loading") settle(map); };
              unsubscribe = store.subscribe(check);
              context.signal.addEventListener("abort", abort, { once: true });
              if (context.signal.aborted) abort(); else check();
            });
            if (!map || map.status !== "ready" || map.data.identity !== destination.source_identity || context.signal.aborted) return false;
            const itemId = destination.target.item_id;
            if (!map.data.evidence.roots.some((root) => matchesEvidence(root, itemId))) return false;
            const delivered = requestEvidence(itemId, context);
            requestSecondarySurface("resource-connections");
            return await delivered;
          } finally {
            if (pendingEvidenceArrival.current === context.signal) pendingEvidenceArrival.current = null;
          }
        }
        const target = destinationTarget(destination, reader);
        if (!target) return false;
        if (!context.restored) {
          const outcome = await reader.inspect({ target, signal: context.signal });
          if (outcome.kind !== "Arrived" && outcome.kind !== "Unchanged") return false;
        }
        if (context.signal.aborted) return false;
        if (context.mayFocus()) reader.focusSource();
        return true;
      }
      const source = result.source;
      if (source.location.kind === "resource") {
        if (context.mayFocus()) {
          if (doc) reader.focusSource();
          else if (root.current) { root.current.tabIndex = -1; root.current.focus({ preventScroll: true }); }
        }
        return true;
      }
      if (!doc || source.location.kind !== "located") return false;
      const { locator, precision, source_identity } = source.location;
      if (source_identity !== doc.identity) return false;
      if ((locator.type === "web_text_offsets" || locator.type === "epub_fragment_offsets") && doc.kind === "text") {
        const unit = doc.units.find((unit) => unit.id === locator.fragment_id || unit.xPost?.owner?.fragment_id === locator.fragment_id);
        if (!unit || locator.end_offset > unit.length) return false;
        if (locator.text_quote_selector) {
          // Same quote identity as text_quote.py; a relocation retains its original words.
          const normalized = (value: string) => value.normalize("NFC")
            .replace(/[\p{White_Space}\u001c-\u001f]+/gu, " ").replace(/^ | $/g, "");
          const selected = Array.from(unit.text).slice(locator.start_offset, locator.end_offset).join("");
          if (normalized(selected) !== normalized(locator.text_quote_selector.exact)) return false;
        }
      }
      if (locator.type === "transcript_time_range" && doc.kind === "text" && locator.text_quote_selector) {
        const actual = doc.units.filter((unit) => unit.time && unit.time.endMs > locator.t_start_ms && unit.time.startMs < locator.t_end_ms).map((unit) => unit.text).join("\n");
        if (actual !== locator.text_quote_selector.exact) return false;
      }
      const target = targetOfLocator(locator, doc);
      const paint = inspectionOfLocator(locator, doc, precision);
      if (!target || !paint) return false;
      if (!context.restored) {
        const outcome = await reader.inspect({ target, signal: context.signal });
        if (outcome.kind !== "Arrived" && outcome.kind !== "Unchanged") return false;
      }
      const current = reader.getState().document;
      if (context.signal.aborted || current.status !== "ready" || current.doc.identity !== source_identity) return false;
      setInspection({ ...paint, activationId: context.activationId });
      context.signal.addEventListener("abort", () => {
        setInspection((current) => current?.activationId === context.activationId ? null : current);
      }, { once: true });
      if (context.mayFocus()) reader.focusSource();
      return true;
    },
  });
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
  const canQuote = media?.capabilities?.can_quote === true;
  const marks = annotations.map.status === "ready" ? annotations.decorations.marks : null;
  const verbs = useAnnotationVerbs({ reader, active: paneActive && paneVisible, store, marks, openEvidence });

  const decorations = useMemo<Decorations>(
    () => ({ ...annotations.decorations, focused: verbs.focused, hovered: verbs.hovered }),
    [annotations.decorations, verbs.focused, verbs.hovered],
  );

  // ---- find ----
  const source = useReaderState(reader, (s) => s.restored ? s.find : null);
  const partial = media?.transcript_state === "partial" || media?.transcript_coverage === "partial";
  const findSource = useMemo<FindSource<unknown> | null>(
    () =>
      source && partial
        ? {
            ...source,
            search: async (...args: Parameters<typeof source.search>) => {
              const outcome = await source.search(...args);
              return outcome.kind === "Rows" ? { ...outcome, partial: "available transcript" } : outcome;
            },
          }
        : source,
    [partial, source],
  );
  const find = useFind({ ownerKey: paneSourceKey(runtime), source: findSource });

  // ---- evidence and chrome ----
  const { noteEdit, hovered, hover, closeNoteEdit, relocate } = verbs;
  const actions = useMemo<EvidenceActions>(
    () => ({
      verbs: { noteEdit, hovered, hover, closeNoteEdit, relocate },
      refresh: store.refresh,
    }),
    [closeNoteEdit, hover, hovered, noteEdit, relocate, store],
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
      />
    ),
    [actions, annotations, openKey, reader, runtime.visitId, store],
  );
  const contents = useMemo(
    () =>
      doc?.kind === "text" && (doc.toc.length > 0 || doc.sourceIssues.length > 0) ? (
        <>
          <SourceIssuesNotice issues={doc.sourceIssues} readable />
          <Contents reader={reader} />
        </>
      ) : undefined,
    [doc, reader],
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
    const map = annotations.map;
    if (!doc || map.status !== "ready" || map.data.identity !== doc.identity) return null;
    const root = map.data.evidence.roots.find((root) => matchesEvidence(root, key));
    return root ? { source_identity: doc.identity, target: { kind: "evidence_item", item_id: key } } : null;
  }, [annotations.map, doc]);
  const annotationNotice = useMemo(() => !verbs.selectionIssue && !verbs.bounds ? null : <>
    {verbs.selectionIssue ? <FeedbackNotice announcement="Polite" content={{ tone: "Warning", title: verbs.selectionIssue }} /> : null}
    {verbs.bounds ? <FeedbackNotice announcement="Polite" content={{ tone: verbs.bounds.issue ? "Warning" : "Neutral",
      title: verbs.bounds.phase === "Submitting" ? "updating highlighted passage…"
        : verbs.bounds.issue ?? (verbs.bounds.unit === null
          ? "select text matching the original quote to relocate it. escape cancels."
          : "select the new passage in this text section. escape cancels.") }}
      actions={verbs.bounds.phase === "Selecting" ? [{ label: "cancel", onClick: verbs.cancelBounds }] : undefined}
    /> : null}
  </>, [verbs.bounds, verbs.cancelBounds, verbs.selectionIssue]);
  useMobileChromeHold(isMobile && paneActive && paneVisible && annotationNotice !== null);
  useReaderChrome({
    media,
    failed: record.status === "failed",
    reader,
    find,
    readable,
    contents,
    evidence,
    annotationNotice,
    markers: annotations.markers,
    onMarker,
    markerTarget,
    isMobile,
    paneActive,
  });
  useReaderActivity(id, reader, root, paneActive, isMobile);

  // ---- render ----
  if (record.status === "loading" || (record.status === "ready" && !media))
    return (
      <div className={styles.stateScrollport} data-mobile={isMobile}>
        <PaneLoadingState label="loading item…" announcement={paneActive ? "Polite" : "None"} />
      </div>
    );
  if (record.status === "failed" || !media) {
    const missing = record.status === "failed" && record.error.status === 404;
    return (
      <div className={styles.stateScrollport} data-mobile={isMobile} ref={root} tabIndex={-1}>
        <div className={styles.state}>
          <FeedbackState
            content={{ tone: "Danger", title: missing ? "item not found" : "couldn’t load this item" }}
            announcement={paneActive ? "Polite" : "None"}
            actions={!missing && record.status === "failed" ? [{ label: "retry", onClick: record.refetch, busy: record.retrying }] : undefined}
            returnFocus={() => root.current?.querySelector<HTMLElement>("[data-pane-content]") ?? root.current}
          />
        </div>
      </div>
    );
  }
  const sourceError = mediaErrorMessage({
    kind: "Source",
    processingStatus: media.processing_status,
    lastErrorCode: media.last_error_code,
    capabilities: { can_retry: media.capabilities?.can_retry === true },
    sourceUrl: media.canonical_source_url,
  });
  const transcriptChrome = transcript ? (
    <TranscriptChrome media={media} paneActive={paneActive} videoAt={videoAt} onSeek={seek} reader={reader} />
  ) : null;
  const captureHint = media.capabilities.can_replace_x_article && media.canonical_source_url
    ? <FeedbackNotice content={{ tone: "Neutral", title: "update saved article",
      message: "capture that page with nexus to update this saved article." }} announcement="None"
      actions={[{ label: "open article on x", href: media.canonical_source_url }]} />
    : null;
  if (!readable)
    return (
      <div className={styles.stateScrollport} data-mobile={isMobile} ref={root} tabIndex={-1}>
        <div className={styles.state}>
          {arrival.failure ? <FeedbackNotice content={{ tone: "Warning", title: arrival.failure }} announcement={paneActive ? "Polite" : "None"} /> : null}
          {transcriptChrome}
          {captureHint}
          {transcript ? (
            <TranscriptState media={media} onChange={(next) => setMedia({ ...media, ...next })}
              announcement={paneActive ? "Polite" : "None"}
              returnFocus={() => root.current?.querySelector<HTMLElement>("[data-pane-content]") ?? root.current}
            />
          ) : sourceError ? (
            <FeedbackState content={sourceError} announcement={paneActive ? "Polite" : "None"}
              actions={sourceError.action.kind === "OpenSource" ? [{ label: "open source", href: sourceError.action.href }] : undefined}
            />
          ) : (
            <FeedbackState content={{ tone: "Neutral", title: "preparing this item for reading" }} announcement={paneActive ? "Polite" : "None"} />
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
    title: media.title,
    confirmation: null,
    tracked: true,
    execute: () => openAsyncResult({ ctx, originPaneId: runtime.paneId, intent, create: async () => {
      await ctx.consumption.finish(id, { leaveLectern: true });
      const { media_id: mediaId, title } = target.media_summary;
      return { target: { href: `/media/${mediaId}`, labelHint: title }, title: "finished", openLabel: "open next on the lectern" };
    } }),
  });
  const prompt = next ? <LecternNextPrompt title={next.media_summary.title} onSelect={(intent) => openNext(next, intent)} /> : null;
  const embeds = doc?.kind === "text" ? doc.embeds : [];

  return (
    <div className={styles.layout} ref={root} tabIndex={-1} data-focus-mode={profile.focus_mode}>
      {verbs.notice ? <FeedbackStatus content={verbs.notice} announcement={paneActive ? "Polite" : "None"} /> : null}
      <DocumentReaderView
        reader={reader}
        profile={profile}
        isMobile={isMobile}
        showCaptureTitle={false}
        announcement={paneActive ? "Polite" : "None"}
        decorations={decorations}
        inspection={inspection}
        activePassage={verbs.composer.activePassage}
        onSelection={media.capabilities?.can_highlight === false ? undefined : verbs.onSelection}
        onMarks={verbs.onMarks}
        onApparatus={(key, _rect, kind, intent) => {
          if (kind !== "activate") return;
          if (intent !== "new_pane") return openEvidence(key);
          const destination = apparatusDestination(key);
          if (!destination) return setNavigationFailure("location unavailable");
          reader.navigation!.activate(destination, intent, () => openEvidence(key));
        }}
        apparatusDestination={apparatusDestination}
        onSeekTime={transcript ? seek : undefined}
        renderPostActions={(unit) => unit.xPost ? <PostActions key={unit.id} post={unit.xPost} /> : null}
        renderEmbed={(occurrence) => {
          const embed = embeds.find((e) => e.occurrence_key === occurrence);
          return embed ? <EmbedCard embed={embed} /> : null;
        }}
        before={
          <>
            {navigationFailure ? <FeedbackNotice content={{ tone: "Warning", title: navigationFailure }} announcement="Polite" /> : null}
            {arrival.failure ? <FeedbackNotice content={{ tone: "Warning", title: arrival.failure }} announcement={paneActive ? "Polite" : "None"} /> : null}
            {inspection && inspection.precision !== "exact" ? <FeedbackStatus content={{ tone: "Neutral", title: inspection.precision === "time" ? "timed passage" : "approximate source location" }} announcement={paneActive ? "Polite" : "None"} /> : null}
            {media.provider === "x" && media.processing_status === "failed" ? <FeedbackNotice
              content={{ tone: "Warning", title: media.last_error_code === "E_X_IDENTITY_CONFLICT"
                ? "these saved threads overlap. both were kept; repair is required."
                : "couldn’t refresh from x. saved copy kept." }} announcement={paneActive ? "Polite" : "None"} /> : null}
            {transcriptChrome}
            {captureHint}
          </>
        }
        end={
          doc?.kind === "text" && doc.format !== "transcript" ? (
            <>
              <p>{doc.format === "epub" ? "End of book" : "End of article"}</p>
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
        store={store}
        isMobile={isMobile}
        canQuote={canQuote}
      />
    </div>
  );
}
