import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import PdfReader from "@/components/PdfReader";
import TextDocumentReader from "@/components/reader/TextDocumentReader";
import ReaderDocumentMapDetail from "@/components/reader/ReaderDocumentMapDetail";
import ReaderDocumentMapOverviewRail from "@/components/reader/ReaderDocumentMapOverviewRail";
import { absent, present, type Presence } from "@/lib/api/presence";
import { buildCanonicalCursor, validateCanonicalText, type CanonicalCursorResult } from "@/lib/highlights/canonicalCursor";
import type { EpubFragmentContent } from "@/lib/media/epubFragment";
import type { Fragment } from "@/lib/media/transcriptView";
import type {
  ReaderDocumentMapMarker,
  ReaderMapMarkerPresentation,
} from "@/lib/reader/documentMap";
import { findSourceAnchor, resolveEpubInternalLinkTarget, type EpubRestoreRequest } from "@/lib/reader/epubInternalLinks";
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
  PdfReaderDecorations,
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
  const [readerEpoch, setReaderEpoch] = useState(0);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [changedSourceAcknowledged, setChangedSourceAcknowledged] = useState(false);
  const authoritativeProgressRef = useRef(authoritativeProgress);

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
  const preferredLocator = preferredReaderLocator(progress);
  const sectionLabel = (locator: Extract<ReaderResumeState, { kind: "epub" | "web" }>): string | null => {
    if (document.kind === "Pdf" || locator.locations.text_offset === null) return null;
    const structure = buildReaderDocumentStructure(document.navigation);
    const section = readerSectionAtPosition(structure, readerTextPointOffset(structure, {
      fragment_id: locator.target.fragment_id, offset: locator.locations.text_offset,
    }));
    return section.kind === "Present" ? section.value.section.label : null;
  };

  const applyProgress = async (next: ReaderProgressView) => {
    setProgress(next);
    setReaderEpoch((current) => current + 1);
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
            onClick={() => void session.progress.resolve(mediaId, "Canonical").then(applyProgress)}
          >
            {offlineReadingConflictChoiceLabel(
              "Canonical",
              offlineReaderLocatorContext(conflict.canonical, sectionLabel),
            )}
          </button>
          <button
            type="button"
            className={styles.action}
            onClick={() => void session.progress.resolve(mediaId, "Device").then(applyProgress)}
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
        <PdfReader
          key={`pdf:${readerEpoch}`}
          mediaId={mediaId}
          resources={{
            signedUrl: { status: "ready", data: document.document },
            pageHighlights: { status: "ready", data: [] },
            requestSignedUrlRefresh: () => undefined,
          }}
          decorations={noOfflinePdfDecorations}
          isMobile
          mobileChromeEnabled={false}
          acquireMobileChromeVisibleLock={() => () => undefined}
          scrollPositioner={offlinePositioner}
          handleAuthenticationError={() => false}
          startPageNumber={preferredLocator?.kind === "pdf" ? preferredLocator.page : 1}
          startPageProgression={
            preferredLocator?.kind === "pdf"
              ? preferredLocator.page_progression ?? undefined
              : undefined
          }
          startZoom={
            preferredLocator?.kind === "pdf"
              ? preferredLocator.zoom ?? undefined
              : undefined
          }
          onSemanticViewportChange={(viewport) => {
            if (viewport?.intent === "Reader") save(viewport.primaryLocator);
          }}
        />
      ) : (
        <OfflineTextReader
          key={`${readerEpoch}:${document.navigation.generation}`}
          document={document}
          session={session}
          initialLocator={preferredLocator}
          onSave={save}
        />
      )}
    </div>
  );
}

type OfflineTextDocument = Exclude<LoadedReaderDocument, { kind: "Pdf" }>;
type OfflineTextBody = {
  id: string;
  html: string;
  text: string;
  epubFragment: EpubFragmentContent | null;
};
type OfflineTextOrigin = {
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

function OfflineTextReader({ document, session, initialLocator, onSave }: {
  document: OfflineTextDocument;
  session: DocumentReaderSession;
  initialLocator: ReaderResumeState | null;
  onSave: (locator: ReaderResumeState) => void;
}) {
  const structure = useMemo(() => buildReaderDocumentStructure(document.navigation), [document.navigation]);
  const [body, setBody] = useState(() => offlineTextBody(document.kind === "Epub" ? document.fragment : document.activeFragment));
  const [request, setRequest] = useState<{
    generation: number;
    destination: EpubRestoreRequest;
    intent: "Restore" | "Preview" | "Return" | "Rollback";
    origin: OfflineTextOrigin | null;
    departure: OfflineTextOrigin | null;
  } | null>(null);
  const [origin, setOrigin] = useState<OfflineTextOrigin | null>(null);
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
  const trustedRef = useRef<"forward" | "backward" | null>(null);
  const currentAnchorRef = useRef<OfflineTextOrigin | null>(null);
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
    if (!saveReading || direction === null) return;
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

  const navigate = useCallback(async (destination: EpubRestoreRequest, intent: "Restore" | "Preview" | "Return", candidate: OfflineTextOrigin | null) => {
    loadRef.current?.abort();
    const abort = new AbortController();
    loadRef.current = abort;
    const generation = ++generationRef.current;
    const departure = currentAnchorRef.current;
    trustedRef.current = null;
    setError(null);
    if (!structure.fragmentOffsets.has(destination.fragmentId)) {
      setError("The requested fragment is unavailable in this copy.");
      return;
    }
    try {
      let next = bodyRef.current;
      if (next.id !== destination.fragmentId) {
        if (intent === "Return" && candidate?.body.id === destination.fragmentId) next = candidate.body;
        else if (document.kind === "Epub") {
          const fragment = await session.loadEpubFragment(destination.fragmentId, abort.signal);
          if (fragment.generation !== document.navigation.generation) throw new Error("Downloaded fragment generation changed");
          next = offlineTextBody(fragment);
        } else {
          const fragment = document.fragments.find((item) => item.id === destination.fragmentId);
          if (!fragment) throw new Error("Downloaded web fragment is unavailable");
          next = offlineTextBody(fragment);
        }
      }
      if (abort.signal.aborted || generation !== generationRef.current) return;
      setBody(next);
      setRequest({ generation, destination, intent, origin: candidate, departure });
    } catch {
      if (!abort.signal.aborted && generation === generationRef.current) setError("The requested location could not be opened.");
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
    if (initialTarget) void navigate(initialTarget, "Restore", null);
    else setError("The saved location has no exact text position.");
    return () => {
      generationRef.current += 1;
      loadRef.current?.abort();
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
            restoreCanonicalTextAnchorViewportPosition(commands, viewport, cursor, anchor.target.offset, anchor.topDelta, anchor.scrollLeft);
            if (!isCanonicalTextAnchorVisible(viewport, cursor, anchor.target.offset)) scrollToExactCanonicalTextAnchor(commands, viewport, cursor, anchor.target.offset);
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
    if (!request || request.generation !== generationRef.current || request.destination.fragmentId !== body.id) return;
    const viewport = viewportRef.current;
    const root = contentRef.current;
    const cursor = cursorRef.current;
    if (!viewport || !root) return;
    let arrived = false;
    const target = request.destination.target;
    const returnOrigin = request.intent === "Return" || request.intent === "Rollback" ? request.origin : null;
    const anchor = target.kind === "Anchor" ? findSourceAnchor(root, target.anchorId) : null;
    const hasArrived = () => {
      if (!cursor) return false;
      if (returnOrigin) {
        const delta = target.kind === "Anchor" ? anchor ? anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top : null
          : cursor.length === 0 ? root.getBoundingClientRect().top - viewport.getBoundingClientRect().top
          : measureCanonicalTextAnchorViewportDelta(viewport, cursor, target.offset);
        return delta !== null && Math.abs(delta - returnOrigin.topDelta) <= 1 && Math.abs(viewport.scrollLeft - returnOrigin.scrollLeft) <= 1;
      }
      if (target.kind === "Anchor") {
        const rect = anchor?.getBoundingClientRect();
        const view = viewport.getBoundingClientRect();
        return !!rect && rect.top >= view.top - 1 && rect.top <= view.bottom;
      }
      return cursor.length === 0 ? target.offset === 0 && viewport.scrollTop === 0 : isCanonicalTextAnchorVisible(viewport, cursor, target.offset);
    };
    void offlinePositioner.run((commands) => {
      if (request.generation !== generationRef.current || !cursor) return;
      if (target.kind === "Anchor") {
        if (anchor) {
          if (returnOrigin) {
            commands.adjustTop(viewport, anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - returnOrigin.topDelta);
            viewport.scrollLeft = returnOrigin.scrollLeft;
          } else commands.setTop(viewport, viewport.scrollTop + anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - getPaneScrollTopPaddingPx(viewport));
        }
      } else if (target.offset === 0 && cursor.length === 0) {
        if (returnOrigin) {
          commands.adjustTop(viewport, root.getBoundingClientRect().top - viewport.getBoundingClientRect().top - returnOrigin.topDelta);
          viewport.scrollLeft = returnOrigin.scrollLeft;
        } else commands.setTop(viewport, 0);
      } else if (returnOrigin) {
        restoreCanonicalTextAnchorViewportPosition(commands, viewport, cursor, target.offset, returnOrigin.topDelta, returnOrigin.scrollLeft);
      } else {
        scrollToExactCanonicalTextAnchor(commands, viewport, cursor, target.offset);
      }
      arrived = hasArrived();
      if (arrived) {
        if (target.kind === "Anchor" || cursor.length === 0) {
          const element = target.kind === "Anchor" ? anchor : root;
          if (element) currentAnchorRef.current = { body, target, topDelta: element.getBoundingClientRect().top - viewport.getBoundingClientRect().top, scrollLeft: viewport.scrollLeft };
        } else {
          const topDelta = measureCanonicalTextAnchorViewportDelta(viewport, cursor, target.offset);
          if (topDelta !== null) currentAnchorRef.current = { body, target, topDelta, scrollLeft: viewport.scrollLeft };
        }
      }
    }).then(() => {
      if (request.generation !== generationRef.current) return;
      if (arrived && hasArrived()) {
        if (request.intent === "Preview" && request.origin) setOrigin(request.origin);
        if (request.intent === "Return") setOrigin(null);
        captureRef.current(false);
      } else {
        setError("The exact destination is unavailable in this rendered copy.");
        if (request.departure) {
          const departure = request.departure;
          setBody(departure.body);
          setRequest({
            generation: request.generation,
            destination: { fragmentId: departure.body.id, target: departure.target },
            intent: "Rollback", origin: departure, departure: null,
          });
          return;
        }
      }
      setRequest(null);
    });
  }, [body, request]);

  function jump(sectionId: string) {
    const section = document.navigation.sections.find((entry) => entry.section_id === sectionId);
    if (!section) throw new Error("Map destination is absent from the publication");
    const candidate = origin ?? currentAnchorRef.current;
    void navigate({ fragmentId: section.target.fragment_id, target: section.anchor_id.kind === "Present"
      ? { kind: "Anchor", anchorId: section.anchor_id.value }
      : { kind: "Offset", offset: section.target.offset } }, "Preview", candidate);
  }
  function revealCurrent() {
    const anchor = currentAnchorRef.current;
    if (anchor) void navigate({ fragmentId: anchor.body.id, target: anchor.target }, "Restore", null);
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
          if (detailOpen) setOrigin(null);
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
        onNavigateSection={jump}
        onActivateMarker={(marker) => jump(marker.item_id)}
        onRevealCurrent={revealCurrent}
        onReturn={origin ? present(() => void navigate({ fragmentId: origin.body.id, target: origin.target }, "Return", origin)) : absent()}
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
            generationRef.current += 1;
            loadRef.current?.abort();
            setRequest(null);
            setOrigin(null);
            trustedRef.current = direction;
            if (direction === "forward" && document.navigation.fragments.at(-1)?.fragment_id === body.id && viewportRef.current && endRef.current && isTextViewportAtEnd(viewportRef.current, endRef.current)) captureRef.current(true);
          }}
          endContent={<nav className={styles.actions} aria-label="Reading order">
            {previous ? <button type="button" onClick={() => void navigate({ fragmentId: previous.fragment_id, target: { kind: "Offset", offset: 0 } }, "Restore", null)}>previous resource</button> : null}
            {next ? <button type="button" onClick={() => void navigate({ fragmentId: next.fragment_id, target: { kind: "Offset", offset: 0 } }, "Restore", null)}>continue reading</button> : <span>end of document</span>}
          </nav>}
          onContentClick={() => undefined}
          onContentPointerOver={() => undefined}
          onContentPointerOut={() => undefined}
          onContentFocus={() => undefined}
          onContentBlur={() => undefined}
          onInternalLinkClick={(link) => {
            const destination = resolveEpubInternalLinkTarget(link);
            if (destination.kind === "Absent") return false;
            void navigate(destination.value, "Restore", null);
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
