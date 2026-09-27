import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import PdfReader, {
  type PdfReaderDecorationWrites,
  type PdfReaderControlActions,
} from "@/components/PdfReader";
import TextDocumentReader from "@/components/reader/TextDocumentReader";
import ReaderDocumentMapDetail from "@/components/reader/ReaderDocumentMapDetail";
import ReaderDocumentMapOverviewRail from "@/components/reader/ReaderDocumentMapOverviewRail";
import ReaderSourceIssuesNotice from "@/components/reader/ReaderSourceIssuesNotice";
import ReaderNavigationStatus from "@/components/reader/ReaderNavigationStatus";
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
  restoreCanonicalTextAnchorViewportPosition,
  scrollToExactCanonicalTextAnchor,
} from "@/lib/reader/canonicalTextAnchor";
import {
  buildReaderDocumentStructure,
  readerSectionAtPosition,
  readerTextPointOffset,
  type ReaderDocumentOverviewRange,
  type ReaderPositionedSection,
} from "@/lib/reader/readerDocumentPosition";
import type {
  PdfHighlightOut,
} from "@/lib/reader/ReaderDecorations";
import {
  buildTextReaderLocatorAtOffset,
  createDocumentReaderSession,
  preferredReaderLocator,
  type LoadedDocumentReaderSession,
  type LoadedReaderDocument,
  type DocumentReaderSession,
} from "@/lib/reader/DocumentReaderSession";
import type { ReaderProgressView } from "@/lib/reader/ReaderProgressPort";
import { useReaderNavigation, type NavigationOutcome, type ReaderCheckpoint, type ReaderOccurrence } from "@/lib/reader/useReaderNavigation";
import { getPaneScrollTopPaddingPx, type ReaderScrollPositioner } from "@/lib/reader/paneScroll";
import { buildReaderSurfaceStyle } from "@/lib/reader/readerSurfaceStyle";
import type { ReaderProfile, ReaderResumeState } from "@/lib/reader/types";
import {
  OfflineReaderProgressPort,
  OfflineReaderSource,
} from "@/lib/offlineReading/OfflineReaderAdapters";
import {
  OFFLINE_READING_COPY,
  offlineReaderLocatorContext,
  offlineReadingConflictChoiceLabel,
  offlineReadingConflictLocators,
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

const noOfflinePdfDecorations: PdfReaderDecorationWrites = {
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

type OfflineResolution = (view: ReaderProgressView, choice: "Canonical" | "Device") => Promise<ReaderResumeState | null>;

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

function saveStatusMessage(kind: ReaderProgressView["kind"] | "Failed"): string {
  switch (kind) {
    case "Conflict":
      return OFFLINE_READING_COPY.conflictNotice;
    case "ContentChanged":
      return OFFLINE_READING_COPY.changedSourceNotice;
    case "SourceUnavailable":
      return OFFLINE_READING_COPY.sourceUnavailableNotice;
    case "Failed":
      return "Position could not be stored on this device. Try again.";
    case "Canonical":
    case "Pending":
      return "Position stored on this device";
  }
}

export default function OfflineDocumentReader({
  controller,
  mediaId,
  opened,
  authoritativeProgress,
  onClose,
  onRemoveRequested,
}: {
  readonly controller: OfflineReadingControllerRuntime;
  readonly mediaId: string;
  readonly opened: OpenedOfflineReading;
  readonly authoritativeProgress: ReaderProgressView | null;
  /** Leaves the reader for the shelf; the shelf owns the lease close. */
  readonly onClose: () => void;
  /** Opens the shelf's confirmed Remove dialog for this copy. */
  readonly onRemoveRequested: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const session = useMemo(() => {
    // `attempt` is a load-identity input: Retry builds a fresh session rather
    // than reusing the one whose package fetch failed.
    void attempt;
    const progress = new OfflineReaderProgressPort(controller, mediaId, opened);
    return createDocumentReaderSession({
      mediaId,
      source: new OfflineReaderSource(mediaId, opened),
      progress,
    });
  }, [attempt, controller, mediaId, opened]);
  const [load, setLoad] = useState<DocumentLoad>({ kind: "Loading" });
  const [progress, setProgress] = useState<ReaderProgressView>(opened.progress);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [changedSourceAcknowledged, setChangedSourceAcknowledged] = useState(false);
  const authoritativeProgressRef = useRef(authoritativeProgress);
  const resolvePositionRef = useRef<OfflineResolution | null>(null);

  useEffect(() => {
    authoritativeProgressRef.current = authoritativeProgress;
    if (authoritativeProgress !== null) setProgress(authoritativeProgress);
  }, [authoritativeProgress]);

  useEffect(() => {
    const abort = new AbortController();
    let current = true;
    setLoad({ kind: "Loading" });
    session.load(abort.signal).then(
      (result) => {
        if (!current) return;
        setLoad({ kind: "Loaded", loaded: result });
        setProgress(authoritativeProgressRef.current ?? result.progress);
      },
      () => {
        // A lease that expired, a package that failed verification, or an
        // undecodable reader document must land on a typed failure with a
        // valid action -- never an unhandled rejection behind a spinner.
        if (!current || abort.signal.aborted) return;
        setLoad({ kind: "Failed" });
      },
    );
    return () => {
      current = false;
      abort.abort();
    };
  }, [session]);

  if (load.kind === "Failed") {
    return (
      <div className={styles.documentReader}>
        <p role="alert" className={styles.notice}>
          This downloaded copy could not be opened. Its files may be incomplete
          or no longer verified on this device.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.action}
            onClick={() => setAttempt((current) => current + 1)}
          >
            Try again
          </button>
          <button type="button" className={styles.quietAction} onClick={onClose}>
            Back to downloads
          </button>
          <button
            type="button"
            className={styles.quietAction}
            onClick={onRemoveRequested}
          >
            Remove downloaded copy
          </button>
        </div>
      </div>
    );
  }
  if (load.kind === "Loading") return <p role="status">Opening verified copy…</p>;
  const loaded = load.loaded;
  const document = loaded.document;
  const sourceKey = `${mediaId}:${opened.readerGeneration}:${opened.readerRevisionKey}`;
  const preferredLocator = preferredReaderLocator(progress);
  const sectionLabel = (locator: Extract<ReaderResumeState, { kind: "epub" | "web" }>): string | null => {
    if (document.kind === "Pdf" || locator.locations.text_offset === null) return null;
    const structure = buildReaderDocumentStructure(document.navigation);
    const section = readerSectionAtPosition(structure, readerTextPointOffset(structure, {
      fragment_id: locator.target.fragment_id, offset: locator.locations.text_offset,
    }));
    return section.kind === "Present" ? section.value.section.label : null;
  };

  const applyProgress = async (next: ReaderProgressView, choice: "Canonical" | "Device") => {
    if (next.kind === "Conflict") {
      setProgress(next);
      return;
    }
    try {
      const held = await resolvePositionRef.current?.(next, choice) ?? null;
      if (choice === "Device" && held) {
        const result = await session.progress.save(mediaId, held);
        setProgress(result.kind === "Canonical" || result.kind === "Conflict" ? result : result.view);
      } else setProgress(next);
    } catch {
      setSaveStatus(choice === "Canonical" ? "Couldn't open that reading spot. Try again." : saveStatusMessage("Failed"));
    }
  };
  const resolveConflict = (choice: "Canonical" | "Device") => {
    void session.progress.resolve(mediaId, choice).then((next) => applyProgress(next, choice)).catch(() => {
      setSaveStatus(saveStatusMessage("Failed"));
    });
  };

  const save = (locator: ReaderResumeState) => {
    void session.progress.save(mediaId, locator).then((result) => {
      const next = result.kind === "Canonical" || result.kind === "Conflict" ? result : result.view;
      setProgress(next);
      setSaveStatus(
        saveStatusMessage(
          result.kind === "DurablyPending" ? result.view.kind : result.kind,
        ),
      );
    }).catch(() => {
      setSaveStatus(saveStatusMessage("Failed"));
    });
  };

  const notice = progressNotice(progress);
  const conflict = progress.kind === "Conflict"
    ? offlineReadingConflictLocators(progress)
    : null;

  return (
    <div className={styles.documentReader}>
      {document.kind === "Pdf" ? null : (
        <ReaderSourceIssuesNotice issues={document.navigation.source_issues} navigation={document.navigation} readable />
      )}
      {document.kind === "WebArticle" ? (
        <p className={styles.notice}>{OFFLINE_READING_COPY.textOnlyNotice}</p>
      ) : null}
      {notice === null ? null : (
        <p role="alert" className={styles.notice}>{notice}</p>
      )}
      {progress.kind === "ContentChanged" && !changedSourceAcknowledged ? (
        <div className={styles.actions} aria-label="Changed source">
          <button
            type="button"
            className={styles.action}
            onClick={() => setChangedSourceAcknowledged(true)}
          >
            {OFFLINE_READING_COPY.continueAction}
          </button>
          <button
            type="button"
            className={styles.quietAction}
            onClick={onRemoveRequested}
          >
            {OFFLINE_READING_COPY.removeConfirmAction}
          </button>
        </div>
      ) : null}
      {conflict === null ? null : (
        <div className={styles.actions} aria-label="Choose saved location">
          <button
            type="button"
            className={styles.action}
            onClick={() => resolveConflict("Canonical")}
          >
            {offlineReadingConflictChoiceLabel(
              "Canonical",
              offlineReaderLocatorContext(conflict.canonical, sectionLabel),
            )}
          </button>
          <button
            type="button"
            className={styles.action}
            onClick={() => resolveConflict("Device")}
          >
            {offlineReadingConflictChoiceLabel(
              "Device",
              offlineReaderLocatorContext(conflict.device, sectionLabel),
            )}
          </button>
        </div>
      )}
      {saveStatus === null ? null : (
        <p className={styles.saved} role="status">{saveStatus}</p>
      )}

      {document.kind === "Pdf" ? (
        <OfflinePdfReader mediaId={mediaId} document={document} initialLocator={preferredLocator} onSave={save} registerResolution={(resolve) => { resolvePositionRef.current = resolve; }} />
      ) : (
        <OfflineTextReader
          key={document.navigation.generation}
          document={document}
          sourceKey={`${sourceKey}:${document.navigation.generation}`}
          session={session}
          initialLocator={preferredLocator}
          onSave={save}
          registerResolution={(resolve) => { resolvePositionRef.current = resolve; }}
        />
      )}
    </div>
  );
}

function OfflinePdfReader({ mediaId, document, initialLocator, onSave, registerResolution }: {
  mediaId: string;
  document: Extract<LoadedReaderDocument, { kind: "Pdf" }>;
  initialLocator: ReaderResumeState | null;
  onSave: (locator: ReaderResumeState) => void;
  registerResolution: (resolve: OfflineResolution | null) => void;
}) {
  const controlsRef = useRef<PdfReaderControlActions | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const resources = useMemo(() => ({
    signedUrl: { status: "ready" as const, data: document.document },
    pageHighlights: { status: "ready" as const, data: [] },
    requestSignedUrlRefresh: () => undefined,
  }), [document.document]);
  const navigation = useReaderNavigation({
    adapter: {
      capture: () => controlsRef.current?.navigationAdapter.capture() ?? null,
      captureReading: () => controlsRef.current?.navigationAdapter.captureReading() ?? null,
      position: (checkpoint, signal) => controlsRef.current?.navigationAdapter.position(checkpoint, signal)
        ?? Promise.resolve({ kind: "Unavailable", reason: "PositioningFailed", displaced: false }),
    },
    savedOrigin: () => {
      const sourceKey = controlsRef.current?.navigationAdapter.capture()?.sourceKey;
      return sourceKey && initialLocator?.kind === "pdf" ? { kind: "Saved", sourceKey, locator: initialLocator } : null;
    },
    closeActivity: () => undefined,
    admit: onSave,
    admitAdoption: onSave,
  });
  useEffect(() => {
    registerResolution(async (view, choice) => {
      if (choice === "Device" && navigation.state.kind === "Exploring") return navigation.state.originUnavailable ? null : navigation.heldLocator();
      const locator = preferredReaderLocator(view);
      if (!locator) throw new Error("Offline PDF conflict has no exact target");
      const sourceKey = controlsRef.current?.navigationAdapter.capture()?.sourceKey;
      if (!sourceKey) throw new Error("Offline PDF source is unavailable for conflict positioning");
      const outcome = await navigation.applyCanonical({ kind: "Saved", sourceKey, locator }, "Remote");
      if (outcome.kind !== "Arrived" && outcome.kind !== "Unchanged") throw new Error("Offline PDF conflict position is unavailable");
      return null;
    });
    return () => registerResolution(null);
  }, [navigation, registerResolution]);
  return <>
    <ReaderNavigationStatus navigation={navigation} originLabel={navigation.state.kind === "Exploring" && navigation.state.origin.kind === "Present" && navigation.state.origin.value.locator.kind === "pdf" ? `page ${navigation.state.origin.value.locator.page}` : null} focusReader={() => viewportRef.current?.focus()} />
    <PdfReader
      mediaId={mediaId}
      navigation={navigation}
      viewportRef={viewportRef}
      resources={resources}
      decorations={noOfflinePdfDecorations}
      isMobile
      mobileChromeEnabled={false}
      acquireMobileChromeVisibleLock={() => () => undefined}
      scrollPositioner={offlinePositioner}
      handleAuthenticationError={() => false}
      startPageNumber={initialLocator?.kind === "pdf" ? initialLocator.page : 1}
      startPageProgression={initialLocator?.kind === "pdf" ? initialLocator.page_progression ?? undefined : undefined}
      startZoom={initialLocator?.kind === "pdf" ? initialLocator.zoom ?? undefined : undefined}
      onControlsReady={(controls) => { controlsRef.current = controls; }}
      onSemanticViewportChange={(viewport) => {
        if (viewport?.intent === "Reader" && navigation.isReadingEligible()) onSave(viewport.primaryLocator);
      }}
    />
  </>;
}

type OfflineTextDocument = Exclude<LoadedReaderDocument, { kind: "Pdf" }>;
type OfflineTextBody = {
  id: string;
  html: string;
  text: string;
  epubFragment: EpubFragmentContent | null;
};
type OfflineTextPosition = {
  body: OfflineTextBody;
  target: EpubRestoreRequest["target"];
  topDelta: number;
  scrollLeft: number;
};

function offlineTextBody(fragment: Fragment | EpubFragmentContent): OfflineTextBody {
  return "fragment_id" in fragment
    ? { id: fragment.fragment_id, html: fragment.html_sanitized, text: fragment.canonical_text, epubFragment: fragment }
    : { id: fragment.id, html: fragment.html_sanitized, text: fragment.canonical_text, epubFragment: null };
}

function OfflineTextReader({ document, sourceKey, session, initialLocator, onSave, registerResolution }: {
  document: OfflineTextDocument;
  sourceKey: string;
  session: DocumentReaderSession;
  initialLocator: ReaderResumeState | null;
  onSave: (locator: ReaderResumeState) => void;
  registerResolution: (resolve: OfflineResolution | null) => void;
}) {
  const structure = useMemo(() => buildReaderDocumentStructure(document.navigation), [document.navigation]);
  const [body, setBody] = useState(() => offlineTextBody(document.kind === "Epub" ? document.fragment : document.activeFragment));
  const [request, setRequest] = useState<{
    generation: number;
    destination: EpubRestoreRequest;
    placement: Extract<ReaderCheckpoint, { kind: "Captured" }> | null;
    signal: AbortSignal;
    startBody: string;
    startTop: number | null;
    resolve: (outcome: NavigationOutcome) => void;
  } | null>(null);
  const [current, setCurrent] = useState<Presence<number>>(absent());
  const [visible, setVisible] = useState<Presence<ReaderDocumentOverviewRange>>(absent());
  const [detailOpen, setDetailOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readerRootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLElement>(null);
  const cursorRef = useRef<CanonicalCursorResult | null>(null);
  const generationRef = useRef(0);
  const loadRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<{ complete: (outcome: NavigationOutcome) => void; displaced: () => boolean } | null>(null);
  const trustedRef = useRef<"forward" | "backward" | null>(null);
  const readerIntentRef = useRef(false);
  const currentAnchorRef = useRef<OfflineTextPosition | null>(null);
  const layoutRef = useRef<{ width: number; height: number; contentHeight: number } | null>(null);
  const bodyRef = useRef(body);
  const saveRef = useRef(onSave);
  bodyRef.current = body;
  saveRef.current = onSave;
  const navigation = useReaderNavigation({
    adapter: {
      capture: () => captureCheckpoint(),
      captureReading: () => readerIntentRef.current ? captureCheckpoint() : null,
      position: (checkpoint, signal) => positionCheckpoint(checkpoint, signal),
    },
    savedOrigin: () => initialLocator === null ? null : { kind: "Saved", sourceKey, locator: initialLocator },
    closeActivity: () => undefined,
    admit: (locator) => saveRef.current(locator),
    admitAdoption: (locator) => saveRef.current(locator),
  });
  useEffect(() => {
    registerResolution(async (view, choice) => {
      if (choice === "Device" && navigation.state.kind === "Exploring") return navigation.state.originUnavailable ? null : navigation.heldLocator();
      const locator = preferredReaderLocator(view);
      if (!locator) throw new Error("Offline text conflict has no exact target");
      const outcome = await navigation.applyCanonical({ kind: "Saved", sourceKey, locator }, "Remote");
      if (outcome.kind !== "Arrived" && outcome.kind !== "Unchanged") throw new Error("Offline text conflict position is unavailable");
      return null;
    });
    return () => registerResolution(null);
  }, [navigation, registerResolution, sourceKey]);

  function captureCheckpoint(): Extract<ReaderCheckpoint, { kind: "Captured" }> | null {
    const anchor = currentAnchorRef.current;
    const viewport = viewportRef.current;
    const cursor = cursorRef.current;
    if (!anchor || !viewport || !cursor || anchor.body.id !== bodyRef.current.id) return null;
    const layout = layoutRef.current;
    if (!layout || !contentRef.current || layout.width !== viewport.clientWidth || layout.height !== viewport.clientHeight || layout.contentHeight !== contentRef.current.getBoundingClientRect().height) return null;
    const fragment = structure.fragmentOffsets.get(anchor.body.id);
    if (!fragment) return null;
    const offset = anchor.target.kind === "Offset" ? anchor.target.offset : captureVisibleCanonicalTextRange(viewport, cursor)?.primaryOffset;
    if (offset == null) return null;
    const locator = buildTextReaderLocatorAtOffset({
      anchorOffset: offset,
      canonicalText: anchor.body.text,
      fragmentId: anchor.body.id,
      format: document.kind === "Epub" ? "epub" : "web",
      documentStartOffset: fragment.start,
      documentLength: structure.length,
      isFinalUnit: document.navigation.fragments.at(-1)?.fragment_id === anchor.body.id,
      epubFragment: anchor.body.epubFragment,
      epubAnchorId: anchor.target.kind === "Anchor" ? anchor.target.anchorId : null,
      positionBucketCodePoints: 1000,
    });
    const root = contentRef.current;
    const focused = root?.ownerDocument.activeElement;
    const focusOwner = focused instanceof HTMLAnchorElement && root
      ? findUniqueSourceLinkOwner(root, focused)
      : null;
    const focus = focusOwner ? present(focusOwner.id) : absent<string>();
    return locator === null ? null : {
      kind: "Captured", sourceKey, locator,
      placement: { kind: "Text", anchorToViewport: anchor.topDelta, horizontal: anchor.scrollLeft },
      occurrence: absent(), focus,
    };
  }

  function focusCheckpoint(checkpoint: ReaderCheckpoint) {
    const viewport = viewportRef.current;
    const root = contentRef.current;
    if (!viewport) return;
    if (checkpoint.kind === "Captured" && checkpoint.focus.kind === "Present" && root) {
      const owner = findSourceAnchor(root, checkpoint.focus.value);
      const link = owner?.matches("a[href]") ? owner : owner?.querySelector("a[href]");
      if (owner && (owner === link || owner.querySelectorAll("a[href]").length === 1) && link instanceof HTMLAnchorElement) {
        link.focus({ preventScroll: true });
        return;
      }
    }
    viewport.focus({ preventScroll: true });
  }

  function positionCheckpoint(checkpoint: ReaderCheckpoint, signal: AbortSignal): Promise<NavigationOutcome> {
    if (checkpoint.sourceKey !== sourceKey || (checkpoint.locator.kind !== "epub" && checkpoint.locator.kind !== "web")) return Promise.resolve({ kind: "Unavailable", reason: "SourceChanged", displaced: false });
    const locator = checkpoint.locator;
    const destination: EpubRestoreRequest | null = checkpoint.kind === "Captured" && locator.kind === "epub" && locator.target.anchor_id.kind === "Present"
        ? { fragmentId: locator.target.fragment_id, target: { kind: "Anchor", anchorId: locator.target.anchor_id.value } }
        : locator.locations.text_offset !== null
          ? { fragmentId: locator.target.fragment_id, target: { kind: "Offset", offset: locator.locations.text_offset } }
          : locator.kind === "epub" && locator.target.anchor_id.kind === "Present"
            ? { fragmentId: locator.target.fragment_id, target: { kind: "Anchor", anchorId: locator.target.anchor_id.value } }
            : null;
    return destination === null
      ? Promise.resolve({ kind: "Unavailable", reason: "TargetUnavailable", displaced: false })
      : navigate(destination, checkpoint.kind === "Captured" ? checkpoint : null, signal, true);
  }

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
    if (!viewport || !cursor) return;
    // Reflow can clamp scrollTop before ResizeObserver runs. That scroll must
    // not replace the source anchor the observer still has to restore.
    const layout = layoutRef.current;
    if (layout && contentRef.current && (layout.width !== viewport.clientWidth || layout.height !== viewport.clientHeight || layout.contentHeight !== contentRef.current.getBoundingClientRect().height)) return;
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
      const rect = element?.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      currentAnchorRef.current = target && rect
        ? { body: activeBody, target, topDelta: rect.top - view.top, scrollLeft: viewport.scrollLeft }
        : null;
      setCurrent(absent());
      setVisible(absent());
      return;
    }
    const fragment = structure.fragmentOffsets.get(activeBody.id)!;
    const topDelta = measureCanonicalTextAnchorViewportDelta(viewport, cursor, offset);
    if (topDelta !== null) currentAnchorRef.current = { body: activeBody, target: { kind: "Offset", offset }, topDelta, scrollLeft: viewport.scrollLeft };
    setCurrent(present(fragment.start + offset));
    setVisible(structure.length === 0 || !range ? absent() : present({
      start: (fragment.start + range.startOffset) / structure.length,
      end: (fragment.start + range.endOffset) / structure.length,
    }));
    if (!saveReading || direction === null || !navigation.isReadingEligible()) return;
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
  }
  const captureRef = useRef(capture);
  captureRef.current = capture;

  const navigate = useCallback(async (destination: EpubRestoreRequest, placement: Extract<ReaderCheckpoint, { kind: "Captured" }> | null, signal: AbortSignal, forcePosition = false): Promise<NavigationOutcome> => {
    if (!structure.fragmentOffsets.has(destination.fragmentId)) return { kind: "Unavailable", reason: "TargetUnavailable", displaced: false };
    if (signal.aborted) return { kind: "Cancelled", displaced: false };
    const viewport = viewportRef.current;
    const cursor = cursorRef.current;
    const root = contentRef.current;
    if (!forcePosition && placement === null && destination.fragmentId === bodyRef.current.id && viewport && cursor && root) {
      const visible = destination.target.kind === "Offset"
        ? isCanonicalTextAnchorVisible(viewport, cursor, destination.target.offset)
        : (() => {
            const element = findSourceAnchor(root, destination.target.anchorId);
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const view = viewport.getBoundingClientRect();
            return rect.top >= view.top && rect.top <= view.bottom;
          })();
      if (visible) return { kind: "Unchanged" };
    }
    if (pendingRef.current) pendingRef.current.complete({ kind: "Cancelled", displaced: pendingRef.current.displaced() });
    pendingRef.current = null;
    loadRef.current?.abort();
    const abort = new AbortController();
    loadRef.current = abort;
    const generation = ++generationRef.current;
    trustedRef.current = null;
    setError(null);
    try {
      let next = bodyRef.current;
      if (next.id !== destination.fragmentId) {
        if (document.kind === "Epub") {
          const fragment = await session.loadEpubFragment(destination.fragmentId, abort.signal);
          if (fragment.generation !== document.navigation.generation) return { kind: "Unavailable", reason: "SourceChanged", displaced: false };
          next = offlineTextBody(fragment);
        } else {
          const fragment = document.fragments.find((item) => item.id === destination.fragmentId);
          if (!fragment) return { kind: "Unavailable", reason: "TargetUnavailable", displaced: false };
          next = offlineTextBody(fragment);
        }
      }
      if (abort.signal.aborted || signal.aborted || generation !== generationRef.current) return { kind: "Cancelled", displaced: false };
      return await new Promise<NavigationOutcome>((resolve) => {
        const startBody = bodyRef.current.id;
        const startTop = viewportRef.current?.scrollTop ?? null;
        const displaced = () => bodyRef.current.id !== startBody || (startTop !== null && viewportRef.current?.scrollTop !== startTop);
        const complete = (outcome: NavigationOutcome) => {
          if (pendingRef.current?.complete !== complete) return;
          pendingRef.current = null;
          signal.removeEventListener("abort", cancel);
          resolve(outcome);
        };
        const cancel = () => complete({ kind: "Cancelled", displaced: displaced() });
        pendingRef.current = { complete, displaced };
        signal.addEventListener("abort", cancel, { once: true });
        setBody(next);
        setRequest({ generation, destination, placement, signal, startBody, startTop, resolve: complete });
      });
    } catch {
      return signal.aborted || abort.signal.aborted
        ? { kind: "Cancelled", displaced: false }
        : { kind: "Unavailable", reason: "PositioningFailed", displaced: false };
    }
  }, [document, session, structure]);

  const [initialTarget] = useState(() => {
    const locator = initialLocator;
    if (locator?.kind === "epub" || locator?.kind === "web") {
      if (locator.locations.text_offset !== null) return { fragmentId: locator.target.fragment_id, target: { kind: "Offset" as const, offset: locator.locations.text_offset } };
      return locator.kind === "epub" && locator.target.anchor_id.kind === "Present"
        ? { fragmentId: locator.target.fragment_id, target: { kind: "Anchor" as const, anchorId: locator.target.anchor_id.value } }
        : null;
    }
    return { fragmentId: body.id, target: { kind: "Offset" as const, offset: 0 } };
  });
  useEffect(() => {
    if (initialTarget) void navigate(initialTarget, null, new AbortController().signal, true);
    else setError("The saved location has no exact text position.");
    return () => {
      generationRef.current += 1;
      loadRef.current?.abort();
      if (pendingRef.current) pendingRef.current.complete({ kind: "Cancelled", displaced: pendingRef.current.displaced() });
    };
  }, [initialTarget, navigate]);

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
      const generation = generationRef.current;
      trustedRef.current = null;
      if (anchor?.body.id === body.id) {
        void offlinePositioner.run((commands) => {
          if (anchor.target.kind === "Anchor" || cursor.length === 0) {
            const element = anchor.target.kind === "Anchor" ? findSourceAnchor(root, anchor.target.anchorId) : root;
            if (element) commands.adjustTop(viewport, element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.topDelta);
            viewport.scrollLeft = anchor.scrollLeft;
          } else {
            const restored = restoreCanonicalTextAnchorViewportPosition(commands, viewport, cursor, anchor.target.offset, anchor.topDelta, anchor.scrollLeft);
            if (!restored) scrollToExactCanonicalTextAnchor(commands, viewport, cursor, anchor.target.offset);
          }
        }).then(() => {
          if (generation === generationRef.current && cursorRef.current === cursor) captureRef.current(false);
        });
      } else captureRef.current(false);
    });
    observer.observe(root);
    observer.observe(viewport);
    return () => { observer.disconnect(); cursorRef.current = null; layoutRef.current = null; };
  }, [body]);

  useLayoutEffect(() => {
    if (!request || request.signal.aborted || request.generation !== generationRef.current || request.destination.fragmentId !== body.id) return;
    const viewport = viewportRef.current;
    const root = contentRef.current;
    const cursor = cursorRef.current;
    if (!viewport || !root || !cursor) return;
    const target = request.destination.target;
    const element = target.kind === "Anchor" ? findSourceAnchor(root, target.anchorId) : root;
    if (target.kind === "Anchor" && !element) {
      request.resolve({ kind: "Unavailable", reason: "TargetUnavailable", displaced: request.startBody !== body.id });
      setRequest(null);
      return;
    }
    let arrived = false;
    void offlinePositioner.run((commands) => {
      const placement = request.placement?.placement;
      if (request.signal.aborted || request.generation !== generationRef.current) return;
      if (target.kind === "Anchor" && element) {
        commands.setTop(viewport, viewport.scrollTop + element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - (placement?.kind === "Text" ? placement.anchorToViewport : getPaneScrollTopPaddingPx(viewport)));
      } else if (target.kind === "Offset" && cursor.length === 0 && target.offset === 0) {
        commands.setTop(viewport, 0);
      } else if (target.kind === "Offset" && placement?.kind === "Text") {
        restoreCanonicalTextAnchorViewportPosition(commands, viewport, cursor, target.offset, placement.anchorToViewport, placement.horizontal);
      } else if (target.kind === "Offset") {
        scrollToExactCanonicalTextAnchor(commands, viewport, cursor, target.offset);
      }
      if (placement?.kind === "Text") viewport.scrollLeft = placement.horizontal;
      const delta = target.kind === "Anchor" && element
        ? element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
        : target.kind === "Offset" && cursor.length === 0
          ? root.getBoundingClientRect().top - viewport.getBoundingClientRect().top
          : target.kind === "Offset"
            ? measureCanonicalTextAnchorViewportDelta(viewport, cursor, target.offset)
            : null;
      arrived = delta !== null && (placement?.kind === "Text"
        ? Math.abs(delta - placement.anchorToViewport) <= 1 && Math.abs(viewport.scrollLeft - placement.horizontal) <= 1
        : target.kind === "Anchor"
          ? delta >= -1 && delta <= viewport.clientHeight
          : target.kind === "Offset" && (cursor.length === 0 || isCanonicalTextAnchorVisible(viewport, cursor, target.offset)));
      if (arrived && delta !== null) {
        currentAnchorRef.current = { body, target, topDelta: delta, scrollLeft: viewport.scrollLeft };
        if (request.placement?.focus.kind === "Present") focusCheckpoint(request.placement);
      }
    }).then(() => {
      if (request.signal.aborted || request.generation !== generationRef.current) return;
      request.resolve(arrived ? { kind: "Arrived" } : { kind: "Unavailable", reason: "TargetUnavailable", displaced: request.startBody !== body.id || (request.startTop !== null && viewport.scrollTop !== request.startTop) });
      setRequest(null);
      if (arrived) captureRef.current(false);
    });
  }, [body, request]);

  function jump(sectionId: string) {
    const section = document.navigation.sections.find((entry) => entry.section_id === sectionId);
    if (!section) throw new Error("Map destination is absent from the publication");
    readerIntentRef.current = true;
    void navigation.inspect((signal) => navigate({ fragmentId: section.target.fragment_id, target: section.anchor_id.kind === "Present"
      ? { kind: "Anchor", anchorId: section.anchor_id.value }
      : { kind: "Offset", offset: section.target.offset } }, null, signal));
  }
  function jumpPoint(point: ReaderNavigationTextPoint) {
    readerIntentRef.current = true;
    void navigation.inspect((signal) => navigate(
      { fragmentId: point.fragment_id, target: { kind: "Offset", offset: point.offset } },
      null,
      signal,
    ));
  }
  function revealCurrent() {
    const anchor = currentAnchorRef.current;
    readerIntentRef.current = true;
    if (anchor) void navigation.inspect((signal) => navigate({ fragmentId: anchor.body.id, target: anchor.target }, null, signal));
  }
  const index = document.navigation.fragments.findIndex((fragment) => fragment.fragment_id === body.id);
  const next = document.navigation.fragments[index + 1];
  const previous = document.navigation.fragments[index - 1];
  const active = current.kind === "Present" ? readerSectionAtPosition(structure, current.value) : absent<ReaderPositionedSection>();
  const held = navigation.state.kind === "Exploring" && navigation.state.origin.kind === "Present" ? navigation.state.origin.value.locator : null;
  const heldFragment = held?.kind === "web" || held?.kind === "epub" ? structure.fragmentOffsets.get(held.target.fragment_id) : null;
  const heldSection = heldFragment && held && held.kind !== "pdf" && held.locations.text_offset !== null
    ? readerSectionAtPosition(structure, heldFragment.start + held.locations.text_offset)
    : absent<ReaderPositionedSection>();

  return (
    <>
      {error ? <p role="alert" className={styles.notice}>{error}</p> : null}
      <ReaderNavigationStatus navigation={navigation} originLabel={heldSection.kind === "Present" ? heldSection.value.section.label : null} focusReader={() => viewportRef.current?.focus()} focusReturn={focusCheckpoint} />
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
          onGenuineInput={() => { readerIntentRef.current = true; navigation.noteGenuineInput(); }}
          onSeekStart={navigation.beginSeek}
          onTrustedScrollIntent={(direction) => {
            generationRef.current += 1;
            loadRef.current?.abort();
            if (pendingRef.current) pendingRef.current.complete({ kind: "Cancelled", displaced: pendingRef.current.displaced() });
            setRequest(null);
            trustedRef.current = direction;
            if (direction === "forward" && document.navigation.fragments.at(-1)?.fragment_id === body.id && viewportRef.current && endRef.current && isTextViewportAtEnd(viewportRef.current, endRef.current)) captureRef.current(true);
          }}
          endContent={<nav className={styles.actions} aria-label="Reading order">
            {previous ? <button type="button" onClick={() => { readerIntentRef.current = true; void navigation.inspect((signal) => navigate({ fragmentId: previous.fragment_id, target: { kind: "Offset", offset: 0 } }, null, signal)); }}>previous resource</button> : null}
            {next ? <button type="button" onClick={() => {
              readerIntentRef.current = true;
              const destination: EpubRestoreRequest = { fragmentId: next.fragment_id, target: { kind: "Offset", offset: 0 } };
              if (!navigation.isReadingEligible()) {
                void navigation.inspect((signal) => navigate(destination, null, signal));
                return;
              }
              void navigate(destination, null, new AbortController().signal).then((outcome) => {
                if (outcome.kind === "Arrived" && navigation.isReadingEligible()) {
                  const checkpoint = captureCheckpoint();
                  if (checkpoint) saveRef.current(checkpoint.locator);
                }
              });
            }}>continue reading</button> : <span>end of document</span>}
          </nav>}
          onContentClick={() => undefined}
          onContentPointerOver={() => undefined}
          onContentPointerOut={() => undefined}
          onContentFocus={() => undefined}
          onContentBlur={() => undefined}
          onInternalLinkClick={(link) => {
            const destination = resolveReaderInternalLinkTarget(link, document.kind === "WebArticle" ? bodyRef.current.id : null);
            if (destination.kind === "Absent") return false;
            readerIntentRef.current = true;
            const opener = contentRef.current ? findUniqueSourceLinkOwner(contentRef.current, link) : null;
            const occurrence: Presence<ReaderOccurrence> = navigation.state.kind === "Exploring"
              ? destination.value.target.kind === "Anchor"
                ? present({ sourceKey, id: `${destination.value.fragmentId}:${destination.value.target.anchorId}` })
                : absent()
              : opener && contentRef.current?.contains(opener)
                ? present({ sourceKey, id: `${bodyRef.current.id}:${opener.id}` })
                : absent();
            void navigation.inspect((signal) => navigate(destination.value, null, signal), occurrence);
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
