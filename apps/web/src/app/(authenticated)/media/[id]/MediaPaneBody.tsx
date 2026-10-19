"use client";

// The media pane: the media record and its states, the shared document reader
// over the media's publication and cursor, the annotations painted over it,
// find, the chrome around it, and reading activity. Everything positional is
// the reader's; this file only composes.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { FeedbackNotice, FeedbackState, FeedbackStatus } from "@/components/feedback/Feedback";
import LecternNextPrompt from "@/components/LecternNextPrompt";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { apiFetch } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
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
import {
  paneSourceKey,
  requirePaneRuntime,
  usePaneIsActive,
  usePaneIsVisible,
  usePaneParam,
  usePaneRuntime,
} from "@/lib/panes/paneRuntime";
import { usePlayerCommands, usePlayerSession } from "@/lib/player/playerRuntime";
import { useSourceArrival } from "@/lib/reader/sourceArrival";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useMobileChrome, useMobileChromeHold } from "@/lib/mobileShell/chrome";
import { useReaderActivity } from "./activity";
import { createAnnotationStore } from "./annotations";
import { useReaderChrome } from "./chrome";
import EmbedCard from "./Embeds";
import { subscribeLinkMutations } from "@/lib/resourceGraph/links";
import EvidencePane from "./evidence/EvidencePane";
import type { EvidenceActions } from "./evidence/EvidenceRow";
import {
  hostedProgress,
  hostedSource,
  inspectionOfLocator,
  targetOfLocator,
  useReaderVisit,
} from "./hostedReader";
import SelectionDock from "./SelectionDock";
import { TranscriptChrome, TranscriptState } from "./Transcript";
import { useAnnotationVerbs } from "./useAnnotationVerbs";
import styles from "./media.module.css";

export default function MediaPaneBody() {
  const id = usePaneParam("id");
  if (!id) throw new Error("media route requires an id");
  return <MediaPane key={id} id={id} />;
}

function MediaPane({ id }: { readonly id: string }) {
  const runtime = requirePaneRuntime(usePaneRuntime(), "MediaPaneBody");
  const { activateTarget, requestSecondarySurface } = runtime;
  const paneActive = usePaneIsActive();
  const paneVisible = usePaneIsVisible();
  const isMobile = useIsMobileViewport();
  const { profile } = useReaderContext();
  const lectern = lecternItems(useLectern());
  const { ctx, run } = useActionRuntime();
  // MediaPane is keyed by id: completion may navigate only while that origin still exists.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
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
        host: { scrollport: chrome.registerReaderScrollport },
      }),
      [chrome, entry, id],
    ),
    readable,
  );
  readerRef.current = reader;
  const restored = useReaderState(reader, (s) => s.restored);
  const navigationMode = useReaderState(reader, (s) => s.navigation.mode);
  const doc = useReaderState(reader, (s) => (s.document.status === "ready" ? s.document.doc : null));
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
  const subscribeAnnotations = useCallback(
    (listener: () => void) => readable ? store.subscribe(listener) : () => {},
    [readable, store],
  );
  useEffect(() => {
    if (readable) return subscribeLinkMutations(store.refresh);
  }, [readable, store]);
  const annotations = useSyncExternalStore(subscribeAnnotations, store.getState, store.getState);
  useEffect(() => {
    // The map belongs to another publication: read it again for this one.
    if (readable && doc && annotations.decorations.identity && annotations.decorations.identity !== doc.identity) store.refresh();
  }, [annotations.decorations.identity, doc, readable, store]);
  const [openKey, setOpenKey] = useState<{ id: string } | null>(null);
  const openEvidence = useCallback(
    (item: string | null) => {
      if (item) setOpenKey({ id: item });
      requestSecondarySurface("resource-connections");
    },
    [requestSecondarySurface],
  );
  const canQuote = media?.capabilities?.can_quote === true;
  const marks = annotations.map.status === "ready" ? annotations.decorations.marks : null;
  const verbs = useAnnotationVerbs({ mediaId: id, reader, active: paneActive && paneVisible, store, marks, canQuote, openEvidence });

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
      if (result.location.kind === "resource") {
        if (context.mayFocus()) {
          if (doc) reader.focusSource();
          else if (root.current) { root.current.tabIndex = -1; root.current.focus({ preventScroll: true }); }
        }
        return true;
      }
      if (!doc || result.location.kind !== "located") return false;
      const { locator, precision, source_identity } = result.location;
      if (source_identity !== doc.identity) return false;
      if ((locator.type === "web_text_offsets" || locator.type === "epub_fragment_offsets") && doc.kind === "text") {
        const unit = doc.units.find((unit) => unit.id === locator.fragment_id);
        if (!unit || locator.end_offset > unit.length) return false;
        if (locator.text_quote_selector && Array.from(unit.text).slice(locator.start_offset, locator.end_offset).join("") !== locator.text_quote_selector.exact) return false;
      }
      if (locator.type === "transcript_time_range" && doc.kind === "text" && locator.text_quote_selector) {
        const actual = doc.units.filter((unit) => unit.time && unit.time.endMs > locator.t_start_ms && unit.time.startMs < locator.t_end_ms).map((unit) => unit.text).join("\n");
        if (actual !== locator.text_quote_selector.exact) return false;
      }
      const target = targetOfLocator(locator);
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
  const clearInspection = arrival.clear;
  useEffect(() => {
    if (inspection && navigationMode === "Reading") clearInspection();
  }, [clearInspection, inspection, navigationMode]);

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
  const { noteEdit, hovered, hover, closeNoteEdit } = verbs;
  const actions = useMemo<EvidenceActions>(
    () => ({
      verbs: { noteEdit, hovered, hover, closeNoteEdit },
      refresh: store.refresh,
    }),
    [closeNoteEdit, hover, hovered, noteEdit, store],
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
  const onMarker = useCallback(
    (marker: string) => {
      const embed = doc?.kind === "text" ? doc.embeds.find((e) => `embed:${e.id}` === marker) : undefined;
      if (embed?.fragment_id) {
        const offset = embed.locator.canonical_start_offset ?? 0;
        void reader.inspect({ target: { kind: "point", point: { kind: "text", unit: embed.fragment_id, offset } } });
      } else openEvidence(marker);
    },
    [doc, openEvidence, reader],
  );
  const annotationNotice = useMemo(() => !verbs.selectionIssue && !verbs.bounds ? null : <>
    {verbs.selectionIssue ? <FeedbackNotice announcement="Polite" content={{ tone: "Warning", title: verbs.selectionIssue }} /> : null}
    {verbs.bounds ? <FeedbackNotice announcement="Polite" content={{ tone: verbs.bounds.issue ? "Warning" : "Neutral",
      title: verbs.bounds.phase === "Submitting" ? "updating highlighted passage…"
        : verbs.bounds.issue ?? "select the new passage in this text section. escape cancels." }}
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
    <TranscriptChrome media={media} paneActive={paneActive} videoAt={videoAt} onSeek={seek} />
  ) : null;
  if (!readable)
    return (
      <div className={styles.stateScrollport} data-mobile={isMobile} ref={root} tabIndex={-1}>
        <div className={styles.state}>
          {arrival.failure ? <FeedbackNotice content={{ tone: "Warning", title: arrival.failure }} announcement={paneActive ? "Polite" : "None"} /> : null}
          {transcriptChrome}
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
  const openNext = (target: LecternItem) => run({
    ref: `media:${id}`,
    id: "Consumption",
    label: "finish and open next",
    title: media.title,
    confirmation: null,
    tracked: true,
    execute: async () => {
      await ctx.consumption.finish(id, { leaveLectern: true });
      if (!mounted.current) return;
      const { media_id: mediaId, title } = target.media_summary;
      activateTarget({ target: { href: `/media/${mediaId}`, labelHint: title }, disposition: { kind: "Fork" } });
    },
  });
  const prompt = next ? <LecternNextPrompt title={next.media_summary.title} onSelect={() => openNext(next)} /> : null;
  const embeds = doc?.kind === "text" ? doc.embeds : [];

  return (
    <div className={styles.layout} ref={root} tabIndex={-1} data-focus-mode={profile.focus_mode}>
      {verbs.notice ? <FeedbackStatus content={verbs.notice} announcement={paneActive ? "Polite" : "None"} /> : null}
      <DocumentReaderView
        reader={reader}
        profile={profile}
        isMobile={isMobile}
        announcement={paneActive ? "Polite" : "None"}
        decorations={decorations}
        inspection={inspection}
        activePassage={verbs.composer.activePassage}
        onSelection={media.capabilities?.can_highlight === false ? undefined : verbs.onSelection}
        onMarks={verbs.onMarks}
        onApparatus={(key, _rect, kind) => kind === "activate" && openEvidence(key)}
        onSeekTime={transcript ? seek : undefined}
        renderEmbed={(occurrence) => {
          const embed = embeds.find((e) => e.occurrence_key === occurrence);
          return embed ? <EmbedCard embed={embed} /> : null;
        }}
        before={
          <>
            {arrival.failure ? <FeedbackNotice content={{ tone: "Warning", title: arrival.failure }} announcement={paneActive ? "Polite" : "None"} /> : null}
            {inspection && inspection.precision !== "exact" ? <FeedbackStatus content={{ tone: "Neutral", title: inspection.precision === "time" ? "timed passage" : "approximate source location" }} announcement={paneActive ? "Polite" : "None"} /> : null}
            {transcriptChrome}
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
