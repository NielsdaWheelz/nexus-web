import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import PdfReader, {
  type PdfReaderNavigationAdapter,
  type PdfReaderNavigationPlacement,
  type PdfReaderNavigationTarget,
} from "@/components/PdfReader";
import ReaderNavigationStatus from "@/components/reader/ReaderNavigationStatus";
import TextDocumentReader from "@/components/reader/TextDocumentReader";
import ReaderDocumentMapDetail from "@/components/reader/ReaderDocumentMapDetail";
import ReaderDocumentMapOverviewRail from "@/components/reader/ReaderDocumentMapOverviewRail";
import ReaderSourceIssuesNotice from "@/components/reader/ReaderSourceIssuesNotice";
import { absent, present, type Presence } from "@/lib/api/presence";
import { buildCanonicalCursor, validateCanonicalText, type CanonicalCursorResult } from "@/lib/highlights/canonicalCursor";
import type { EpubFragmentContent } from "@/lib/media/epubFragment";
import type { ReaderNavigationTextPoint } from "@/lib/media/readerNavigation";
import type { Fragment } from "@/lib/media/transcriptView";
import type {
  ReaderDocumentMapMarker,
  ReaderMapMarkerPresentation,
} from "@/lib/reader/documentMap";
import { findSourceAnchor, findUniqueSourceLinkOwner, resolveReaderInternalLinkTarget, type EpubRestoreRequest } from "@/lib/reader/epubInternalLinks";
import {
  captureVisibleCanonicalTextRange,
  isCanonicalTextAnchorVisible,
  isTextViewportAtEnd,
  measureCanonicalTextAnchorViewportDelta,
  measureSourceAnchorViewportOrigin,
  restoreTextReaderPlacement,
  scrollToExactCanonicalTextAnchor,
  type TextReaderPlacement,
} from "@/lib/reader/canonicalTextAnchor";
import { useReaderNavigation, type ReaderNavigationAdapter, type ReaderNavigationOutcome } from "@/lib/reader/useReaderNavigation";
import type { ReaderCursorSnapshot } from "@/lib/reader/readerProgress";
import {
  buildReaderDocumentStructure,
  readerSectionAtPosition,
  readerTextPointOffset,
  type ReaderDocumentOverviewRange,
  type ReaderPositionedSection,
} from "@/lib/reader/readerDocumentPosition";
import type {
  PdfHighlightOut,
  PdfReaderDecorations,
} from "@/lib/reader/ReaderDecorations";
import {
  buildTextReaderLocatorAtOffset,
  createDocumentReaderSession,
  type LoadedDocumentReaderSession,
  type LoadedReaderDocument,
  type DocumentReaderSession,
} from "@/lib/reader/DocumentReaderSession";
import type { ReaderProgressView } from "@/lib/reader/ReaderProgressPort";
import { getPaneScrollTopPaddingPx, type ReaderScrollPositioner } from "@/lib/reader/paneScroll";
import { buildReaderSurfaceStyle } from "@/lib/reader/readerSurfaceStyle";
import type { ReaderProfile, ReaderResumeState } from "@/lib/reader/types";
import {
  OfflineReaderProgressPort,
  OfflineReaderSource,
} from "@/lib/offlineReading/OfflineReaderAdapters";
import {
  OFFLINE_READING_COPY,
} from "@/lib/offlineReading/presentation";
import type {
  OfflineReadingControllerRuntime,
  OpenedOfflineReading,
} from "@/lib/offlineReading/runtime";
import styles from "./offlineReading.module.css";

const offlinePositioner: ReaderScrollPositioner = {
  async run(operation) {
    await operation({
      setTop(scrollport, top) {
        scrollport.scrollTop = Math.max(0, top);
      },
      adjustTop(scrollport, delta) {
        scrollport.scrollTop = Math.max(0, scrollport.scrollTop + delta);
      },
      reveal(scrollport, target) {
        const top = target.getBoundingClientRect().top - scrollport.getBoundingClientRect().top;
        scrollport.scrollTop = Math.max(0, scrollport.scrollTop + top);
      },
    });
  },
};

const offlineAuthenticationError = () => false;
const offlineSignedUrlRefresh = () => undefined;
const acquireOfflineChromeLock = () => () => undefined;

/**
 * The packaged shelf never reaches the reader-profile service (offline
 * personalization is a non-goal), so it states the reading typography it
 * renders with. Without this the shared reader resolves `--reader-*` through
 * their fallbacks and sets prose in the mono stack.
 */
const OFFLINE_SHELF_READER_PROFILE: ReaderProfile = {
  theme: "dark",
  font_family: "serif",
  font_size_px: 19,
  line_height: 1.6,
  column_width_ch: 66,
  focus_mode: "off",
  hyphenation: "auto",
};
const offlineReaderSurfaceStyle = buildReaderSurfaceStyle(
  OFFLINE_SHELF_READER_PROFILE,
);

const noOfflinePdfDecorations: PdfReaderDecorations = {
  async loadPageHighlights(): Promise<readonly PdfHighlightOut[]> {
    return [];
  },
  async createHighlight(): Promise<PdfHighlightOut> {
    throw new Error("Highlights are unavailable in downloaded copies");
  },
  async updateHighlight(): Promise<void> {
    throw new Error("Highlights are unavailable in downloaded copies");
  },
};

type DocumentLoad =
  | { readonly kind: "Loading" }
  | { readonly kind: "Loaded"; readonly loaded: LoadedDocumentReaderSession }
  | { readonly kind: "Failed" };

function progressNotice(view: ReaderProgressView): string | null {
  switch (view.kind) {
    case "ContentChanged":
      return OFFLINE_READING_COPY.changedSourceNotice;
    case "SourceUnavailable":
      return OFFLINE_READING_COPY.sourceUnavailableNotice;
    case "Conflict":
      return OFFLINE_READING_COPY.conflictNotice;
    case "Canonical":
    case "Pending":
      return null;
  }
}

function progressSnapshot(view: ReaderProgressView): ReaderCursorSnapshot {
  if (view.kind === "Canonical") return view.snapshot;
  const baseline = view.kind === "Conflict" ? view.canonical : view.baseline;
  return { state: "Positioned", revision: baseline.revision, locator: view.device };
}

type OfflineNavigationTarget =
  | { kind: "Text"; destination: EpubRestoreRequest }
  | { kind: "Pdf"; target: PdfReaderNavigationTarget };
type OfflineNavigationPlacement =
  | { kind: "Text"; anchor: OfflineTextAnchor }
  | { kind: "Pdf"; placement: PdfReaderNavigationPlacement };
type OfflineNavigationAdapter = ReaderNavigationAdapter<OfflineNavigationTarget, OfflineNavigationPlacement>;
type OfflineNavigation = ReturnType<typeof useReaderNavigation<OfflineNavigationTarget, OfflineNavigationPlacement>>;

export default function OfflineDocumentReader({
  controller, mediaId, opened, authoritativeProgress, onClose, onRemoveRequested,
}: {
  readonly controller: OfflineReadingControllerRuntime;
  readonly mediaId: string;
  readonly opened: OpenedOfflineReading;
  readonly authoritativeProgress: ReaderProgressView | null;
  readonly onClose: () => void;
  readonly onRemoveRequested: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const session = useMemo(() => {
    void attempt;
    return createDocumentReaderSession({
      mediaId,
      source: new OfflineReaderSource(mediaId, opened),
      progress: new OfflineReaderProgressPort(controller, mediaId, opened),
    });
  }, [attempt, controller, mediaId, opened]);
  const [load, setLoad] = useState<DocumentLoad>({ kind: "Loading" });
  useEffect(() => {
    const abort = new AbortController();
    setLoad({ kind: "Loading" });
    session.load(abort.signal).then(
      (loaded) => { if (!abort.signal.aborted) setLoad({ kind: "Loaded", loaded }); },
      () => { if (!abort.signal.aborted) setLoad({ kind: "Failed" }); },
    );
    return () => abort.abort();
  }, [session]);
  if (load.kind === "Failed") return (
    <div className={styles.documentReader}>
      <p role="alert" className={styles.notice}>This downloaded copy could not be opened. Its files may be incomplete or no longer verified on this device.</p>
      <div className={styles.actions}>
        <button type="button" className={styles.action} onClick={() => setAttempt((current) => current + 1)}>Try again</button>
        <button type="button" className={styles.quietAction} onClick={onClose}>Back to downloads</button>
        <button type="button" className={styles.quietAction} onClick={onRemoveRequested}>Remove downloaded copy</button>
      </div>
    </div>
  );
  if (load.kind === "Loading") return <p role="status">Opening verified copy…</p>;
  return <LoadedOfflineDocumentReader
    key={`${opened.leaseId}:${attempt}`}
    mediaId={mediaId} opened={opened} loaded={load.loaded} session={session}
    authoritativeProgress={authoritativeProgress} onRemoveRequested={onRemoveRequested}
  />;
}

function LoadedOfflineDocumentReader({ mediaId, opened, loaded, session, authoritativeProgress, onRemoveRequested }: {
  mediaId: string;
  opened: OpenedOfflineReading;
  loaded: LoadedDocumentReaderSession;
  session: DocumentReaderSession;
  authoritativeProgress: ReaderProgressView | null;
  onRemoveRequested: () => void;
}) {
  const document = loaded.document;
  const pdfResources = useMemo(() => document.kind === "Pdf" ? {
    signedUrl: { status: "ready" as const, data: document.document },
    pageHighlights: { status: "ready" as const, data: [] },
    requestSignedUrlRefresh: offlineSignedUrlRefresh,
  } : null, [document]);
  const [initialSnapshot] = useState(() => progressSnapshot(authoritativeProgress ?? loaded.progress));
  const [progress, setProgress] = useState(authoritativeProgress ?? loaded.progress);
  const [saveFailed, setSaveFailed] = useState(false);
  const failedLocatorRef = useRef<ReaderResumeState | null>(null);
  const [changedSourceAcknowledged, setChangedSourceAcknowledged] = useState(false);
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  const resolutionBusyRef = useRef(false);
  const [applyFailed, setApplyFailed] = useState(false);
  const [captureUnavailable, setCaptureUnavailable] = useState(false);
  const [chosenSnapshot, setChosenSnapshot] = useState<ReaderCursorSnapshot | null>(null);
  const [adapterSource, setAdapterSource] = useState<string | null>(null);
  const adapterRef = useRef<OfflineNavigationAdapter | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const writeRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => { if (authoritativeProgress !== null) setProgress(authoritativeProgress); }, [authoritativeProgress]);

  const save = useCallback((locator: ReaderResumeState): Promise<void> => {
    // Native progress owns durability; preserve admission order across the bridge.
    const write = writeRef.current.then(async () => {
      const result = await session.progress.save(mediaId, locator);
      if (!mountedRef.current) return;
      setProgress(result.kind === "Canonical" || result.kind === "Conflict" ? result : result.view);
      failedLocatorRef.current = null;
      setSaveFailed(false);
    });
    writeRef.current = write.catch(() => {
      if (!mountedRef.current) return;
      failedLocatorRef.current = locator;
      setSaveFailed(true);
    });
    return write;
  }, [mediaId, session]);
  const adapter = useMemo<OfflineNavigationAdapter>(() => ({
    capture: () => adapterRef.current?.capture() ?? null,
    position: (request, signal) => adapterRef.current?.position(request, signal) ?? Promise.resolve({ kind: "Unavailable", reason: "CaptureUnavailable", displaced: false }),
  }), []);
  const navigation = useReaderNavigation({
    visitKey: `${mediaId}:${opened.leaseId}`,
    source: adapterSource,
    adapter,
    captureEligibleLocator: () => resolvingRef.current ? null : adapter.capture()?.locator ?? null,
    admitProgress: (locator) => { void save(locator).catch(() => undefined); },
    closeActivity: () => undefined,
  });
  const { applyCanonical } = navigation;
  const initializedRef = useRef(false);
  useEffect(() => {
    if (adapterSource === null || initializedRef.current) return;
    initializedRef.current = true;
    void applyCanonical(initialSnapshot, "Reset");
  }, [adapterSource, applyCanonical, initialSnapshot]);
  const textSource = `${mediaId}:offline:${opened.readerRevisionKey}:${opened.readerGeneration}`;
  const textAdapterReady = useCallback((next: OfflineNavigationAdapter | null) => {
    adapterRef.current = next;
    setAdapterSource(next === null ? null : textSource);
  }, [textSource]);
  const pdfAdapterReady = useCallback((next: PdfReaderNavigationAdapter | null) => {
    adapterRef.current = next === null ? null : {
      capture() {
        const checkpoint = next.capture();
        return checkpoint === null ? null : { ...checkpoint, placement: { kind: "Pdf", placement: checkpoint.placement } };
      },
      position(request, signal) {
        if (request.kind === "Canonical") return next.position(request, signal);
        if (request.kind === "Target") return request.target.kind === "Pdf"
          ? next.position({ kind: "Target", target: request.target.target }, signal)
          : Promise.resolve({ kind: "Unavailable", reason: "TargetUnavailable", displaced: false });
        const checkpoint = request.checkpoint;
        if (checkpoint.kind === "Saved") return next.position({ kind: "Checkpoint", checkpoint }, signal);
        return checkpoint.placement.kind === "Pdf"
          ? next.position({ kind: "Checkpoint", checkpoint: { ...checkpoint, placement: checkpoint.placement.placement } }, signal)
          : Promise.resolve({ kind: "Unavailable", reason: "SourceChanged", displaced: false });
      },
    };
    setAdapterSource(next?.source ?? null);
  }, []);
  const saveMovement = (locator: ReaderResumeState) => {
    if (!resolvingRef.current && navigation.eligibility.canAcquireProgress()) void save(locator).catch(() => undefined);
  };

  const resolveProgress = async (choice: "Canonical" | "Device") => {
    if (resolutionBusyRef.current) return;
    const keepInspecting = choice === "Device" && navigation.eligibility.isExploringWithoutOrigin();
    const held = choice === "Device" && !keepInspecting
      ? navigation.eligibility.heldReadingLocator() ?? (navigation.eligibility.canAcquireProgress() ? adapter.capture()?.locator ?? null : null)
      : null;
    if (choice === "Device" && !keepInspecting && held === null) { setCaptureUnavailable(true); return; }
    resolvingRef.current = true;
    resolutionBusyRef.current = true;
    setResolving(true);
    setCaptureUnavailable(false);
    setApplyFailed(false);
    navigation.cancelPositioning();
    try {
      await writeRef.current;
      if (held !== null) await save(held);
      // The existing native authority resolves its current conflict. It has no
      // revision/abort argument; acquisition is fenced until verified arrival.
      const next = await session.progress.resolve(mediaId, keepInspecting ? "Canonical" : choice);
      if (!mountedRef.current) return;
      setProgress(next);
      if (next.kind === "Conflict") { setApplyFailed(true); resolvingRef.current = false; return; }
      if (keepInspecting) { setChosenSnapshot(null); resolvingRef.current = false; return; }
      const snapshot = progressSnapshot(next);
      setChosenSnapshot(snapshot);
      const outcome = await applyCanonical(snapshot, "Remote");
      if (!mountedRef.current) return;
      if (outcome.kind === "Arrived" || outcome.kind === "Unchanged") {
        setChosenSnapshot(null);
        resolvingRef.current = false;
      }
      else setApplyFailed(true);
    } catch {
      if (mountedRef.current) setApplyFailed(true);
    } finally {
      resolutionBusyRef.current = false;
      if (mountedRef.current) setResolving(false);
    }
  };
  const mode = navigation.state.mode;
  const origin = mode.kind === "Exploring" && mode.origin.kind === "Present" ? mode.origin.value.locator : null;
  const structure = document.kind === "Pdf" ? null : buildReaderDocumentStructure(document.navigation);
  let originLabel: string | null = origin?.kind === "pdf" ? `page ${origin.page}` : null;
  if (structure && origin && (origin.kind === "epub" || origin.kind === "web") && origin.locations.text_offset !== null) {
    const section = readerSectionAtPosition(structure, readerTextPointOffset(structure, { fragment_id: origin.target.fragment_id, offset: origin.locations.text_offset }));
    if (section.kind === "Present") originLabel = section.value.section.label;
  }
  const failure = navigation.state.error;
  const error = failure.kind === "Absent" ? null
    : failure.value.reason === "SourceChanged" ? "your reading spot is unavailable in this version."
    : failure.value.action === "Return" ? "couldn't return to your spot. try again."
    : failure.value.action === "Adopt" ? "couldn't use this reading position. try again."
    : failure.value.reason === "CaptureUnavailable" ? "couldn't hold your reading spot. try again."
    : "couldn't open that passage.";
  const remoteSnapshot = progress.kind === "Conflict" ? progress.canonical : chosenSnapshot;
  const notice = progressNotice(progress);
  return <div ref={rootRef} tabIndex={-1} className={styles.documentReader}>
    {document.kind === "Pdf" ? null : (
      <ReaderSourceIssuesNotice issues={document.navigation.source_issues} navigation={document.navigation} readable />
    )}
    {document.kind === "WebArticle" ? <p className={styles.notice}>{OFFLINE_READING_COPY.textOnlyNotice}</p> : null}
    {notice !== null && progress.kind !== "Conflict" ? <p role="alert" className={styles.notice}>{notice}</p> : null}
    {progress.kind === "ContentChanged" && !changedSourceAcknowledged ? <div className={styles.actions} aria-label="Changed source">
      <button type="button" className={styles.action} onClick={() => setChangedSourceAcknowledged(true)}>{OFFLINE_READING_COPY.continueAction}</button>
      <button type="button" className={styles.quietAction} onClick={onRemoveRequested}>{OFFLINE_READING_COPY.removeConfirmAction}</button>
    </div> : null}
    <ReaderNavigationStatus
      navigation={mode.kind === "Reading" ? { kind: "Reading", error } : {
        kind: "Exploring", origin: navigation.state.originUnavailable ? "Unavailable" : mode.origin.kind === "Present" ? "Held" : "Absent",
        originLabel, positioning: navigation.state.positioning || resolving, error,
      }}
      handoff={remoteSnapshot === null ? null : { snapshot: remoteSnapshot, busy: resolving, applyFailed, captureUnavailable }}
      announcement="" saveFailed={saveFailed}
      onReturn={() => { if (!resolvingRef.current) void navigation.returnToOrigin(); }}
      onAdopt={() => !resolvingRef.current && navigation.adoptHere().kind === "Arrived"}
      onAcceptRemote={() => void resolveProgress("Canonical")}
      onKeepLocal={() => void resolveProgress("Device")}
      onRetrySave={() => { if (failedLocatorRef.current) void save(failedLocatorRef.current).catch(() => undefined); }}
      focusReader={() => {
        const target = rootRef.current?.querySelector<HTMLElement>('[data-pane-content]') ?? rootRef.current;
        target?.focus({ preventScroll: true });
      }}
    />
    {document.kind === "Pdf" ? <PdfReader
      mediaId={mediaId}
      resources={pdfResources!}
      decorations={noOfflinePdfDecorations} isMobile mobileChromeEnabled={false}
      acquireMobileChromeVisibleLock={acquireOfflineChromeLock} scrollPositioner={offlinePositioner} handleAuthenticationError={offlineAuthenticationError}
      navigationActions={{
        inspect: (target, occurrence, signal) => navigation.inspect({ kind: "Pdf", target }, occurrence, signal),
        beginSeek: navigation.beginSeek, cancelPositioning: navigation.cancelPositioning,
      }}
      onNavigationAdapterReady={pdfAdapterReady}
      onSemanticViewportChange={(viewport) => { if (viewport?.intent === "Reader") saveMovement(viewport.primaryLocator); }}
    /> : <OfflineTextReader
      document={document} session={session} source={textSource}
      navigation={navigation} onAdapterReady={textAdapterReady} onSave={saveMovement}
    />}
  </div>;
}

type OfflineTextDocument = Exclude<LoadedReaderDocument, { kind: "Pdf" }>;
type OfflineTextBody = {
  id: string;
  html: string;
  text: string;
  epubFragment: EpubFragmentContent | null;
};
type OfflineTextAnchor = {
  body: OfflineTextBody;
  target: EpubRestoreRequest["target"];
  placement: TextReaderPlacement;
};
type OfflineTextPosition = {
  destination: EpubRestoreRequest;
  anchor: OfflineTextAnchor | null;
  focus: Presence<HTMLElement>;
  occurrence: Presence<string>;
  signal: AbortSignal;
  displaced: boolean;
  finish: (outcome: ReaderNavigationOutcome) => void;
};

function offlineTextBody(fragment: Fragment | EpubFragmentContent): OfflineTextBody {
  return "fragment_id" in fragment
    ? { id: fragment.fragment_id, html: fragment.html_sanitized, text: fragment.canonical_text, epubFragment: fragment }
    : { id: fragment.id, html: fragment.html_sanitized, text: fragment.canonical_text, epubFragment: null };
}

function OfflineTextReader({ document, session, source, navigation, onAdapterReady, onSave }: {
  document: OfflineTextDocument;
  session: DocumentReaderSession;
  source: string;
  navigation: OfflineNavigation;
  onAdapterReady: (adapter: OfflineNavigationAdapter | null) => void;
  onSave: (locator: ReaderResumeState) => void;
}) {
  const structure = useMemo(() => buildReaderDocumentStructure(document.navigation), [document.navigation]);
  const [body, setBody] = useState(() => offlineTextBody(document.kind === "Epub" ? document.fragment : document.activeFragment));
  const [request, setRequest] = useState<OfflineTextPosition | null>(null);
  const requestRef = useRef<OfflineTextPosition | null>(null);
  const [current, setCurrent] = useState<Presence<number>>(absent());
  const [visible, setVisible] = useState<Presence<ReaderDocumentOverviewRange>>(absent());
  const [detailOpen, setDetailOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readerRootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLElement>(null);
  const cursorRef = useRef<CanonicalCursorResult | null>(null);
  const trustedRef = useRef<"forward" | "backward" | null>(null);
  const currentAnchorRef = useRef<OfflineTextAnchor | null>(null);
  const layoutRef = useRef<{ width: number; height: number; contentHeight: number } | null>(null);
  const bodyRef = useRef(body);
  const saveRef = useRef(onSave);
  bodyRef.current = body;
  saveRef.current = onSave;

  const destinations = useMemo<ReaderMapMarkerPresentation[]>(() =>
    structure.length === 0 ? [] : structure.sections.map((entry) => {
      const marker: ReaderDocumentMapMarker = {
        id: `contents:${entry.section.section_id}`,
        kind: "Contents",
        item_id: entry.section.section_id,
        label: entry.section.label,
        tone: "Neutral",
        position: entry.start / structure.length,
        end_position: entry.extent.kind === "Present"
          ? present(entry.extent.value.end / structure.length)
          : absent(),
        preview: absent(),
      };
      return {
        marker,
        content: { kind: "Named", label: marker.label, excerpt: marker.preview },
      };
    }), [structure]);

  function capture(saveReading: boolean) {
    const viewport = viewportRef.current;
    const cursor = cursorRef.current;
    if (!viewport || !cursor) return false;
    // Reflow can clamp scrollTop before ResizeObserver runs. That scroll must
    // not replace the source anchor the observer still has to restore.
    const layout = layoutRef.current;
    if (layout && contentRef.current && (layout.width !== viewport.clientWidth || layout.height !== viewport.clientHeight || layout.contentHeight !== contentRef.current.getBoundingClientRect().height)) return false;
    const range = captureVisibleCanonicalTextRange(viewport, cursor);
    const activeBody = bodyRef.current;
    const previous = currentAnchorRef.current;
    const direction = saveReading ? trustedRef.current : null;
    if (saveReading) trustedRef.current = null;
    const final = document.navigation.fragments.at(-1)?.fragment_id === activeBody.id;
    const retainedEnd = direction === null && previous?.body.id === activeBody.id && previous.target.kind === "Offset" && previous.target.offset === cursor.length;
    const terminal = cursor.length > 0 && (saveReading && direction === "forward" || retainedEnd) && final && endRef.current !== null && isTextViewportAtEnd(viewport, endRef.current);
    const offset = terminal ? cursor.length : range?.primaryOffset ?? null;
    if (offset === null) {
      const target = previous?.body.id === activeBody.id && previous.target.kind === "Anchor" ? previous.target : cursor.length === 0 ? { kind: "Offset" as const, offset: 0 } : null;
      const root = contentRef.current;
      const element = target?.kind === "Anchor" && root ? findSourceAnchor(root, target.anchorId) : target ? root : null;
      const placement = element && root ? measureSourceAnchorViewportOrigin(viewport, root, target?.kind === "Anchor" ? present(target.anchorId) : absent()) : null;
      currentAnchorRef.current = target && placement ? { body: activeBody, target, placement } : null;
      setCurrent(absent());
      setVisible(absent());
      return currentAnchorRef.current !== null;
    }
    const fragment = structure.fragmentOffsets.get(activeBody.id)!;
    const topDelta = measureCanonicalTextAnchorViewportDelta(viewport, cursor, offset);
    currentAnchorRef.current = null;
    if (topDelta !== null) currentAnchorRef.current = { body: activeBody, target: { kind: "Offset", offset }, placement: { kind: "CanonicalText", anchorCp: offset, viewportTopDeltaPx: topDelta, scrollLeft: viewport.scrollLeft } };
    setCurrent(present(fragment.start + offset));
    setVisible(structure.length === 0 || !range ? absent() : present({
      start: (fragment.start + range.startOffset) / structure.length,
      end: (fragment.start + range.endOffset) / structure.length,
    }));
    if (!saveReading || direction === null) return currentAnchorRef.current !== null;
    const locator = buildTextReaderLocatorAtOffset({
      anchorOffset: offset,
      canonicalText: activeBody.text,
      fragmentId: activeBody.id,
      format: document.kind === "Epub" ? "epub" : "web",
      documentStartOffset: fragment.start,
      documentLength: structure.length,
      isFinalUnit: final,
      epubFragment: activeBody.epubFragment,
      epubAnchorId: null,
      positionBucketCodePoints: 1000,
    });
    if (locator !== null) saveRef.current(locator);
    return currentAnchorRef.current !== null;
  }
  const captureRef = useRef(capture);
  captureRef.current = capture;

  const locatorForAnchor = useCallback((anchor: OfflineTextAnchor): ReaderResumeState | null => {
    const fragment = structure.fragmentOffsets.get(anchor.body.id);
    if (!fragment) return null;
    if (anchor.target.kind === "Anchor") {
      const epub = anchor.body.epubFragment;
      return epub ? {
        kind: "epub", target: { fragment_id: epub.fragment_id, href_path: epub.href_path, anchor_id: present(anchor.target.anchorId) },
        locations: { text_offset: null, progression: null, total_progression: null, position: null },
        text: { quote: null, quote_prefix: null, quote_suffix: null },
      } : null;
    }
    return buildTextReaderLocatorAtOffset({
      anchorOffset: anchor.target.offset, canonicalText: anchor.body.text, fragmentId: anchor.body.id,
      format: document.kind === "Epub" ? "epub" : "web", documentStartOffset: fragment.start,
      documentLength: structure.length, isFinalUnit: document.navigation.fragments.at(-1)?.fragment_id === anchor.body.id,
      epubFragment: anchor.body.epubFragment, epubAnchorId: null, positionBucketCodePoints: 1000,
    });
  }, [document, structure]);
  const adapter = useMemo<OfflineNavigationAdapter>(() => ({
    capture() {
      if (!captureRef.current(false)) return null;
      const anchor = currentAnchorRef.current;
      const viewport = viewportRef.current;
      if (!anchor || !viewport || anchor.body !== bodyRef.current || !cursorRef.current) return null;
      const locator = locatorForAnchor(anchor);
      if (!locator) return null;
      const focused = viewport.ownerDocument.activeElement;
      return { kind: "Captured", source, locator, placement: { kind: "Text", anchor }, occurrence: absent(),
        focus: focused instanceof HTMLElement && viewport.contains(focused) ? present(focused) : absent() };
    },
    async position(position, signal) {
      if (signal.aborted) return { kind: "Cancelled", displaced: false };
      let destination: EpubRestoreRequest | null = null;
      let anchor: OfflineTextAnchor | null = null;
      let focus: Presence<HTMLElement> = absent();
      let occurrence: Presence<string> = absent();
      if (position.kind === "Target") {
        if (position.target.kind !== "Text") return { kind: "Unavailable", reason: "TargetUnavailable", displaced: false };
        destination = position.target.destination;
      } else {
        const checkpoint = position.kind === "Checkpoint" ? position.checkpoint : null;
        if (checkpoint && checkpoint.source !== source) return { kind: "Unavailable", reason: "SourceChanged", displaced: false };
        if (checkpoint?.kind === "Captured") {
          if (checkpoint.placement.kind !== "Text") return { kind: "Unavailable", reason: "SourceChanged", displaced: false };
          anchor = checkpoint.placement.anchor;
          destination = { fragmentId: anchor.body.id, target: anchor.target };
          focus = checkpoint.focus;
          occurrence = checkpoint.occurrence;
        } else {
          const snapshot = position.kind === "Canonical" ? position.snapshot : null;
          const locator = checkpoint?.locator ?? (snapshot?.state === "Positioned" ? snapshot.locator : null);
          if (locator?.kind === "epub" || locator?.kind === "web") {
            destination = locator.locations.text_offset !== null
              ? { fragmentId: locator.target.fragment_id, target: { kind: "Offset", offset: locator.locations.text_offset } }
              : locator.kind === "epub" && locator.target.anchor_id.kind === "Present"
                ? { fragmentId: locator.target.fragment_id, target: { kind: "Anchor", anchorId: locator.target.anchor_id.value } } : null;
          } else if (snapshot?.state === "Empty") {
            const first = document.navigation.fragments[0];
            if (first) destination = { fragmentId: first.fragment_id, target: { kind: "Offset", offset: 0 } };
          }
        }
      }
      if (!destination || !structure.fragmentOffsets.has(destination.fragmentId)) return { kind: "Unavailable", reason: "TargetUnavailable", displaced: false };
      trustedRef.current = null;
      let next = bodyRef.current;
      if (next.id !== destination.fragmentId) {
        if (document.kind === "Epub") {
          let fragment: EpubFragmentContent;
          try { fragment = await session.loadEpubFragment(destination.fragmentId, signal); }
          catch { return signal.aborted ? { kind: "Cancelled", displaced: false } : { kind: "Unavailable", reason: "TargetUnavailable", displaced: false }; }
          if (fragment.generation !== document.navigation.generation) return { kind: "Unavailable", reason: "SourceChanged", displaced: false };
          next = offlineTextBody(fragment);
        } else {
          const fragment = document.fragments.find((item) => item.id === destination.fragmentId);
          if (!fragment) return { kind: "Unavailable", reason: "TargetUnavailable", displaced: false };
          next = offlineTextBody(fragment);
        }
      }
      if (signal.aborted) return { kind: "Cancelled", displaced: false };
      const resolvedDestination = destination;
      return new Promise<ReaderNavigationOutcome>((resolve) => {
        const pending: OfflineTextPosition = {
          destination: resolvedDestination, anchor, focus, occurrence, signal, displaced: next.id !== bodyRef.current.id,
          finish(outcome) {
            signal.removeEventListener("abort", cancel);
            if (requestRef.current === pending) requestRef.current = null;
            resolve(outcome);
          },
        };
        const cancel = () => pending.finish({ kind: "Cancelled", displaced: pending.displaced });
        signal.addEventListener("abort", cancel, { once: true });
        requestRef.current = pending;
        setBody(next);
        setRequest(pending);
      });
    },
  }), [document, locatorForAnchor, session, source, structure]);
  useEffect(() => {
    onAdapterReady(adapter);
    return () => {
      onAdapterReady(null);
      const pending = requestRef.current;
      pending?.finish({ kind: "Cancelled", displaced: pending.displaced });
    };
  }, [adapter, onAdapterReady]);

  useLayoutEffect(() => {
    const root = contentRef.current;
    const viewport = viewportRef.current;
    if (!root || !viewport) return;
    const cursor = buildCanonicalCursor(root);
    if (!validateCanonicalText(cursor, body.text)) {
      cursorRef.current = null;
      setError("This copy's rendered text does not match its source. Exact navigation is unavailable.");
      return;
    }
    cursorRef.current = cursor;
    currentAnchorRef.current = null;
    layoutRef.current = { width: viewport.clientWidth, height: viewport.clientHeight, contentHeight: root.getBoundingClientRect().height };
    const observer = new ResizeObserver(() => {
      const nextHeight = root.getBoundingClientRect().height;
      const layout = layoutRef.current;
      if (layout?.width === viewport.clientWidth && layout.height === viewport.clientHeight && layout.contentHeight === nextHeight) return;
      layoutRef.current = { width: viewport.clientWidth, height: viewport.clientHeight, contentHeight: nextHeight };
      const anchor = currentAnchorRef.current;
      trustedRef.current = null;
      if (anchor?.body.id === body.id) {
        void offlinePositioner.run((commands) => {
          restoreTextReaderPlacement(commands, viewport, cursor, root, anchor.placement);
        }).then(() => {
          if (cursorRef.current === cursor) captureRef.current(false);
        });
      } else captureRef.current(false);
    });
    observer.observe(root);
    observer.observe(viewport);
    return () => { observer.disconnect(); cursorRef.current = null; layoutRef.current = null; };
  }, [body]);

  useLayoutEffect(() => {
    if (!request || requestRef.current !== request || request.signal.aborted || request.destination.fragmentId !== body.id) return;
    const viewport = viewportRef.current;
    const root = contentRef.current;
    const cursor = cursorRef.current;
    if (!viewport || !root || !cursor) {
      request.finish({ kind: "Unavailable", reason: "PositioningFailed", displaced: request.displaced });
      return;
    }
    const oldTop = viewport.scrollTop;
    const oldLeft = viewport.scrollLeft;
    const target = request.destination.target;
    const element = target.kind === "Anchor" ? findSourceAnchor(root, target.anchorId) : root;
    let arrived = false;
    void offlinePositioner.run((commands) => {
      if (request.signal.aborted || requestRef.current !== request) return;
      if (request.anchor) arrived = restoreTextReaderPlacement(commands, viewport, cursor, root, request.anchor.placement);
      else if (target.kind === "Anchor") {
        if (element) {
          const rect = element.getBoundingClientRect();
          const view = viewport.getBoundingClientRect();
          if (rect.top < view.top || rect.bottom > view.bottom) commands.setTop(viewport, viewport.scrollTop + rect.top - view.top - getPaneScrollTopPaddingPx(viewport));
          const positioned = element.getBoundingClientRect();
          arrived = positioned.top >= view.top - 1 && positioned.top < view.bottom;
        }
      } else if (cursor.length === 0 && target.offset === 0) {
        commands.setTop(viewport, 0);
        arrived = viewport.scrollTop === 0;
      } else if (target.offset >= 0 && target.offset <= cursor.length) {
        if (!isCanonicalTextAnchorVisible(viewport, cursor, target.offset)) scrollToExactCanonicalTextAnchor(commands, viewport, cursor, target.offset);
        arrived = isCanonicalTextAnchorVisible(viewport, cursor, target.offset);
      }
      request.displaced ||= viewport.scrollTop !== oldTop || viewport.scrollLeft !== oldLeft;
      if (arrived) {
        if (request.anchor) currentAnchorRef.current = { ...request.anchor, body };
        else if (target.kind === "Anchor" || cursor.length === 0) {
          const placement = measureSourceAnchorViewportOrigin(viewport, root, target.kind === "Anchor" ? present(target.anchorId) : absent());
          if (placement) currentAnchorRef.current = { body, target, placement };
        } else {
          const viewportTopDeltaPx = measureCanonicalTextAnchorViewportDelta(viewport, cursor, target.offset);
          currentAnchorRef.current = viewportTopDeltaPx === null ? null : {
            body, target, placement: { kind: "CanonicalText", anchorCp: target.offset, viewportTopDeltaPx, scrollLeft: viewport.scrollLeft },
          };
        }
      }
    }).then(() => {
      if (request.signal.aborted || requestRef.current !== request) return;
      if (arrived) {
        captureRef.current(false);
        const opener = request.occurrence.kind === "Present" && request.occurrence.value.startsWith(`${body.id}#`)
          ? findSourceAnchor(root, request.occurrence.value.slice(body.id.length + 1)) : null;
        const openerLink = opener?.matches("a[href]") ? opener : opener?.querySelector("a[href]");
        const uniqueOpenerLink = openerLink instanceof HTMLAnchorElement &&
          (opener === openerLink || opener?.querySelectorAll("a[href]").length === 1) ? openerLink : null;
        const focused = request.focus.kind === "Present" && request.focus.value.isConnected
          ? request.focus.value : uniqueOpenerLink ?? viewport;
        focused.focus({ preventScroll: true });
        request.finish({ kind: request.displaced ? "Arrived" : "Unchanged" });
      } else request.finish({ kind: "Unavailable", reason: "TargetUnavailable", displaced: request.displaced });
      setRequest(null);
    });
  }, [body, request]);

  function jump(sectionId: string) {
    const section = document.navigation.sections.find((entry) => entry.section_id === sectionId);
    if (!section) throw new Error("Map destination is absent from the publication");
    void navigation.inspect({ kind: "Text", destination: { fragmentId: section.target.fragment_id, target: section.anchor_id.kind === "Present"
      ? { kind: "Anchor", anchorId: section.anchor_id.value }
      : { kind: "Offset", offset: section.target.offset } } });
  }
  function jumpPoint(point: ReaderNavigationTextPoint) {
    void navigation.inspect({
      kind: "Text",
      destination: { fragmentId: point.fragment_id, target: { kind: "Offset", offset: point.offset } },
    });
  }
  function revealCurrent() {
    viewportRef.current?.focus({ preventScroll: true });
  }
  function continueReading(fragmentId: string) {
    const eligible = navigation.eligibility.canAcquireProgress();
    void navigation.inspect({ kind: "Text", destination: { fragmentId, target: { kind: "Offset", offset: 0 } } }).then((outcome) => {
      if (eligible && outcome.kind === "Arrived") navigation.adoptHere();
    });
  }
  const index = document.navigation.fragments.findIndex((fragment) => fragment.fragment_id === body.id);
  const next = document.navigation.fragments[index + 1];
  const previous = document.navigation.fragments[index - 1];
  const active = current.kind === "Present" ? readerSectionAtPosition(structure, current.value) : absent<ReaderPositionedSection>();

  return (
    <>
      {error ? <p role="alert" className={styles.notice}>{error}</p> : null}
      <div className={`${styles.actions} ${styles.readerActions}`}>
        <button type="button" className={styles.action} aria-expanded={detailOpen} onClick={() => {
          setDetailOpen(!detailOpen);
        }}>document map</button>
        <span>{active.kind === "Present" ? active.value.section.label : "document"}</span>
      </div>
      {detailOpen ? <div className={styles.readerMapPanel}><ReaderDocumentMapDetail
        navigation={document.navigation}
        structure={structure}
        currentOffset={current}
        visibleRange={visible}
        destinations={destinations}
        onNavigatePoint={jumpPoint}
        onActivateMarker={(marker) => jump(marker.item_id)}
        onRevealCurrent={revealCurrent}
      /></div> : null}
      <div className={styles.textWithMap}>
        <TextDocumentReader
          key={body.id}
          mediaId={document.descriptor.id}
          readerRootRef={readerRootRef}
          contentRef={contentRef}
          textViewportRef={viewportRef}
          textEndRef={endRef}
          readerThemeClassName=""
          readerSurfaceStyle={offlineReaderSurfaceStyle}
          focusMode={OFFLINE_SHELF_READER_PROFILE.focus_mode}
          hyphenation={OFFLINE_SHELF_READER_PROFILE.hyphenation}
          contentState={{ status: "ready", renderedHtml: body.html }}
          onViewportReady={() => captureRef.current(false)}
          onViewportScroll={() => captureRef.current(false)}
          onViewportScrollEnd={() => captureRef.current(trustedRef.current !== null)}
          onTrustedScrollIntent={(direction) => {
            navigation.cancelPositioning();
            trustedRef.current = direction;
            if (direction === "forward" && document.navigation.fragments.at(-1)?.fragment_id === body.id && viewportRef.current && endRef.current && isTextViewportAtEnd(viewportRef.current, endRef.current)) captureRef.current(true);
          }}
          onSeekBoundary={(edge) => {
            const fragment = edge === "Start" ? document.navigation.fragments[0] : document.navigation.fragments.at(-1);
            if (fragment) void navigation.inspect({ kind: "Text", destination: { fragmentId: fragment.fragment_id, target: { kind: "Offset", offset: edge === "Start" ? 0 : structure.fragmentOffsets.get(fragment.fragment_id)!.length } } });
          }}
          onBeginScrollbarSeek={navigation.beginSeek}
          endContent={<nav className={styles.actions} aria-label="Reading order">
            {previous ? <button type="button" onClick={() => continueReading(previous.fragment_id)}>previous resource</button> : null}
            {next ? <button type="button" onClick={() => continueReading(next.fragment_id)}>continue reading</button> : <span>end of document</span>}
          </nav>}
          onContentClick={() => undefined}
          onContentPointerOver={() => undefined}
          onContentPointerOut={() => undefined}
          onContentFocus={() => undefined}
          onContentBlur={() => undefined}
          onInternalLinkClick={(link) => {
            const destination = resolveReaderInternalLinkTarget(link, document.kind === "WebArticle" ? body.id : null);
            if (destination.kind === "Absent") return false;
            const mode = navigation.state.mode;
            const origin = mode.kind === "Exploring" && mode.origin.kind === "Present" && mode.origin.value.kind === "Captured" ? mode.origin.value : null;
            const target = destination.value.target;
            if (origin?.occurrence.kind === "Present" && target.kind === "Anchor" && origin.occurrence.value === `${destination.value.fragmentId}#${target.anchorId}`) {
              void navigation.returnToOrigin();
            } else {
              const opener = contentRef.current ? findUniqueSourceLinkOwner(contentRef.current, link) : null;
              void navigation.inspect({ kind: "Text", destination: destination.value }, opener ? present(`${body.id}#${opener.id}`) : absent());
            }
            return true;
          }}
        />
        {structure.length > 0 ? <ReaderDocumentMapOverviewRail
          destinations={destinations}
          structure={present(structure)}
          visibleRange={visible}
          currentPosition={current.kind === "Present" ? present(current.value / structure.length) : absent()}
          scope={{ label: "document", start: 0, end: 1 }}
          onActivateMarker={(marker) => jump(marker.item_id)}
          onRevealCurrent={revealCurrent}
        /> : null}
      </div>
    </>
  );
}
