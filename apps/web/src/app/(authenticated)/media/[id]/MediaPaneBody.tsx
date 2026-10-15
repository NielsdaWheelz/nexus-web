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
  type ComponentProps,
} from "react";
import { FeedbackNotice, useFeedback } from "@/components/feedback/Feedback";
import LecternNextPrompt from "@/components/LecternNextPrompt";
import Pill from "@/components/ui/Pill";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { apiFetch } from "@/lib/api/client";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import type { ReaderTarget } from "@/lib/documentReader/model";
import { Contents, SourceIssuesNotice } from "@/lib/documentReader/chrome/Contents";
import { PositionRibbon } from "@/lib/documentReader/chrome/MapRail";
import DocumentReaderView, {
  useDocumentReader,
  useReaderState,
  type Decorations,
} from "@/lib/documentReader/DocumentReader";
import type { FindSource } from "@/lib/find/find";
import { useFind } from "@/lib/find/useFind";
import { holdProgress, useFinish } from "@/lib/consumption/state";
import { lecternItems, lecternNext, useLectern, type LecternItem } from "@/lib/lectern/lectern";
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
  useSetPaneLabel,
} from "@/lib/panes/paneRuntime";
import { usePlayerCommands } from "@/lib/player/playerRuntime";
import { useReaderContext } from "@/lib/reader/ReaderContext";
import { activateResource } from "@/lib/resources/activation";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useMobileChrome } from "@/lib/mobileShell/chrome";
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
  targetOfGroup,
  useLiveReaderTargets,
  useReaderEntry,
  type Arrival,
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
  const { activateTarget, requestSecondarySurface, closeSecondaryPane } = runtime;
  const paneActive = usePaneIsActive();
  const paneVisible = usePaneIsVisible();
  const isMobile = useIsMobileViewport();
  const feedback = useFeedback();
  const { profile } = useReaderContext();
  const lectern = lecternItems(useLectern());
  const finish = useFinish();
  // J4: the media's Lectern row (membership is the Lectern's) and its read state (the summary
  // owner's, which follows Consumption, so a reading auto-finish shows here at once).
  const row = lectern.find((item) => item.media_summary.media_id === id);
  const summaries = useMediaSummaries(row ? [row.media_summary] : []);
  const { seekTo, resume } = usePlayerCommands();
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
  useSetPaneLabel(media ? media.title.trim() || "Media" : null);
  const { snapshot } = useMediaProcessingStatus(media?.id ?? null, media?.processing_status ?? "");
  useEffect(() => {
    if (snapshot) setMedia((current) => current && { ...current, ...snapshot });
  }, [snapshot]);
  const transcript = media?.kind === "podcast_episode" || media?.kind === "video";
  const readable = media?.capabilities?.can_read === true;

  // ---- the reader ----
  const { entry, arrival, apparatusKey } = useReaderEntry(id);
  const chrome = useMobileChrome();
  const reader = useDocumentReader(
    id,
    useMemo(
      () => ({
        source: hostedSource(id),
        progress: hostedProgress(id),
        entry,
        host: { holdChrome: chrome.hold, scrollport: chrome.registerReaderScrollport },
      }),
      [chrome, entry, id],
    ),
    readable,
  );
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
  const [openKey, setOpenKey] = useState<{ id: string } | null>(apparatusKey ? { id: apparatusKey } : null);
  const openEvidence = useCallback(
    (item: string | null) => {
      if (item) setOpenKey({ id: item });
      requestSecondarySurface("resource-connections");
    },
    [requestSecondarySurface],
  );
  const canQuote = media?.capabilities?.can_quote === true;
  const marks = annotations.map.status === "ready" ? annotations.decorations.marks : null;
  const verbs = useAnnotationVerbs({ mediaId: id, store, marks, canQuote, openEvidence });

  // ---- playback: the global player, or a video's own embed ----
  const [videoAt, setVideoAt] = useState<number | null>(null);
  /** Moves playback to a time; `play` also resumes the global player. */
  const cue = useCallback(
    (ms: number, play: boolean) => {
      if (media?.kind === "video") return setVideoAt(ms);
      seekTo(ms);
      if (play) resume();
    },
    [media?.kind, resume, seekTo],
  );
  const seek = useCallback((ms: number) => cue(ms, true), [cue]);

  // ---- deep-link arrivals: focus, underline, flash; a transcript's playback follows a move ----
  const [shown, setShown] = useState<Omit<Arrival, "target"> | null>(null);
  const [moved, setMoved] = useState<ReaderTarget | null>(null);
  const arrive = useCallback(
    (next: Arrival, move: boolean) => {
      setShown(next);
      if (next.focused) verbs.focus(next.focused);
      if (move) setMoved(next.target);
    },
    [verbs],
  );
  useEffect(() => {
    if (!moved || !doc || !media) return;
    setMoved(null);
    const unit =
      moved.kind === "range" ? moved.unit : moved.kind === "point" && moved.point.kind === "text" ? moved.point.unit : null;
    const ms = moved.kind === "time" ? moved.ms : doc.kind === "text" ? doc.units.find((u) => u.id === unit)?.time?.startMs : undefined;
    if (transcript && ms !== undefined) cue(ms, false);
  }, [cue, doc, media, moved, transcript]);
  useEffect(() => {
    let live = true;
    void arrival?.then((settled) => {
      if (!live) return;
      if (settled) arrive(settled, true);
      else feedback.publish({ kind: "Hud", content: { tone: "Warning", title: "That passage is no longer available." } });
    });
    if (apparatusKey) openEvidence(apparatusKey);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: one entry per pane
  }, [arrival]);
  useLiveReaderTargets(id, reader, arrive);

  const decorations = useMemo<Decorations>(
    () => ({
      ...annotations.decorations,
      focused: verbs.focused,
      hovered: verbs.hovered,
      evidence: shown?.evidence ?? null,
      pulse: shown?.pulse ?? null,
    }),
    [annotations.decorations, shown, verbs.focused, verbs.hovered],
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
  const { noteEdit, hovered, hover, focus, closeNoteEdit } = verbs;
  const actions = useMemo<EvidenceActions>(
    () => ({
      verbs: { noteEdit, hovered, hover, closeNoteEdit },
      sources: new Map(
        annotations.map.status !== "loading" && annotations.map.data
          ? annotations.map.data.evidence.source_targets.map((target) => [target.ref, target])
          : [],
      ),
      open: (activation, disposition, labelHint) =>
        activateResource(activation, { labelHint, disposition, activateTarget }),
      jumpToSource: (target) => {
        const to = targetOfGroup(target.resolution);
        if (to) void reader.inspect({ target: to });
      },
      refresh: store.refresh,
      openLink: (href, disposition) => activateTarget({ target: { href }, disposition }),
    }),
    [activateTarget, annotations.map, closeNoteEdit, hover, hovered, noteEdit, reader, store],
  );
  const onJump = useCallback(
    (group: Parameters<ComponentProps<typeof EvidencePane>["onJump"]>[0]) => {
      const to = targetOfGroup(group.resolution);
      const highlight = group.items.find((item) => item.kind === "Highlight");
      if (highlight?.kind === "Highlight") focus(highlight.highlight_id);
      if (to?.kind === "time") seek(to.ms);
      if (to) void reader.inspect({ target: to });
      if (isMobile) closeSecondaryPane();
    },
    [closeSecondaryPane, focus, isMobile, reader, seek],
  );
  const evidence = useMemo(
    () => (
      <EvidencePane
        resourceRef={`media:${id}`}
        state={annotations}
        reader={reader}
        actions={actions}
        openKey={openKey}
        onRetry={store.refresh}
        onJump={onJump}
      />
    ),
    [actions, annotations, id, onJump, openKey, reader, store],
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
  const dismissTarget = useCallback(() => setShown(null), []);
  useReaderChrome({
    media,
    failed: record.status === "failed",
    reader,
    find,
    readable,
    contents,
    evidence,
    markers: annotations.markers,
    onMarker,
    isMobile,
    paneActive,
    onDismissTarget: dismissTarget,
  });
  useReaderActivity(id, reader, root, paneActive, isMobile);

  // ---- render ----
  if (record.status === "loading" || (record.status === "ready" && !media))
    return <PaneLoadingState label="Loading item…" announcement="Polite" />;
  if (record.status === "failed" || !media) {
    const missing = record.status === "failed" && record.error.status === 404;
    return (
      <div className={styles.state}>
        <FeedbackNotice
          content={{ tone: "Danger", title: missing ? "Media not found" : "Media couldn’t be loaded" }}
          announcement="Assertive"
        />
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
  const retrievalError = mediaErrorMessage({ kind: "Retrieval", retrievalStatus: media.retrieval_status });
  const banners =
    profile.focus_mode === "distraction_free"
      ? null
      : [sourceError, retrievalError].map((error) =>
          error ? (
            <div key={error.kind} className={styles.banner}>
              <Pill tone={error.severity === "error" ? "danger" : "warning"}>{error.title}</Pill>
              <span>{error.explanation}</span>
            </div>
          ) : null,
        );
  const transcriptChrome = transcript ? (
    <TranscriptChrome media={media} paneActive={paneActive} videoAt={videoAt} onSeek={seek} />
  ) : null;
  if (!readable)
    return (
      <div className={styles.state} ref={root}>
        {transcriptChrome}
        {transcript ? (
          <TranscriptState media={media} onChange={(next) => setMedia({ ...media, ...next })} />
        ) : sourceError ? (
          <>
            <p>{sourceError.title}</p>
            <p>{sourceError.explanation}</p>
            {sourceError.action.kind === "OpenSource" ? (
              <a href={sourceError.action.href} target="_blank" rel="noopener noreferrer">
                Open source
              </a>
            ) : null}
          </>
        ) : (
          <>
            <p>This media is still being processed.</p>
            <p>Status: {media.processing_status}</p>
          </>
        )}
      </div>
    );

  const finished = row && summaries.resolve(row.media_summary)?.consumption.state === "Finished";
  const next = finished ? lecternNext(lectern, id, "Readable") : null;
  // Finish and leave the Lectern (its Undo puts the row back), then open the row the prompt named.
  const openNext = async (target: LecternItem) => {
    await finish(id, { leaveLectern: true });
    const { media_id: mediaId, title } = target.media_summary;
    activateTarget({ target: { href: `/media/${mediaId}`, labelHint: title }, disposition: { kind: "Fork" } });
  };
  const prompt = next ? <LecternNextPrompt title={next.media_summary.title} onSelect={() => void openNext(next)} /> : null;
  const embeds = doc?.kind === "text" ? doc.embeds : [];

  return (
    <div className={styles.layout} ref={root} data-focus-mode={profile.focus_mode}>
      <DocumentReaderView
        reader={reader}
        profile={profile}
        isMobile={isMobile}
        decorations={decorations}
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
            {banners}
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
        store={store}
        isMobile={isMobile}
        canQuote={canQuote}
        onOpenLink={(href, disposition) => activateTarget({ target: { href }, disposition })}
      />
    </div>
  );
}
