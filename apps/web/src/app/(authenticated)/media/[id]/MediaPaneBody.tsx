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
import { useResourceActionCompletionUndo } from "@/lib/actions/resourceActionRuntime";
import { apiFetch, isApiError } from "@/lib/api/client";
import { mediaResource } from "@/lib/api/resource";
import { clientResourceFetcher } from "@/lib/api/resourceTransport.client";
import { useResource } from "@/lib/api/useResource";
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
import { useLectern } from "@/lib/lectern/LecternProvider";
import { parseMediaId } from "@/lib/lectern/contract";
import { canReadMediaDocument } from "@/lib/media/documentReadiness";
import { mediaDetailFromResponse, type MediaDetail } from "@/lib/media/mediaDetail";
import { mediaErrorMessage } from "@/lib/media/mediaErrorMessage";
import { useMediaMetadataOperations } from "@/lib/media/mediaMetadataOperations";
import { useMediaProcessingStatus } from "@/lib/media/useMediaProcessingStatus";
import { loadMediaPane } from "@/lib/panes/paneResourceLoaders";
import {
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
import { useMobileChromeReaderScrollport, useMobileChromeVisibleLocks } from "@/lib/workspace/mobileChrome";
import { useReaderActivity } from "./activity";
import { createAnnotationStore } from "./annotations";
import { useReaderChrome } from "./chrome";
import EmbedCard from "./Embeds";
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
  const lectern = useLectern();
  const offerUndo = useResourceActionCompletionUndo();
  const { seekTo, resume } = usePlayerCommands();
  const root = useRef<HTMLDivElement>(null);

  // ---- the media record ----
  const seed = useResource({
    descriptor: mediaResource,
    params: { id },
    load: (params: { id: string }, signal: AbortSignal) => loadMediaPane(clientResourceFetcher(signal), params),
  });
  const [media, setMedia] = useState<MediaDetail | null>(null);
  useEffect(() => {
    if (seed.status === "ready") setMedia(seed.data.media);
  }, [seed]);
  useSetPaneLabel(media ? media.title.trim() || "Media" : null);
  const { snapshot } = useMediaProcessingStatus(media?.id ?? null, media?.processing_status ?? "");
  useEffect(() => {
    if (snapshot) setMedia((current) => current && { ...current, ...snapshot });
  }, [snapshot]);
  const transcript = media?.kind === "podcast_episode" || media?.kind === "video";
  const readable = media !== null && canReadMediaDocument(media);

  // ---- the reader ----
  const { entry, arrival, apparatusKey } = useReaderEntry(id);
  const locks = useMobileChromeVisibleLocks();
  const registerScrollport = useMobileChromeReaderScrollport({ sourceKey: id, enabled: isMobile && paneActive });
  const latest = useRef({ locks, registerScrollport });
  latest.current = { locks, registerScrollport };
  const reader = useDocumentReader(
    id,
    useMemo(
      () => ({
        source: hostedSource(id),
        progress: hostedProgress(id),
        entry,
        host: {
          holdChrome: () => latest.current.locks.acquire("reader-positioning"),
          scrollport: (element: HTMLElement) => latest.current.registerScrollport(element) ?? undefined,
        },
      }),
      [entry, id],
    ),
  );
  const readableRef = useRef(readable);
  useEffect(() => {
    // A publication that became readable (processing, a transcript) is read now.
    if (readable && !readableRef.current) reader.reload();
    readableRef.current = readable;
  }, [readable, reader]);
  const doc = useReaderState(reader, (s) => (s.document.status === "ready" ? s.document.doc : null));
  const finished = useReaderState(
    reader,
    (s) =>
      s.progress?.kind === "Ready" &&
      s.progress.view.kind === "Canonical" &&
      s.progress.view.snapshot.state === "Positioned" &&
      s.progress.view.snapshot.locator.kind !== "pdf" &&
      s.progress.view.snapshot.locator.locations.total_progression === 1,
  );
  useEffect(() => {
    if (finished) lectern.revalidate();
  }, [finished, lectern]);
  // A lectern progress reset: this reader's unsaved progress settles first, then
  // the reset cursor installs.
  useEffect(() => {
    const offInstall = lectern.onCanonicalInstall((event) => {
      if (event.kind === "progressState" && event.state.mediaId === id) reader.install(event.state.readerCursor);
    });
    const offDrain = lectern.registerBeforeProgressReset((mediaId) =>
      mediaId === id ? reader.drainForReset() : Promise.resolve(),
    );
    return () => {
      offInstall();
      offDrain();
    };
  }, [id, lectern, reader]);

  // Bibliography enrichment: re-read the record (and a document's publication).
  const metadata = useMediaMetadataOperations(paneVisible && media ? id : null);
  const stamp = metadata.view?.last_enriched_at.kind === "Present" ? metadata.view.last_enriched_at.value : null;
  useEffect(() => {
    if (!stamp || !media || media.metadata_enriched_at === stamp) return;
    void apiFetch<ApiJson<"/media/{media_id}", "get">>(`/api/media/${id}`).then((response) => {
      setMedia(mediaDetailFromResponse(response, id));
      if (!transcript) reader.reload();
    });
  }, [id, media, reader, stamp, transcript]);

  // ---- annotations ----
  const [store] = useState(() => createAnnotationStore(id));
  const annotations = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  useEffect(() => {
    // The map belongs to another publication: read it again for this one.
    if (doc && annotations.decorations.identity && annotations.decorations.identity !== doc.identity) store.refresh();
  }, [annotations.decorations.identity, doc, store]);
  const [openKey, setOpenKey] = useState<{ id: string } | null>(apparatusKey ? { id: apparatusKey } : null);
  const openEvidence = useCallback(
    (item: string | null) => {
      if (item) setOpenKey({ id: item });
      requestSecondarySurface("resource-evidence");
    },
    [requestSecondarySurface],
  );
  const canQuote = media?.capabilities?.can_quote === true;
  const verbs = useAnnotationVerbs({ mediaId: id, store, marks: annotations.decorations.marks, canQuote, openEvidence });

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
  const source = useReaderState(reader, (s) => s.find);
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
  const find = useFind(findSource);

  // ---- evidence and chrome ----
  const { noteEdit, hovered, hover, focus, closeNoteEdit, noteAccepted, noteMutation } = verbs;
  const actions = useMemo<EvidenceActions>(
    () => ({
      verbs: { noteEdit, hovered, hover, closeNoteEdit, noteAccepted, noteMutation },
      sources: new Map(
        annotations.map.status === "ready"
          ? annotations.map.data.evidence.source_targets.map((target) => [target.ref, target])
          : [],
      ),
      open: (activation, disposition, labelHint) =>
        activateResource(activation, { labelHint, disposition, activateTarget }),
      jumpToSource: (target) => {
        const to = targetOfGroup(target.resolution);
        if (to) void reader.inspect(to);
      },
      refresh: store.refresh,
      openLink: (href, disposition) => activateTarget({ target: { href }, disposition }),
    }),
    [activateTarget, annotations.map, closeNoteEdit, hover, hovered, noteAccepted, noteEdit, noteMutation, reader, store],
  );
  const onJump = useCallback(
    (group: Parameters<ComponentProps<typeof EvidencePane>["onJump"]>[0]) => {
      const to = targetOfGroup(group.resolution);
      const highlight = group.items.find((item) => item.kind === "Highlight");
      if (highlight?.kind === "Highlight") focus(highlight.highlight_id);
      if (to?.kind === "time") seek(to.ms);
      if (to) void reader.inspect(to);
      if (isMobile) closeSecondaryPane();
    },
    [closeSecondaryPane, focus, isMobile, reader, seek],
  );
  const evidence = useMemo(
    () => (
      <EvidencePane
        state={annotations}
        reader={reader}
        actions={actions}
        openKey={openKey}
        onRetry={store.refresh}
        onJump={onJump}
      />
    ),
    [actions, annotations, onJump, openKey, reader, store],
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
        void reader.inspect({ kind: "point", point: { kind: "text", unit: embed.fragment_id, offset } });
      } else openEvidence(marker);
    },
    [doc, openEvidence, reader],
  );
  const dismissTarget = useCallback(() => setShown(null), []);
  useReaderChrome({
    media,
    failed: seed.status === "error",
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
  if (seed.status === "loading" || (seed.status === "ready" && !media))
    return <PaneLoadingState label="Loading item…" announcement="Polite" />;
  if (seed.status === "error" || !media) {
    const missing = seed.status === "error" && isApiError(seed.error) && seed.error.status === 404;
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

  const next = (() => {
    const items = lectern.resource.status === "ready" ? lectern.resource.data.items : [];
    const index = items.findIndex((item) => item.mediaSummary.mediaId === id);
    if (index < 0 || items[index].consumption.state !== "Finished") return null;
    return items.slice(index + 1).find((item) => item.activation.kind === "Readable") ?? null;
  })();
  // Done finishes this media (with or without a lectern row) and names the next readable item.
  const openNext = async () => {
    const before = lectern.resource.status === "ready" ? lectern.resource.data : { items: [] };
    const result = await lectern.done(parseMediaId(id));
    offerUndo({ mediaId: parseMediaId(id), before, finishId: result.finishId, done: true });
    if (result.nextItem.kind === "Present")
      activateTarget({
        target: { href: result.nextItem.value.href, labelHint: result.nextItem.value.mediaSummary.title },
        disposition: { kind: "Fork" },
      });
  };
  const prompt = next ? <LecternNextPrompt title={next.mediaSummary.title} onSelect={() => void openNext()} /> : null;
  const embeds = doc?.kind === "text" ? doc.embeds : [];

  return (
    <div className={styles.layout} ref={root} data-focus-mode={profile.focus_mode} data-mobile-reader-interaction-root={paneActive || undefined}>
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
