"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  PDF_PASSWORD_PROTECTED_MESSAGE,
  toFeedback,
} from "@/components/feedback/Feedback";
import type { PdfReaderResumeState } from "@/lib/reader/types";
import { useReaderPulseHighlight } from "@/lib/reader/pulseEvent";
import {
  useMobileChromeReaderScrollport,
  useMobileChromeVisibleLocks,
} from "@/lib/workspace/mobileChrome";
import { useReaderScrollPositioner } from "@/lib/reader/paneScroll";
import { composeRefs } from "@/lib/ui/composeRefs";
import {
  PDF_WORKER_SRC,
  getPdfSelection,
  loadPdfJs,
  loadPdfJsViewer,
  type PdfDocumentLike,
  type PdfDocumentLoadingTaskLike,
  type PdfEventBusLike,
  type PdfJsLike,
  type PdfJsViewerLike,
  type PdfLinkServiceLike,
  type PdfPageViewLike,
  type PdfViewerLike,
} from "@/components/pdfReaderRuntime";
import {
  createPdfFindRuntime,
  pdfFindSourceAccessRefreshAbort,
  type PdfFindOrigin,
  type PdfFindOriginCapture,
  type PdfFindRuntime,
} from "@/components/pdfPaneFind";
import SelectionPopover, { DEFAULT_COLOR } from "./SelectionPopover";
import { useHighlightNoteChord } from "@/lib/highlights/useHighlightNoteChord";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import {
  rectToCanonicalQuad,
  type PdfHighlightQuad,
} from "@/lib/highlights/pdfTypes";
import { usePdfScrollToTarget } from "@/lib/highlights/usePdfScrollToTarget";
import {
  isValidPdfRect,
  projectPdfQuadToViewportRect,
} from "@/lib/highlights/coordinateTransforms";
import {
  computePageLayerAlignmentDelta,
  deriveScaleFromPageView,
  deriveViewportTransformFromPageView,
  measureMaxRenderedPdfPageWidthPx,
} from "@/lib/highlights/pdfPageViewport";
import { clamp } from "@/lib/clamp";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import { useResource } from "@/lib/api/useResource";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { isPositiveFinite } from "@/lib/validation";
import styles from "./PdfReader.module.css";

interface PdfFileAccessResponse {
  data: {
    url: string;
    expires_at: string;
  };
}

interface SignedUrlAccess {
  url: string;
  expiresAtMs: number | null;
}

export interface PdfHighlightOut {
  id: string;
  anchor: {
    type: "pdf_page_geometry";
    media_id: string;
    page_number: number;
    quads: PdfHighlightQuad[];
  };
  color: HighlightColor;
  exact: string;
  prefix: string;
  suffix: string;
  created_at: string;
  updated_at: string;
  author_user_id: string;
  is_owner: boolean;
  linked_conversations?: { conversation_id: string; title: string }[];
  linked_note_blocks?: {
    note_block_id: string;
    body_pm_json?: Record<string, unknown>;
    body_text: string;
  }[];
}

export interface PdfHighlightNavigationRequest {
  highlightId: string;
  pageNumber: number;
  quads: PdfHighlightQuad[];
}

export interface PdfTemporaryHighlight {
  id: string;
  pageNumber: number;
  quads: PdfHighlightQuad[];
  color: HighlightColor;
}

interface PdfTransientPulseHighlight {
  id: string;
  pageNumber: number;
  quads: PdfHighlightQuad[];
}

interface PdfPulseNavigationTarget {
  key: string;
  pageNumber: number;
  quads: PdfHighlightQuad[];
  highlightId: string | null;
  transientPulseId: string | null;
}

export interface PdfReaderControlsState {
  pageNumber: number;
  numPages: number;
  zoomPercent: number;
  canGoPrev: boolean;
  canGoNext: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
  pageRenderEpoch: number;
  isBusy: boolean;
}

export interface PdfReaderControlActions {
  goToPreviousPage: () => void;
  goToNextPage: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Later addressable cursor application (page/progression/zoom), no remount. */
  applyResumeState: (resume: PdfReaderResumeState) => boolean;
  /** Synchronous freshest-position capture for lifecycle promotion. */
  captureResumeState: () => PdfReaderResumeState | null;
}

interface PdfHighlightListResponse {
  data: {
    page_number: number;
    highlights: PdfHighlightOut[];
  };
}

interface PdfHighlightCreateResponse {
  data: PdfHighlightOut;
}

interface OpenedPdfDocument {
  doc: PdfDocumentLike;
  loadingTask: PdfDocumentLoadingTaskLike;
}

export interface PdfReaderIntrinsicWidthState {
  maxRenderedPageWidthPx: number | null;
}

interface PdfReaderProps {
  mediaId: string;
  mobileChromeEnabled: boolean;
  beforeContent?: ReactNode;
  /** The scrolling, focusable PDF viewport. */
  viewportRef?: MutableRefObject<HTMLDivElement | null>;
  /** The inner `.pdfViewer` content surface. */
  contentRef?: MutableRefObject<HTMLDivElement | null>;
  onControlsStateChange?: (state: PdfReaderControlsState) => void;
  onControlsReady?: (actions: PdfReaderControlActions | null) => void;
  onIntrinsicWidthChange?: (state: PdfReaderIntrinsicWidthState) => void;
  focusedHighlightId?: string | null;
  hoveredHighlightId?: string | null;
  editingHighlightId?: string | null;
  highlightRefreshToken?: number;
  onPageHighlightsChange?: (
    pageNumber: number,
    highlights: PdfHighlightOut[],
  ) => void;
  navigateToHighlight?: PdfHighlightNavigationRequest | null;
  onHighlightNavigationComplete?: () => void;
  onHighlightsMutated?: () => void;
  onHighlightTap?: (highlightId: string, anchorRect: DOMRect) => void;
  onHighlightHover?: (highlightId: string | null) => void;
  temporaryHighlight?: PdfTemporaryHighlight | null;
  onQuoteToNewChat?: (
    highlightId: string,
    highlight: PdfHighlightOut,
  ) => void | Promise<void>;
  onQuoteToExistingChat?: (
    highlightId: string,
    highlight: PdfHighlightOut,
  ) => void | Promise<void>;
  onLearn?: (
    highlightId: string,
    highlight: PdfHighlightOut,
  ) => void | Promise<void>;
  onAddNote?: (session: {
    quote: string;
    anchorRect: DOMRect;
    creation: Promise<{ id: string } | null>;
  }) => void;
  /**
   * Open a Link over a FRESH PDF selection using its true page-space quads. Unlike
   * highlight/note creation this performs no write — the Link service creates the
   * Highlight atomically on confirmation (invariant 6). The caller mints the
   * client-stable `highlight_id`.
   */
  onLink?: (selection: {
    pageNumber: number;
    quads: PdfHighlightQuad[];
    exact: string;
  }) => void;
  /** Resume seed: page (1-based) to open when this media loads */
  startPageNumber?: number;
  /** Resume seed: intra-page scroll progression to apply after first render */
  startPageProgression?: number;
  /** Resume seed: zoom scale to apply when this media loads */
  startZoom?: number;
  /** Called when page or zoom changes for progress persistence */
  onResumeStateChange?: (resumeState: PdfReaderResumeState | null) => void;
  /** Publishes the exact document-bound PDF Find runtime. */
  onFindRuntimeReady?: (runtime: PdfFindRuntime | null) => void;
}

interface SelectionState {
  range: Range;
  rect: DOMRect;
  lineRects: DOMRect[];
  pageNumber: number;
}

interface ProjectedHighlightRect {
  highlightId: string;
  color: HighlightColor;
  index: number;
  isTemporary: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ViewerEventHandlers {
  pagechanging: (event: unknown) => void;
  pagesloaded: (event: unknown) => void;
  pagerendered: (event: unknown) => void;
  textlayerrendered: (event: unknown) => void;
  annotationlayerrendered: (event: unknown) => void;
}

interface PdfReaderPositioningRenderTarget {
  runId: number;
  pageNumber: number;
  zoom: number;
}

export type PdfViewportIntent =
  | "ReaderRestore"
  | "FindPreview"
  | "FindReturn";

const SIGNED_URL_REFRESH_SKEW_MS = 2_000;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;
const PDF_VIEWER_TEXT_LAYER_MODE_ENABLE = 1;
const PDF_LINK_TARGET_BLANK = 2;
const PDF_GEOMETRY_ALIGNMENT_DELTA_THRESHOLD = 0.02;
const PDF_TEXT_LAYER_REFRESH_FRAME_BUDGET = 12;
const PDF_HIGHLIGHT_SCROLL_TARGET_FRACTION = 0.35;
const PDF_PULSE_DURATION_MS = 1200;
const MOBILE_SELECTION_STABILIZATION_DELAY_MS = 180;
const PDF_SELECTION_POLL_INTERVAL_MS = 150;
const PDF_FIND_VIEWPORT_FRAME_BUDGET = 180;
const PDF_FIND_VIEWPORT_POSITION_EPSILON_PX = 1;
const PDF_FIND_VIEWPORT_SCALE_EPSILON = 0.01;
const OVERLAY_COLOR_MAP: Record<HighlightColor, string> = {
  yellow: "rgba(255, 235, 59, 0.35)",
  green: "rgba(76, 175, 80, 0.3)",
  blue: "rgba(33, 150, 243, 0.3)",
  pink: "rgba(233, 30, 99, 0.3)",
  purple: "rgba(156, 39, 176, 0.3)",
};

function extractErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };

  if (typeof candidate.status === "number") {
    return candidate.status;
  }
  if (typeof candidate.statusCode === "number") {
    return candidate.statusCode;
  }
  if (typeof candidate.response?.status === "number") {
    return candidate.response.status;
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "";
}

function isPasswordPdfError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.toLowerCase().includes("password")) {
      return true;
    }
  }
  return /password/i.test(errorMessage(error));
}

function isLikelySignedUrlExpiryError(error: unknown): boolean {
  const status = extractErrorStatus(error);
  if (status === 401 || status === 403) {
    return true;
  }

  return /(expired|signature|forbidden|unauthorized|403|401|unexpected server response)/i.test(
    errorMessage(error),
  );
}

function toUserFacingError(error: unknown): string {
  if (isPasswordPdfError(error)) {
    return PDF_PASSWORD_PROTECTED_MESSAGE;
  }
  return toFeedback(error, {
    fallback: "Unable to load this PDF right now. Please retry.",
  }).title;
}

function signedUrlAccessFromResponse(
  response: PdfFileAccessResponse,
): SignedUrlAccess {
  const expiresAtMs = Date.parse(response.data.expires_at);
  return {
    url: response.data.url,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
  };
}

async function loadSignedUrlAccess(
  mediaId: string,
  signal: AbortSignal,
): Promise<SignedUrlAccess> {
  return signedUrlAccessFromResponse(
    await apiFetch<PdfFileAccessResponse>(`/api/media/${mediaId}/file`, {
      signal,
    }),
  );
}

async function loadPageHighlights(
  mediaId: string,
  targetPage: number,
  signal: AbortSignal,
): Promise<PdfHighlightOut[]> {
  const response = await apiFetch<PdfHighlightListResponse>(
    `/api/media/${mediaId}/pdf-highlights?page_number=${targetPage}&mine_only=false`,
    { signal },
  );
  return response.data.highlights.filter(
    (highlight) =>
      highlight.anchor.type === "pdf_page_geometry" &&
      highlight.anchor.page_number === targetPage,
  );
}

function isTextLayerEligibleNode(
  node: Node | null,
  textLayerRoot: HTMLElement | null,
): boolean {
  if (!node || !textLayerRoot) {
    return false;
  }
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
  return !!element && textLayerRoot.contains(element);
}

function isSelectionRangeInTextLayer(
  range: Range,
  textLayerRoot: HTMLElement | null,
): boolean {
  if (!textLayerRoot) {
    return false;
  }
  const startsInLayer = isTextLayerEligibleNode(
    range.startContainer,
    textLayerRoot,
  );
  const endsInLayer = isTextLayerEligibleNode(
    range.endContainer,
    textLayerRoot,
  );
  if (startsInLayer && endsInLayer) {
    return true;
  }

  const selectionRect = range.getBoundingClientRect();
  if (!isValidPdfRect(selectionRect)) {
    return false;
  }
  const layerRect = textLayerRoot.getBoundingClientRect();
  return (
    selectionRect.left < layerRect.right &&
    selectionRect.right > layerRect.left &&
    selectionRect.top < layerRect.bottom &&
    selectionRect.bottom > layerRect.top
  );
}

function readPageNumberFromTextLayer(
  textLayerRoot: HTMLElement | null,
): number | null {
  const parsedPageNumber = Number.parseInt(
    textLayerRoot?.closest(".page")?.getAttribute("data-page-number") ?? "",
    10,
  );
  if (!Number.isFinite(parsedPageNumber) || parsedPageNumber <= 0) {
    return null;
  }
  return parsedPageNumber;
}

function toSelectionSnapshot(
  range: Range,
  textLayerRoot: HTMLElement | null,
  pageNumber: number,
): SelectionState {
  const rect = range.getBoundingClientRect();
  const lineRects = Array.from(range.getClientRects()).filter(
    (clientRect) => clientRect.width > 0 && clientRect.height > 0,
  );
  const effectiveRect =
    rect.width > 0 && rect.height > 0
      ? rect
      : (textLayerRoot?.getBoundingClientRect() ?? rect);
  return {
    range: range.cloneRange(),
    rect: effectiveRect,
    lineRects: lineRects.length > 0 ? lineRects : [effectiveRect],
    pageNumber,
  };
}

function refreshPdfSelectionSnapshot(
  selection: SelectionState,
): SelectionState | null {
  try {
    const { range } = selection;
    if (
      range.collapsed ||
      !range.startContainer.isConnected ||
      !range.endContainer.isConnected ||
      range.toString().trim().length === 0
    ) {
      return null;
    }
    const rect = range.getBoundingClientRect();
    if (!isValidPdfRect(rect)) return null;
    const lineRects = Array.from(range.getClientRects()).filter((clientRect) =>
      isValidPdfRect(clientRect),
    );
    return {
      ...selection,
      rect,
      lineRects: lineRects.length > 0 ? lineRects : [rect],
    };
  } catch {
    return null;
  }
}

function buildSelectionSnapshotKey(selection: SelectionState): string {
  const { left, top, width, height } = selection.rect;
  return [
    String(selection.pageNumber),
    selection.range.toString().trim(),
    left.toFixed(1),
    top.toFixed(1),
    width.toFixed(1),
    height.toFixed(1),
  ].join("::");
}

async function destroyPdfDocument(doc: PdfDocumentLike | null): Promise<void> {
  if (!doc?.destroy) {
    return;
  }
  try {
    await doc.destroy();
  } catch {
    // Best-effort cleanup only.
  }
}

function destroyPdfLoadingTask(task: PdfDocumentLoadingTaskLike | null): void {
  if (!task?.destroy) {
    return;
  }
  try {
    task.destroy();
  } catch {
    // Best-effort cleanup only.
  }
}

function toViewerLifecycleError(context: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`PDF viewer lifecycle failure (${context}): ${detail}`);
}

function applyViewerScale(
  viewer: PdfViewerLike,
  scale: string | number,
  context: string,
): void {
  try {
    viewer.currentScaleValue = scale;
    viewer.update?.();
  } catch (error) {
    throw toViewerLifecycleError(context, error);
  }
}

function readViewerZoom(viewer: PdfViewerLike): number | null {
  if (isPositiveFinite(viewer.currentScale)) {
    return viewer.currentScale;
  }
  const scaleValue = viewer.currentScaleValue;
  const numericScale =
    typeof scaleValue === "number"
      ? scaleValue
      : Number.parseFloat(scaleValue);
  return isPositiveFinite(numericScale) ? numericScale : null;
}

function applyViewerPageNumber(
  viewer: PdfViewerLike,
  pageNumber: number,
  context: string,
): void {
  try {
    viewer.currentPageNumber = pageNumber;
  } catch (error) {
    throw toViewerLifecycleError(context, error);
  }
}

export default function PdfReader({
  mediaId,
  mobileChromeEnabled,
  beforeContent,
  viewportRef,
  contentRef,
  onControlsStateChange,
  onControlsReady,
  onIntrinsicWidthChange,
  focusedHighlightId = null,
  hoveredHighlightId = null,
  editingHighlightId = null,
  highlightRefreshToken = 0,
  onPageHighlightsChange,
  navigateToHighlight = null,
  onHighlightNavigationComplete,
  onHighlightsMutated,
  onHighlightTap,
  onHighlightHover,
  temporaryHighlight = null,
  onQuoteToNewChat,
  onQuoteToExistingChat,
  onLearn,
  onAddNote,
  onLink,
  startPageNumber,
  startPageProgression,
  startZoom,
  onResumeStateChange,
  onFindRuntimeReady,
}: PdfReaderProps) {
  const isMobile = useIsMobileViewport();
  const mobileChromeVisibleLocks = useMobileChromeVisibleLocks();
  const readerScrollPositioner = useReaderScrollPositioner();
  const mobileChromeScrollportRef =
    useMobileChromeReaderScrollport<HTMLDivElement>({
      sourceKey: mediaId,
      enabled: mobileChromeEnabled,
    });
  const isMobileRef = useRef(isMobile);
  const initialMobileFitDoneRef = useRef(false);
  const startPageNumberRef = useRef(startPageNumber);
  const startPageProgressionRef = useRef(startPageProgression);
  const startZoomRef = useRef(startZoom);

  const [loading, setLoading] = useState(true);
  const [navigating, setNavigating] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(startPageNumberRef.current ?? 1);
  const [numPages, setNumPages] = useState(0);
  const [zoom, setZoom] = useState(startZoomRef.current ?? 1);
  const [pageScale, setPageScale] = useState(1);
  const [pageRenderEpoch, setPageRenderEpoch] = useState(0);
  const [readerRestoreSettled, setReaderRestoreSettled] = useState(false);
  const [textLayerUsable, setTextLayerUsable] = useState(false);
  const [textGeometryReliable, setTextGeometryReliable] = useState(true);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const highlightCreationInFlightRef = useRef(false);
  const [pageHighlights, setPageHighlights] = useState<PdfHighlightOut[]>([]);
  const [signedUrlRefreshToken, setSignedUrlRefreshToken] = useState(0);
  const [localHighlightRefreshToken, setLocalHighlightRefreshToken] =
    useState(0);
  const [pulsingHighlightId, setPulsingHighlightId] = useState<string | null>(
    null,
  );
  const [transientPulseHighlight, setTransientPulseHighlight] =
    useState<PdfTransientPulseHighlight | null>(null);
  const [pulseNavigationTarget, setPulseNavigationTarget] =
    useState<PdfPulseNavigationTarget | null>(null);

  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const internalContentRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<PdfDocumentLike | null>(null);
  const loadingTaskRef = useRef<PdfDocumentLoadingTaskLike | null>(null);
  const pdfJsRef = useRef<PdfJsLike | null>(null);
  const pdfJsViewerRef = useRef<PdfJsViewerLike | null>(null);
  const eventBusRef = useRef<PdfEventBusLike | null>(null);
  const linkServiceRef = useRef<PdfLinkServiceLike | null>(null);
  const pdfViewerRef = useRef<PdfViewerLike | null>(null);
  const pdfFindRuntimeRef = useRef<ReturnType<
    typeof createPdfFindRuntime
  > | null>(null);
  const pendingPdfFindRuntimeRef = useRef<PdfFindRuntime | null>(null);
  const eventHandlersRef = useRef<ViewerEventHandlers | null>(null);
  const signedUrlExpiryRef = useRef<number | null>(null);
  const recoverAndRenderRef = useRef<
    ((targetPage: number, runId: number) => void) | null
  >(null);
  const selectionSnapshotRef = useRef<SelectionState | null>(null);
  const activePageScaleRef = useRef(1);
  const zoomRef = useRef(startZoomRef.current ?? 1);
  const runRef = useRef(0);
  const pageNumberRef = useRef(startPageNumberRef.current ?? 1);
  const pendingStartPageProgressionRef = useRef(
    startPageProgressionRef.current ?? null,
  );
  const pageScaleByNumberRef = useRef<Map<number, number>>(new Map());
  const textLayerRenderEpochByPageRef = useRef<Map<number, number>>(new Map());
  const pageGeometryReliabilityRef = useRef<Map<number, boolean>>(new Map());
  const pendingViewerPageRef = useRef<number | null>(null);
  const pendingViewerScaleRef = useRef<string | number | null>(null);
  const recoveringFromRenderErrorRef = useRef(false);
  const onPageHighlightsChangeRef = useRef(onPageHighlightsChange);
  const onHighlightTapRef = useRef(onHighlightTap);
  const onHighlightHoverRef = useRef(onHighlightHover);
  const hasHighlightTapHandler = Boolean(onHighlightTap);
  const hasHighlightHoverHandler = Boolean(onHighlightHover);
  const selectionSnapshotKeyRef = useRef<string | null>(null);
  const selectionVisibleRef = useRef(false);
  const mobileSelectionTimerRef = useRef<number | null>(null);
  const pulseTimerRef = useRef<number | null>(null);
  const pulseSequenceRef = useRef(0);
  const textLayerRefreshFrameRef = useRef<{
    pageNumber: number;
    runId: number;
    frameId: number | null;
  } | null>(null);
  const recoveryTargetPageRef = useRef<number | null>(null);
  const viewportIntentRef = useRef<PdfViewportIntent | null>(null);
  const viewportIntentGenerationRef = useRef(0);
  const readerPositioningResolveRef = useRef<(() => void) | null>(null);
  const readerPositioningRenderTargetRef =
    useRef<PdfReaderPositioningRenderTarget | null>(null);
  const renderedPageZoomByNumberRef = useRef<Map<number, number>>(new Map());

  const signedUrlResource = useResource<SignedUrlAccess>({
    cacheKey: `${mediaId}:${signedUrlRefreshToken}`,
    load: (signal) => loadSignedUrlAccess(mediaId, signal),
  });
  const pageHighlightsResource = useResource<PdfHighlightOut[]>({
    cacheKey:
      documentRef.current && numPages > 0 && !loading && error === null
        ? `${mediaId}:${pageNumber}:${highlightRefreshToken}:${localHighlightRefreshToken}`
        : null,
    load: (signal) => loadPageHighlights(mediaId, pageNumber, signal),
  });

  // Latest-value refs read by async callbacks (event handlers, RAF, etc.).
  onPageHighlightsChangeRef.current = onPageHighlightsChange;
  onHighlightTapRef.current = onHighlightTap;
  onHighlightHoverRef.current = onHighlightHover;
  isMobileRef.current = isMobile;

  useEffect(() => {
    return () => {
      if (pulseTimerRef.current != null) {
        window.clearTimeout(pulseTimerRef.current);
      }
      if (textLayerRefreshFrameRef.current?.frameId != null) {
        window.cancelAnimationFrame(textLayerRefreshFrameRef.current.frameId);
      }
    };
  }, []);

  const onResumeStateChangeRef = useRef(onResumeStateChange);
  onResumeStateChangeRef.current = onResumeStateChange;
  const onFindRuntimeReadyRef = useRef(onFindRuntimeReady);
  onFindRuntimeReadyRef.current = onFindRuntimeReady;
  const onIntrinsicWidthChangeRef = useRef(onIntrinsicWidthChange);
  onIntrinsicWidthChangeRef.current = onIntrinsicWidthChange;
  const lastIntrinsicWidthPxRef = useRef<number | null>(null);

  const publishResumeLocator = useCallback(
    (
      nextPageNumber: number,
      nextZoom: number,
      nextPageProgression: number | null,
    ) => {
      // Programmatic application (initial seed or a later addressable cursor)
      // must not echo as movement: hold publishes until the pending page and
      // intra-page progression have been consumed by the viewer.
      if (
        viewportIntentRef.current === "FindPreview" ||
        viewportIntentRef.current === "FindReturn" ||
        pendingViewerPageRef.current !== null ||
        pendingStartPageProgressionRef.current !== null
      ) {
        return;
      }
      onResumeStateChangeRef.current?.({
        kind: "pdf",
        position: nextPageNumber,
        page: nextPageNumber,
        page_progression: nextPageProgression,
        zoom: nextZoom,
      });
    },
    [],
  );

  const setContentNode = useCallback(
    (node: HTMLDivElement | null) => {
      internalContentRef.current = node;
      if (contentRef) {
        contentRef.current = node;
      }
    },
    [contentRef],
  );

  const setViewportNode = useCallback(
    (node: HTMLDivElement | null) => {
      viewerContainerRef.current = node;
      if (viewportRef) {
        viewportRef.current = node;
      }
    },
    [viewportRef],
  );
  const viewerViewportRef = useMemo(
    () =>
      composeRefs<HTMLDivElement>(
        setViewportNode,
        mobileChromeScrollportRef,
      ),
    [mobileChromeScrollportRef, setViewportNode],
  );

  const publishIntrinsicWidth = useCallback((widthPx: number | null) => {
    if (lastIntrinsicWidthPxRef.current === widthPx) {
      return;
    }
    lastIntrinsicWidthPxRef.current = widthPx;
    onIntrinsicWidthChangeRef.current?.({ maxRenderedPageWidthPx: widthPx });
  }, []);

  const scheduleIntrinsicWidthPublish = useCallback(() => {
    const runId = runRef.current;
    window.requestAnimationFrame(() => {
      if (runId !== runRef.current || !internalContentRef.current) {
        return;
      }
      publishIntrinsicWidth(
        measureMaxRenderedPdfPageWidthPx(internalContentRef.current),
      );
    });
  }, [publishIntrinsicWidth]);

  useEffect(() => {
    if (!mobileChromeEnabled || selection === null) {
      return;
    }
    return mobileChromeVisibleLocks.acquire("pdf-selection");
  }, [
    mobileChromeEnabled,
    mobileChromeVisibleLocks,
    selection,
  ]);

  useEffect(() => {
    if (!mobileChromeEnabled || error !== null || readerRestoreSettled) {
      return;
    }
    return mobileChromeVisibleLocks.acquire("reader-restore");
  }, [
    error,
    mobileChromeEnabled,
    mobileChromeVisibleLocks,
    readerRestoreSettled,
  ]);

  const settleReaderPositioning = useCallback(() => {
    readerPositioningRenderTargetRef.current = null;
    readerPositioningResolveRef.current?.();
    readerPositioningResolveRef.current = null;
  }, []);

  const beginReaderPositioning = useCallback(
    (renderTarget: PdfReaderPositioningRenderTarget | null = null): boolean => {
      if (!mobileChromeEnabled) {
        return false;
      }
      settleReaderPositioning();
      let resolvePositioning!: () => void;
      const positioning = new Promise<void>((resolve) => {
        resolvePositioning = resolve;
      });
      readerPositioningResolveRef.current = resolvePositioning;
      readerPositioningRenderTargetRef.current = renderTarget;
      void readerScrollPositioner.run(async () => {
        await positioning;
      });
      return true;
    },
    [
      mobileChromeEnabled,
      readerScrollPositioner,
      settleReaderPositioning,
    ],
  );

  const waitForReaderPositioningRender = useCallback(
    (pageNumber: number, zoom: number): boolean =>
      beginReaderPositioning({
        runId: runRef.current,
        pageNumber,
        zoom,
      }),
    [beginReaderPositioning],
  );

  const pageHasRenderedAtZoom = useCallback(
    (targetPage: number, zoom: number): boolean => {
      const renderedZoom =
        renderedPageZoomByNumberRef.current.get(targetPage);
      return (
        renderedZoom !== undefined &&
        Math.abs(renderedZoom - zoom) <= PDF_FIND_VIEWPORT_SCALE_EPSILON
      );
    },
    [],
  );

  useEffect(() => {
    if (mobileChromeEnabled) {
      return;
    }
    settleReaderPositioning();
  }, [mobileChromeEnabled, settleReaderPositioning]);

  useEffect(() => {
    if (error === null) {
      return;
    }
    settleReaderPositioning();
  }, [error, settleReaderPositioning]);

  useEffect(
    () => () => settleReaderPositioning(),
    [settleReaderPositioning],
  );

  const ensurePdfJs = useCallback(async () => {
    if (pdfJsRef.current) {
      return pdfJsRef.current;
    }
    const pdfJs = await loadPdfJs();
    try {
      pdfJs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
    } catch {
      // Some PDF.js bundles preconfigure worker wiring.
    }
    pdfJsRef.current = pdfJs;
    return pdfJs;
  }, []);

  const ensurePdfJsViewer = useCallback(async () => {
    if (pdfJsViewerRef.current) {
      return pdfJsViewerRef.current;
    }
    const pdfJsViewer = await loadPdfJsViewer();
    pdfJsViewerRef.current = pdfJsViewer;
    return pdfJsViewer;
  }, []);

  const getPageElement = useCallback(
    (targetPage: number): HTMLElement | null => {
      const root = internalContentRef.current;
      if (!root) {
        return null;
      }
      const byNumber = root.querySelector<HTMLElement>(
        `.page[data-page-number="${targetPage}"]`,
      );
      if (byNumber) {
        return byNumber;
      }
      const fallback =
        root.querySelectorAll<HTMLElement>(".page")[targetPage - 1];
      return fallback ?? null;
    },
    [],
  );

  const readPageMetrics = useCallback(
    (targetPage: number): { pageTop: number; pageHeight: number } | null => {
      const pageElement = getPageElement(targetPage);
      if (!pageElement) {
        return null;
      }

      const pageHeight =
        pageElement.getBoundingClientRect().height ||
        pageElement.scrollHeight ||
        pageElement.clientHeight ||
        Number.parseFloat(pageElement.style.height) ||
        0;
      const pageTop =
        pageElement.offsetTop ||
        (pageHeight > 0 ? (targetPage - 1) * pageHeight : 0);

      return pageHeight > 0 ? { pageTop, pageHeight } : null;
    },
    [getPageElement],
  );

  const readCurrentPageProgression = useCallback((): number | null => {
    const container = viewerContainerRef.current;
    if (!container) {
      return null;
    }
    const pageElement = getPageElement(pageNumberRef.current);
    const metrics = readPageMetrics(pageNumberRef.current);
    if (!pageElement || !metrics) {
      return null;
    }
    const localScrollTop = Math.max(
      0,
      container.getBoundingClientRect().top -
        (pageElement.getBoundingClientRect().top + pageElement.clientTop),
    );
    const maxLocalScroll = Math.max(
      0,
      metrics.pageHeight - container.clientHeight,
    );
    if (maxLocalScroll === 0) {
      return null;
    }
    const progression = clamp(localScrollTop / maxLocalScroll, 0, 1);
    // Top-of-page is the locator's null progression; publishing 0 here would
    // false-dirty against a stored null and echo a write on initial apply.
    return progression === 0 ? null : progression;
  }, [getPageElement, readPageMetrics]);
  const publishCurrentResumeLocator = useCallback(
    (nextPageNumber = pageNumberRef.current, nextZoom = zoomRef.current) => {
      publishResumeLocator(
        nextPageNumber,
        nextZoom,
        readCurrentPageProgression(),
      );
    },
    [publishResumeLocator, readCurrentPageProgression],
  );

  const applyStartPageProgression = useCallback(() => {
    const targetProgression = pendingStartPageProgressionRef.current;
    if (targetProgression === null) {
      return;
    }
    const container = viewerContainerRef.current;
    if (!container) {
      return;
    }
    const metrics = readPageMetrics(pageNumberRef.current);
    if (!metrics) {
      return;
    }
    const maxLocalScroll = Math.max(
      0,
      metrics.pageHeight - container.clientHeight,
    );
    void readerScrollPositioner.run(({ setTop }) => {
      setTop(
        container,
        metrics.pageTop +
          maxLocalScroll * clamp(targetProgression, 0, 1),
      );
      pendingStartPageProgressionRef.current = null;
    });
  }, [readPageMetrics, readerScrollPositioner]);

  useEffect(() => {
    if (onResumeStateChangeRef.current && numPages > 0) {
      publishResumeLocator(pageNumber, zoom, readCurrentPageProgression());
    }
  }, [
    numPages,
    pageNumber,
    publishResumeLocator,
    readCurrentPageProgression,
    zoom,
  ]);

  useEffect(() => {
    const container = viewerContainerRef.current;
    if (!container || !onResumeStateChangeRef.current || numPages <= 0) {
      return;
    }

    let rafId = 0;
    const handleScroll = () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(() => {
        publishResumeLocator(
          pageNumberRef.current,
          zoomRef.current,
          readCurrentPageProgression(),
        );
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScroll);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [numPages, publishResumeLocator, readCurrentPageProgression]);

  const getTextLayerRootForPage = useCallback(
    (targetPage: number): HTMLElement | null => {
      return (
        getPageElement(targetPage)?.querySelector<HTMLElement>(".textLayer") ??
        null
      );
    },
    [getPageElement],
  );

  const markPageSurface = useCallback(
    (targetPage: number, explicitPageView?: PdfPageViewLike) => {
      const pageElement = getPageElement(targetPage);
      if (pageElement) {
        pageElement.setAttribute(
          "data-testid",
          `pdf-page-surface-${targetPage}`,
        );
        const textLayer =
          pageElement.querySelector<HTMLElement>(".textLayer");
        textLayer?.setAttribute(
          "data-testid",
          `pdf-page-text-layer-${targetPage}`,
        );
        textLayer?.setAttribute(
          "data-reader-tap-reveal-surface",
          "true",
        );
        pageElement
          .querySelector<HTMLElement>(".canvasWrapper")
          ?.setAttribute(
            "data-testid",
            `pdf-page-canvas-wrapper-${targetPage}`,
          );
        pageElement
          .querySelector<HTMLElement>(".canvasWrapper canvas")
          ?.setAttribute("data-testid", `pdf-page-canvas-${targetPage}`);
        const pageView =
          explicitPageView ??
          pdfViewerRef.current?.getPageView?.(Math.max(0, targetPage - 1));
        const fallbackScale =
          pageScaleByNumberRef.current.get(targetPage) ?? zoomRef.current;
        const viewportTransform = deriveViewportTransformFromPageView(
          pageView,
          fallbackScale,
        );
        if (viewportTransform) {
          pageElement.setAttribute(
            "data-nexus-page-scale",
            String(viewportTransform.scale),
          );
          pageElement.setAttribute(
            "data-nexus-page-rotation",
            String(viewportTransform.rotation),
          );
          pageElement.setAttribute(
            "data-nexus-page-viewport-width",
            String(
              pageView?.viewport?.width ??
                viewportTransform.pageWidthPoints * viewportTransform.scale,
            ),
          );
          pageElement.setAttribute(
            "data-nexus-page-viewport-height",
            String(
              pageView?.viewport?.height ??
                viewportTransform.pageHeightPoints * viewportTransform.scale,
            ),
          );
          pageElement.setAttribute(
            "data-nexus-page-dpi-scale",
            String(viewportTransform.dpiScale),
          );
        }
      }
    },
    [getPageElement],
  );

  const removeOverlayLayers = useCallback(() => {
    internalContentRef.current
      ?.querySelectorAll<HTMLElement>('[data-nexus-overlay-layer="true"]')
      .forEach((layer) => layer.remove());
  }, []);

  const rememberPageScale = useCallback(
    (targetPage: number, explicitPageView?: PdfPageViewLike): number => {
      const pageView =
        explicitPageView ??
        pdfViewerRef.current?.getPageView?.(Math.max(0, targetPage - 1));
      const derivedScale = deriveScaleFromPageView(pageView);
      const resolvedScale =
        derivedScale ??
        pageScaleByNumberRef.current.get(targetPage) ??
        zoomRef.current;
      pageScaleByNumberRef.current.set(targetPage, resolvedScale);
      if (targetPage === pageNumberRef.current) {
        activePageScaleRef.current = resolvedScale;
        setPageScale(resolvedScale);
      }
      return resolvedScale;
    },
    [],
  );

  const readPageScale = useCallback(
    (targetPage: number): number => {
      return (
        pageScaleByNumberRef.current.get(targetPage) ??
        rememberPageScale(targetPage)
      );
    },
    [rememberPageScale],
  );

  const isTextLayerUsableForPage = useCallback(
    (targetPage: number): boolean => {
      const textLayerRoot = getTextLayerRootForPage(targetPage);
      if (!textLayerRoot) {
        return false;
      }
      return (textLayerRoot.textContent ?? "").trim().length > 0;
    },
    [getTextLayerRootForPage],
  );

  const evaluatePageGeometryReliability = useCallback(
    (targetPage: number): boolean => {
      const pageElement = getPageElement(targetPage);
      if (!pageElement) {
        return pageGeometryReliabilityRef.current.get(targetPage) ?? true;
      }
      const alignmentDelta = computePageLayerAlignmentDelta(pageElement);
      const isReliable =
        alignmentDelta === null ||
        alignmentDelta <= PDF_GEOMETRY_ALIGNMENT_DELTA_THRESHOLD;
      pageGeometryReliabilityRef.current.set(targetPage, isReliable);
      if (targetPage === pageNumberRef.current) {
        setTextGeometryReliable(isReliable);
      }
      return isReliable;
    },
    [getPageElement],
  );

  const scheduleTextLayerStateRefresh = useCallback(
    (targetPage: number, runId: number) => {
      if (textLayerRefreshFrameRef.current?.frameId != null) {
        window.cancelAnimationFrame(textLayerRefreshFrameRef.current.frameId);
      }
      textLayerRefreshFrameRef.current = {
        pageNumber: targetPage,
        runId,
        frameId: null,
      };
      let attemptsRemaining = PDF_TEXT_LAYER_REFRESH_FRAME_BUDGET;
      const refresh = () => {
        const activeRefresh = textLayerRefreshFrameRef.current;
        if (
          !activeRefresh ||
          activeRefresh.runId !== runId ||
          activeRefresh.pageNumber !== targetPage
        ) {
          return;
        }
        activeRefresh.frameId = null;
        if (runId !== runRef.current || targetPage !== pageNumberRef.current) {
          textLayerRefreshFrameRef.current = null;
          return;
        }
        const usable = isTextLayerUsableForPage(targetPage);
        setTextLayerUsable(usable);
        setTextGeometryReliable(evaluatePageGeometryReliability(targetPage));
        setPageRenderEpoch((value) => value + 1);
        if (usable || attemptsRemaining <= 0) {
          textLayerRefreshFrameRef.current = null;
          return;
        }
        attemptsRemaining -= 1;
        activeRefresh.frameId = window.requestAnimationFrame(refresh);
      };
      textLayerRefreshFrameRef.current.frameId =
        window.requestAnimationFrame(refresh);
    },
    [evaluatePageGeometryReliability, isTextLayerUsableForPage],
  );

  const clearPendingMobileSelectionPublish = useCallback(() => {
    if (mobileSelectionTimerRef.current == null) {
      return;
    }
    window.clearTimeout(mobileSelectionTimerRef.current);
    mobileSelectionTimerRef.current = null;
  }, []);

  const publishSelection = useCallback(
    (nextSelection: SelectionState | null) => {
      selectionVisibleRef.current = nextSelection !== null;
      setSelection(nextSelection);
    },
    [],
  );

  const resetSelectionState = useCallback(
    (keepVisibleCapturedSelection = false) => {
      clearPendingMobileSelectionPublish();
      if (
        keepVisibleCapturedSelection &&
        selectionVisibleRef.current &&
        selectionSnapshotRef.current
      ) {
        return;
      }
      selectionSnapshotRef.current = null;
      selectionSnapshotKeyRef.current = null;
      publishSelection(null);
    },
    [clearPendingMobileSelectionPublish, publishSelection],
  );

  const clearSelection = useCallback(() => {
    resetSelectionState();
    setSelectionError(null);
    getPdfSelection()?.removeAllRanges();
  }, [resetSelectionState]);

  selectionVisibleRef.current = selection !== null;

  useEffect(() => {
    return () => {
      clearPendingMobileSelectionPublish();
    };
  }, [clearPendingMobileSelectionPublish]);

  const applyPdfViewportPage = useCallback(
    (targetPage: number, intent: PdfViewportIntent) => {
      const viewer = pdfViewerRef.current;
      const doc = documentRef.current;
      if (
        !viewer ||
        !doc ||
        !Number.isInteger(targetPage) ||
        targetPage < 1 ||
        targetPage > doc.numPages
      ) {
        throw new Error(`PDF ${intent} target is not renderable`);
      }

      if (targetPage !== pageNumberRef.current) {
        clearSelection();
        setPageHighlights([]);
        onPageHighlightsChangeRef.current?.(targetPage, []);
      }
      pageNumberRef.current = targetPage;
      setPageNumber(targetPage);
      setNavigating(false);
      applyViewerPageNumber(viewer, targetPage, `${intent}/currentPageNumber`);
    },
    [clearSelection],
  );

  const awaitPdfFindFrame = useCallback(
    (signal: AbortSignal): Promise<void> =>
      new Promise((resolve, reject) => {
        const runId = runRef.current;
        const handleAbort = () => {
          window.cancelAnimationFrame(frameId);
          reject(new DOMException("PDF Find was aborted", "AbortError"));
        };
        const frameId = window.requestAnimationFrame(() => {
          signal.removeEventListener("abort", handleAbort);
          if (signal.aborted || runId !== runRef.current) {
            reject(new DOMException("PDF Find was aborted", "AbortError"));
            return;
          }
          resolve();
        });
        signal.addEventListener("abort", handleAbort, { once: true });
      }),
    [],
  );

  const awaitPdfFindTextLayer = useCallback(
    (
      targetPage: number,
      expectedScale: number | null,
      minimumTextLayerRenderEpoch: number,
      requireText: boolean,
      signal: AbortSignal,
    ): Promise<void> =>
      new Promise((resolve, reject) => {
        const runId = runRef.current;
        let frameId: number | null = null;
        let framesRemaining = PDF_FIND_VIEWPORT_FRAME_BUDGET;
        const finish = (result: "Ready" | "Aborted" | "Unavailable") => {
          if (frameId !== null) {
            window.cancelAnimationFrame(frameId);
          }
          signal.removeEventListener("abort", handleAbort);
          if (result === "Ready") {
            resolve();
            return;
          }
          if (result === "Aborted") {
            reject(new DOMException("PDF Find was aborted", "AbortError"));
            return;
          }
          const textLayer = getTextLayerRootForPage(targetPage);
          const currentEpoch =
            textLayerRenderEpochByPageRef.current.get(targetPage) ?? 0;
          const currentScale = readPageScale(targetPage);
          reject(
            new Error(
              `PDF page ${targetPage} did not become renderable ` +
                `(textLayer=${textLayer?.isConnected === true ? "connected" : "missing"}, ` +
                `text=${(textLayer?.textContent ?? "").trim().length > 0 ? "present" : "empty"}, ` +
                `epoch=${currentEpoch}/${minimumTextLayerRenderEpoch}, ` +
                `scale=${currentScale}/${expectedScale ?? "any"})`,
            ),
          );
        };
        const handleAbort = () => finish("Aborted");
        const inspect = () => {
          frameId = null;
          if (signal.aborted || runId !== runRef.current) {
            finish("Aborted");
            return;
          }
          const textLayer = getTextLayerRootForPage(targetPage);
          const scale = readPageScale(targetPage);
          if (
            textLayer?.isConnected &&
            (!requireText ||
              (textLayer.textContent ?? "").trim().length > 0) &&
            (textLayerRenderEpochByPageRef.current.get(targetPage) ?? 0) >=
              minimumTextLayerRenderEpoch &&
            (expectedScale === null ||
              Math.abs(scale - expectedScale) <= PDF_FIND_VIEWPORT_SCALE_EPSILON)
          ) {
            finish("Ready");
            return;
          }
          if (framesRemaining <= 0) {
            finish("Unavailable");
            return;
          }
          framesRemaining -= 1;
          frameId = window.requestAnimationFrame(inspect);
        };

        signal.addEventListener("abort", handleAbort, { once: true });
        frameId = window.requestAnimationFrame(inspect);
      }),
    [getTextLayerRootForPage, readPageScale],
  );

  const capturePdfFindOrigin = useCallback((): PdfFindOriginCapture => {
    const container = viewerContainerRef.current;
    const pageElement = getPageElement(pageNumberRef.current);
    const viewer = pdfViewerRef.current;
    const zoom = viewer ? (readViewerZoom(viewer) ?? zoomRef.current) : null;
    if (
      !container ||
      !pageElement ||
      !documentRef.current ||
      zoom === null
    ) {
      return { kind: "Unavailable" };
    }
    return {
      kind: "Captured",
      value: {
        pageNumber: pageNumberRef.current,
        zoom,
        pageTopDeltaPx:
          pageElement.getBoundingClientRect().top -
          container.getBoundingClientRect().top,
        scrollLeft: container.scrollLeft,
      },
    };
  }, [getPageElement]);

  const revealPdfFindMatch = useCallback(
    (element: HTMLElement): void => {
      const container = viewerContainerRef.current;
      if (!container || !container.contains(element)) {
        throw new Error("PDF Find match is outside the active scroll owner");
      }
      void readerScrollPositioner.run(({ reveal }) => {
        reveal(container, element);
      });
    },
    [readerScrollPositioner],
  );

  const revealPdfFindPage = useCallback(
    async ({
      pageNumber: targetPage,
      signal,
    }: {
      readonly pageNumber: number;
      readonly signal: AbortSignal;
    }) => {
      if (signal.aborted) {
        throw new DOMException("PDF Find was aborted", "AbortError");
      }
      const previousIntent = viewportIntentRef.current;
      viewportIntentGenerationRef.current += 1;
      const intentGeneration = viewportIntentGenerationRef.current;
      viewportIntentRef.current = "FindPreview";
      try {
        await readerScrollPositioner.run(async () => {
          applyPdfViewportPage(targetPage, "FindPreview");
          await awaitPdfFindTextLayer(
            targetPage,
            null,
            textLayerRenderEpochByPageRef.current.get(targetPage) ?? 0,
            true,
            signal,
          );
        });
      } finally {
        window.requestAnimationFrame(() => {
          if (
            viewportIntentGenerationRef.current === intentGeneration &&
            viewportIntentRef.current === "FindPreview"
          ) {
            viewportIntentRef.current = previousIntent;
          }
        });
      }
    },
    [
      applyPdfViewportPage,
      awaitPdfFindTextLayer,
      readerScrollPositioner,
    ],
  );

  const restorePdfFindOrigin = useCallback(
    async (origin: PdfFindOrigin, signal: AbortSignal) => {
      const viewer = pdfViewerRef.current;
      const container = viewerContainerRef.current;
      if (signal.aborted) {
        throw new DOMException("PDF Find was aborted", "AbortError");
      }
      if (
        !viewer ||
        !container ||
        !Number.isFinite(origin.zoom) ||
        origin.zoom <= 0
      ) {
        throw new Error("PDF Find origin is not renderable");
      }

      zoomRef.current = origin.zoom;
      setZoom(origin.zoom);
      const refreshExpiredSourceAccess = (): boolean => {
        const expiryMs = signedUrlExpiryRef.current;
        if (
          typeof expiryMs !== "number" ||
          Date.now() < expiryMs - SIGNED_URL_REFRESH_SKEW_MS
        ) {
          return false;
        }
        const recover = recoverAndRenderRef.current;
        if (!recover) {
          throw new Error("PDF signed URL recovery is unavailable");
        }
        recover(origin.pageNumber, runRef.current);
        return true;
      };
      if (refreshExpiredSourceAccess()) {
        throw pdfFindSourceAccessRefreshAbort();
      }

      const previousIntent = viewportIntentRef.current;
      viewportIntentGenerationRef.current += 1;
      const intentGeneration = viewportIntentGenerationRef.current;
      viewportIntentRef.current = "FindReturn";
      try {
        await readerScrollPositioner.run(async ({ adjustTop }) => {
          const textLayerRenderEpoch =
            textLayerRenderEpochByPageRef.current.get(origin.pageNumber) ?? 0;
          const zoomChanged =
            Math.abs(
              (readViewerZoom(viewer) ?? zoomRef.current) - origin.zoom,
            ) >
            PDF_FIND_VIEWPORT_SCALE_EPSILON;
          pageScaleByNumberRef.current.clear();
          pageGeometryReliabilityRef.current.clear();
          applyViewerScale(
            viewer,
            origin.zoom,
            "FindReturn/currentScaleValue",
          );
          applyPdfViewportPage(origin.pageNumber, "FindReturn");
          await awaitPdfFindTextLayer(
            origin.pageNumber,
            null,
            textLayerRenderEpoch + (zoomChanged ? 1 : 0),
            false,
            signal,
          );
          const restoredZoom = readViewerZoom(viewer);
          if (
            restoredZoom === null ||
            Math.abs(restoredZoom - origin.zoom) >
              PDF_FIND_VIEWPORT_SCALE_EPSILON
          ) {
            throw new Error("PDF Find origin zoom could not be restored");
          }
          await awaitPdfFindFrame(signal);
          const pageElement = getPageElement(origin.pageNumber);
          if (!pageElement) {
            throw new Error("PDF Find origin page is unavailable");
          }
          const currentPageTopDeltaPx =
            pageElement.getBoundingClientRect().top -
            container.getBoundingClientRect().top;
          adjustTop(
            container,
            currentPageTopDeltaPx - origin.pageTopDeltaPx,
          );
          container.scrollLeft = origin.scrollLeft;

          await awaitPdfFindFrame(signal);
          const restoredPageTopDeltaPx =
            pageElement.getBoundingClientRect().top -
            container.getBoundingClientRect().top;
          if (
            pageNumberRef.current !== origin.pageNumber ||
            Math.abs(restoredPageTopDeltaPx - origin.pageTopDeltaPx) >
              PDF_FIND_VIEWPORT_POSITION_EPSILON_PX ||
            Math.abs(container.scrollLeft - origin.scrollLeft) >
              PDF_FIND_VIEWPORT_POSITION_EPSILON_PX
          ) {
            throw new Error("PDF Find origin could not be restored exactly");
          }
          // React effects and browser scroll delivery caused by the page/zoom
          // restoration must settle while FindReturn still fences resume
          // publication. Releasing the preview lease before this tail drains
          // can persist the programmatic viewport as genuine reader movement.
          await awaitPdfFindFrame(signal);
          await awaitPdfFindFrame(signal);
          if (container.isConnected) {
            container.focus({ preventScroll: true });
          }
        });
      } catch (error) {
        if (!signal.aborted && refreshExpiredSourceAccess()) {
          throw pdfFindSourceAccessRefreshAbort();
        }
        throw error;
      } finally {
        if (
          viewportIntentGenerationRef.current === intentGeneration &&
          viewportIntentRef.current === "FindReturn"
        ) {
          viewportIntentRef.current = previousIntent;
        }
      }
    },
    [
      applyPdfViewportPage,
      awaitPdfFindFrame,
      awaitPdfFindTextLayer,
      getPageElement,
      readerScrollPositioner,
    ],
  );

  const openDocument = useCallback(
    async (signedUrl: string): Promise<OpenedPdfDocument> => {
      const pdfJs = await ensurePdfJs();
      const task = pdfJs.getDocument({
        url: signedUrl,
        withCredentials: false,
        disableRange: false,
        disableStream: false,
        disableAutoFetch: true,
      });
      const doc = await task.promise;
      return { doc, loadingTask: task };
    },
    [ensurePdfJs],
  );

  const replaceDocument = useCallback(async (nextOpened: OpenedPdfDocument) => {
    const previousDoc = documentRef.current;
    const previousTask = loadingTaskRef.current;

    documentRef.current = nextOpened.doc;
    loadingTaskRef.current = nextOpened.loadingTask;

    if (previousDoc && previousDoc !== nextOpened.doc) {
      await destroyPdfDocument(previousDoc);
    }
    if (previousTask && previousTask !== nextOpened.loadingTask) {
      destroyPdfLoadingTask(previousTask);
    }
  }, []);

  const teardownViewer = useCallback(
    ({ publishFindUnavailable = true } = {}) => {
    viewportIntentGenerationRef.current += 1;
    viewportIntentRef.current = null;
    if (publishFindUnavailable) {
      onFindRuntimeReadyRef.current?.(null);
    }
    pendingPdfFindRuntimeRef.current = null;
    pdfFindRuntimeRef.current?.setDocument(null);
    pdfFindRuntimeRef.current?.dispose();
    pdfFindRuntimeRef.current = null;
    const eventBus = eventBusRef.current;
    const handlers = eventHandlersRef.current;
    if (eventBus && handlers) {
      eventBus.off("pagechanging", handlers.pagechanging);
      eventBus.off("pagesloaded", handlers.pagesloaded);
      eventBus.off("pagerendered", handlers.pagerendered);
      eventBus.off("textlayerrendered", handlers.textlayerrendered);
      eventBus.off("annotationlayerrendered", handlers.annotationlayerrendered);
    }
    eventHandlersRef.current = null;
    linkServiceRef.current?.setDocument(null, null);
    pdfViewerRef.current?.setDocument(null);
    eventBusRef.current = null;
    linkServiceRef.current = null;
    pdfViewerRef.current = null;
    pendingViewerPageRef.current = null;
    pendingViewerScaleRef.current = null;
    textLayerRenderEpochByPageRef.current.clear();
    publishIntrinsicWidth(null);
    removeOverlayLayers();
    if (internalContentRef.current) {
      internalContentRef.current.innerHTML = "";
    }
    },
    [publishIntrinsicWidth, removeOverlayLayers],
  );

  const initializeViewerIfNeeded = useCallback(
    async (runId: number) => {
      if (
        pdfViewerRef.current &&
        eventBusRef.current &&
        linkServiceRef.current
      ) {
        return;
      }
      const viewerModule = await ensurePdfJsViewer();
      if (runId !== runRef.current) {
        return;
      }

      const container = viewerContainerRef.current;
      const viewerHost = internalContentRef.current;
      if (!container || !viewerHost) {
        throw new Error("PDF viewer container is unavailable");
      }

      const eventBus = new viewerModule.EventBus();
      const linkService = new viewerModule.PDFLinkService({
        eventBus,
        externalLinkTarget:
          viewerModule.LinkTarget?.BLANK ?? PDF_LINK_TARGET_BLANK,
        externalLinkRel: "noopener noreferrer nofollow",
      });
      const pdfFindRuntime = createPdfFindRuntime({
        mediaId,
        viewerModule,
        eventBus,
        revealPage: revealPdfFindPage,
        revealMatch: revealPdfFindMatch,
        captureOrigin: capturePdfFindOrigin,
        restoreOrigin: restorePdfFindOrigin,
      });
      const pdfViewer = new viewerModule.PDFViewer({
        container,
        viewer: viewerHost,
        eventBus,
        linkService,
        findController: pdfFindRuntime.findController,
        textLayerMode: PDF_VIEWER_TEXT_LAYER_MODE_ENABLE,
        enableAutoLinking: false,
      });
      try {
        if (typeof viewerModule.ScrollMode?.VERTICAL === "number") {
          pdfViewer.scrollMode = viewerModule.ScrollMode.VERTICAL;
        }
      } catch {
        // Some viewer shims may not expose scrollMode mutability.
      }
      linkService.setViewer(pdfViewer);
      pdfFindRuntime.setViewer(pdfViewer);

      const handlePageChanging = (rawEvent: unknown) => {
        if (runId !== runRef.current) {
          return;
        }
        const event = rawEvent as { pageNumber?: number };
        const nextPage = Number.isFinite(event.pageNumber)
          ? Math.max(1, Math.floor(event.pageNumber as number))
          : 1;
        const pageChanged = nextPage !== pageNumberRef.current;
        pageNumberRef.current = nextPage;
        setPageNumber(nextPage);
        setNavigating(false);
        if (pageChanged) {
          clearSelection();
          setPageHighlights([]);
          onPageHighlightsChangeRef.current?.(nextPage, []);
        }
        rememberPageScale(nextPage);
        setTextLayerUsable(isTextLayerUsableForPage(nextPage));
        setTextGeometryReliable(evaluatePageGeometryReliability(nextPage));
        setPageRenderEpoch((value) => value + 1);
        scheduleTextLayerStateRefresh(nextPage, runId);
      };

      const handlePagesLoaded = (rawEvent: unknown) => {
        if (runId !== runRef.current) {
          return;
        }
        const event = rawEvent as { pagesCount?: number };
        const pagesCount = isPositiveFinite(event.pagesCount)
          ? Math.floor(event.pagesCount)
          : (documentRef.current?.numPages ?? 0);
        setNumPages(pagesCount);
        const viewer = pdfViewerRef.current;
        const pendingScale = pendingViewerScaleRef.current;
        const pendingPage = pendingViewerPageRef.current;
        if (viewer && pendingScale != null) {
          void readerScrollPositioner.run(() => {
            try {
              applyViewerScale(
                viewer,
                pendingScale,
                "pagesloaded/currentScaleValue",
              );
            } catch (error) {
              setError(toUserFacingError(error));
            } finally {
              pendingViewerScaleRef.current = null;
            }
          });
        }
        if (viewer && typeof pendingPage === "number" && pendingPage > 1) {
          void readerScrollPositioner.run(() => {
            try {
              const boundedPage = Math.max(
                1,
                Math.min(pendingPage, Math.max(pagesCount, 1)),
              );
              applyViewerPageNumber(
                viewer,
                boundedPage,
                "pagesloaded/currentPageNumber",
              );
            } catch (error) {
              setError(toUserFacingError(error));
            } finally {
              pendingViewerPageRef.current = null;
            }
          });
        }
        setTextGeometryReliable(
          evaluatePageGeometryReliability(pageNumberRef.current),
        );
        window.requestAnimationFrame(() => {
          if (runId !== runRef.current) {
            return;
          }
          for (let index = 1; index <= pagesCount; index += 1) {
            markPageSurface(
              index,
              viewer?.getPageView?.(Math.max(0, index - 1)),
            );
          }
          scheduleIntrinsicWidthPublish();
        });
        const findRuntime = pendingPdfFindRuntimeRef.current;
        if (findRuntime) {
          pendingPdfFindRuntimeRef.current = null;
          onFindRuntimeReadyRef.current?.(findRuntime);
        }
      };

      const handlePageRendered = (rawEvent: unknown) => {
        if (runId !== runRef.current) {
          return;
        }
        const event = rawEvent as {
          pageNumber?: number;
          source?: PdfPageViewLike;
          error?: unknown;
        };
        const renderedPage = isPositiveFinite(event.pageNumber)
          ? Math.floor(event.pageNumber)
          : pageNumberRef.current;

        markPageSurface(renderedPage, event.source);
        rememberPageScale(renderedPage, event.source);
        const renderedZoom =
          readViewerZoom(pdfViewer) ?? zoomRef.current;
        if (!event.error) {
          renderedPageZoomByNumberRef.current.set(
            renderedPage,
            renderedZoom,
          );
        }
        scheduleIntrinsicWidthPublish();
        evaluatePageGeometryReliability(renderedPage);

        const signedUrlExpiryRenderError =
          event.error != null &&
          isLikelySignedUrlExpiryError(event.error);
        if (
          signedUrlExpiryRenderError &&
          !recoveringFromRenderErrorRef.current
        ) {
          recoveringFromRenderErrorRef.current = true;
          recoverAndRenderRef.current?.(pageNumberRef.current, runRef.current);
        }

        if (renderedPage === pageNumberRef.current) {
          applyStartPageProgression();
          scheduleTextLayerStateRefresh(renderedPage, runId);
          const positioningTarget =
            readerPositioningRenderTargetRef.current;
          if (
            !signedUrlExpiryRenderError &&
            positioningTarget?.runId === runId &&
            positioningTarget.pageNumber === renderedPage &&
            Math.abs(positioningTarget.zoom - renderedZoom) <=
              PDF_FIND_VIEWPORT_SCALE_EPSILON
          ) {
            settleReaderPositioning();
          }
          if (!signedUrlExpiryRenderError) {
            window.requestAnimationFrame(() => {
              if (runId === runRef.current) {
                setReaderRestoreSettled(true);
              }
            });
          }
        }
      };

      const handleTextLayerRendered = (rawEvent: unknown) => {
        if (runId !== runRef.current) {
          return;
        }
        const event = rawEvent as { pageNumber?: number };
        const renderedPage = isPositiveFinite(event.pageNumber)
          ? Math.floor(event.pageNumber)
          : pageNumberRef.current;
        markPageSurface(renderedPage);
        textLayerRenderEpochByPageRef.current.set(
          renderedPage,
          (textLayerRenderEpochByPageRef.current.get(renderedPage) ?? 0) + 1,
        );
        if (renderedPage === pageNumberRef.current) {
          scheduleTextLayerStateRefresh(renderedPage, runId);
        }
      };

      const handleAnnotationLayerRendered = (rawEvent: unknown) => {
        if (runId !== runRef.current) {
          return;
        }
        const event = rawEvent as { pageNumber?: number; error?: unknown };
        if (!event.error) {
          return;
        }
        const renderedPage = isPositiveFinite(event.pageNumber)
          ? Math.floor(event.pageNumber)
          : pageNumberRef.current;
        const expiryError = isLikelySignedUrlExpiryError(event.error);
        if (expiryError && !recoveringFromRenderErrorRef.current) {
          recoveringFromRenderErrorRef.current = true;
          recoverAndRenderRef.current?.(renderedPage, runRef.current);
          return;
        }
        if (!expiryError) {
          console.error("PDF annotation layer render failed:", event.error);
        }
      };

      eventBus.on("pagechanging", handlePageChanging);
      eventBus.on("pagesloaded", handlePagesLoaded);
      eventBus.on("pagerendered", handlePageRendered);
      eventBus.on("textlayerrendered", handleTextLayerRendered);
      eventBus.on("annotationlayerrendered", handleAnnotationLayerRendered);

      eventBusRef.current = eventBus;
      linkServiceRef.current = linkService;
      pdfViewerRef.current = pdfViewer;
      pdfFindRuntimeRef.current = pdfFindRuntime;
      eventHandlersRef.current = {
        pagechanging: handlePageChanging,
        pagesloaded: handlePagesLoaded,
        pagerendered: handlePageRendered,
        textlayerrendered: handleTextLayerRendered,
        annotationlayerrendered: handleAnnotationLayerRendered,
      };
    },
    [
      applyStartPageProgression,
      capturePdfFindOrigin,
      clearSelection,
      evaluatePageGeometryReliability,
      ensurePdfJsViewer,
      isTextLayerUsableForPage,
      markPageSurface,
      mediaId,
      readerScrollPositioner,
      rememberPageScale,
      restorePdfFindOrigin,
      revealPdfFindMatch,
      revealPdfFindPage,
      scheduleIntrinsicWidthPublish,
      scheduleTextLayerStateRefresh,
      settleReaderPositioning,
    ],
  );

  const attachDocumentToViewer = useCallback(
    async (doc: PdfDocumentLike, targetPage: number, runId: number) => {
      await initializeViewerIfNeeded(runId);
      if (runId !== runRef.current) {
        return;
      }
      const viewer = pdfViewerRef.current;
      const linkService = linkServiceRef.current;
      if (!viewer || !linkService) {
        throw new Error("PDF viewer failed to initialize");
      }

      pageScaleByNumberRef.current.clear();
      textLayerRenderEpochByPageRef.current.clear();
      pageGeometryReliabilityRef.current.clear();
      pendingViewerPageRef.current = null;
      removeOverlayLayers();

      const boundedPage = clamp(targetPage, 1, doc.numPages);
      pageNumberRef.current = boundedPage;
      setPageNumber(boundedPage);
      setNumPages(doc.numPages);
      setTextLayerUsable(false);
      setTextGeometryReliable(true);

      const shouldFitPageWidth =
        isMobileRef.current && !initialMobileFitDoneRef.current;
      if (shouldFitPageWidth) {
        initialMobileFitDoneRef.current = true;
      }
      const effectiveScale: string | number = shouldFitPageWidth
        ? "page-width"
        : zoomRef.current;
      const numericFallback =
        typeof effectiveScale === "number" ? effectiveScale : zoomRef.current;
      setPageScale(numericFallback);
      activePageScaleRef.current = numericFallback;

      pendingViewerScaleRef.current = effectiveScale;
      pendingViewerPageRef.current = boundedPage > 1 ? boundedPage : null;
      linkService.setDocument(doc, null);
      const findRuntime = pdfFindRuntimeRef.current?.setDocument(doc);
      if (!findRuntime) {
        throw new Error("PDF Find runtime failed to bind the document");
      }
      pendingPdfFindRuntimeRef.current = findRuntime;
      viewer.setDocument(doc);
    },
    [initializeViewerIfNeeded, removeOverlayLayers],
  );

  const requestSignedUrlRecovery = useCallback(
    (targetPage: number, runId: number) => {
      if (runId !== runRef.current) {
        return;
      }
      recoveryTargetPageRef.current = targetPage;
      setRecovering(true);
      setError(null);
      setSignedUrlRefreshToken((value) => value + 1);
    },
    [],
  );

  useEffect(() => {
    recoverAndRenderRef.current = requestSignedUrlRecovery;
    return () => {
      recoverAndRenderRef.current = null;
    };
  }, [requestSignedUrlRecovery]);

  const resolveTextLayerRootFromRange = useCallback(
    (
      targetRange: Range,
    ): { textLayerRoot: HTMLElement; pageNumber: number } | null => {
      const contexts = [targetRange.startContainer, targetRange.endContainer]
        .map((node) => {
          const element =
            node.nodeType === Node.ELEMENT_NODE
              ? (node as Element)
              : node.parentElement;
          return element?.closest(".textLayer");
        })
        .filter(
          (element): element is HTMLElement => element instanceof HTMLElement,
        );
      for (const candidate of contexts) {
        if (!isSelectionRangeInTextLayer(targetRange, candidate)) {
          continue;
        }
        const pageNumber = readPageNumberFromTextLayer(candidate);
        if (pageNumber) {
          return { textLayerRoot: candidate, pageNumber };
        }
      }
      const activeLayer = getTextLayerRootForPage(pageNumberRef.current);
      if (isSelectionRangeInTextLayer(targetRange, activeLayer)) {
        const pageNumber = readPageNumberFromTextLayer(activeLayer);
        if (activeLayer && pageNumber) {
          return { textLayerRoot: activeLayer, pageNumber };
        }
      }
      return null;
    },
    [getTextLayerRootForPage],
  );

  const buildSelectionQuads = useCallback(
    (range: Range, targetPage: number): PdfHighlightQuad[] => {
      const layerRect =
        getTextLayerRootForPage(targetPage)?.getBoundingClientRect();
      const pageScaleValue = readPageScale(targetPage);
      if (!layerRect || pageScaleValue <= 0) {
        return [];
      }

      const rectsFromRange = Array.from(range.getClientRects()).filter(
        isValidPdfRect,
      );
      const fallbackRect = range.getBoundingClientRect();
      const rects =
        rectsFromRange.length > 0
          ? rectsFromRange
          : isValidPdfRect(fallbackRect)
            ? [fallbackRect]
            : isValidPdfRect(layerRect)
              ? [layerRect]
              : [];

      return rects.map((rect) =>
        rectToCanonicalQuad(rect, layerRect, pageScaleValue),
      );
    },
    [getTextLayerRootForPage, readPageScale],
  );

  const buildAreaSelectionQuads = useCallback(
    (targetSelection: SelectionState): PdfHighlightQuad[] => {
      const pageElement = getPageElement(targetSelection.pageNumber);
      const pageScaleValue = readPageScale(targetSelection.pageNumber);
      if (!pageElement || pageScaleValue <= 0) {
        return [];
      }

      const pageRect = pageElement.getBoundingClientRect();
      if (!isValidPdfRect(pageRect)) {
        return [];
      }

      const selectedRect = targetSelection.rect;
      const left = Math.max(pageRect.left, selectedRect.left);
      const right = Math.min(pageRect.right, selectedRect.right);
      const top = Math.max(pageRect.top, selectedRect.top);
      const bottom = Math.min(pageRect.bottom, selectedRect.bottom);
      if (!isValidPdfRect({ width: right - left, height: bottom - top })) {
        return [];
      }
      return [
        rectToCanonicalQuad(
          { left, right, top, bottom },
          pageRect,
          pageScaleValue,
        ),
      ];
    },
    [getPageElement, readPageScale],
  );

  const syncSelectionFromWindow = useCallback(() => {
    const sel = getPdfSelection();
    if (!sel || sel.rangeCount === 0) {
      resetSelectionState(true);
      return;
    }
    const selectedTextFromSelection = sel.toString().trim();
    if (sel.isCollapsed && selectedTextFromSelection.length === 0) {
      resetSelectionState(true);
      return;
    }

    const range = sel.getRangeAt(0);
    const selectionContext = resolveTextLayerRootFromRange(range);
    if (!selectionContext) {
      resetSelectionState(true);
      return;
    }

    const selectionText =
      selectedTextFromSelection.length > 0
        ? selectedTextFromSelection
        : range.toString().trim();
    if (selectionText.length === 0) {
      resetSelectionState(true);
      return;
    }

    const snapshot = toSelectionSnapshot(
      range,
      selectionContext.textLayerRoot,
      selectionContext.pageNumber,
    );
    const nextSelectionKey = buildSelectionSnapshotKey(snapshot);
    const previousSelectionKey = selectionSnapshotKeyRef.current;
    selectionSnapshotRef.current = snapshot;
    selectionSnapshotKeyRef.current = nextSelectionKey;
    setSelectionError(null);
    if (!isMobileRef.current) {
      publishSelection(snapshot);
      return;
    }
    if (
      previousSelectionKey === nextSelectionKey &&
      (selectionVisibleRef.current || mobileSelectionTimerRef.current != null)
    ) {
      return;
    }
    clearPendingMobileSelectionPublish();
    publishSelection(null);
    mobileSelectionTimerRef.current = window.setTimeout(() => {
      mobileSelectionTimerRef.current = null;
      if (
        selectionSnapshotKeyRef.current !== nextSelectionKey ||
        selectionSnapshotRef.current == null
      ) {
        return;
      }
      publishSelection(selectionSnapshotRef.current);
    }, MOBILE_SELECTION_STABILIZATION_DELAY_MS);
  }, [
    clearPendingMobileSelectionPublish,
    publishSelection,
    resetSelectionState,
    resolveTextLayerRootFromRange,
  ]);

  const handleCreateHighlight = useCallback(
    async (color: HighlightColor): Promise<PdfHighlightOut | null> => {
      const shouldUseAreaFallback = !textGeometryReliable;
      const fallbackSelection: SelectionState | null = (() => {
        const sel = getPdfSelection();
        if (
          !sel ||
          sel.rangeCount === 0 ||
          sel.toString().trim().length === 0
        ) {
          return null;
        }
        const range = sel.getRangeAt(0);
        const selectionContext = resolveTextLayerRootFromRange(range);
        if (!selectionContext) {
          return null;
        }
        return toSelectionSnapshot(
          range,
          selectionContext.textLayerRoot,
          selectionContext.pageNumber,
        );
      })();

      const activeSelection =
        selection ?? selectionSnapshotRef.current ?? fallbackSelection;
      if (
        !(textLayerUsable || shouldUseAreaFallback || activeSelection) ||
        highlightCreationInFlightRef.current
      ) {
        return null;
      }

      if (!activeSelection) {
        return null;
      }

      const exact = shouldUseAreaFallback
        ? ""
        : activeSelection.range.toString().trim();
      const quads = shouldUseAreaFallback
        ? buildAreaSelectionQuads(activeSelection)
        : buildSelectionQuads(
            activeSelection.range,
            activeSelection.pageNumber,
          );
      if (quads.length === 0) {
        setSelectionError(
          shouldUseAreaFallback
            ? "No selectable area geometry was found for this selection."
            : "No selectable text geometry was found for this selection.",
        );
        clearSelection();
        return null;
      }

      highlightCreationInFlightRef.current = true;
      setIsCreating(true);
      setSelectionError(null);
      try {
        let createdHighlight: PdfHighlightOut | null = null;
        if (editingHighlightId) {
          await apiFetch(`/api/highlights/${editingHighlightId}`, {
            method: "PATCH",
            body: JSON.stringify({
              exact,
              anchor: {
                type: "pdf_page_geometry",
                page_number: activeSelection.pageNumber,
                quads,
              },
            }),
          });
          const existingHighlight = pageHighlights.find(
            (highlight) => highlight.id === editingHighlightId,
          );
          createdHighlight = existingHighlight
            ? {
                ...existingHighlight,
                exact,
                anchor: {
                  type: "pdf_page_geometry",
                  media_id: mediaId,
                  page_number: activeSelection.pageNumber,
                  quads,
                },
              }
            : null;
        } else {
          const response = await apiFetch<PdfHighlightCreateResponse>(
            `/api/media/${mediaId}/pdf-highlights`,
            {
              method: "POST",
              body: JSON.stringify({
                page_number: activeSelection.pageNumber,
                quads,
                exact,
                color,
              }),
            },
          );
          createdHighlight = response.data;
        }

        setLocalHighlightRefreshToken((value) => value + 1);
        onHighlightsMutated?.();
        clearSelection();
        return createdHighlight;
      } catch (err) {
        if (handleUnauthenticatedApiError(err)) return null;
        setSelectionError(toUserFacingError(err));
        return null;
      } finally {
        highlightCreationInFlightRef.current = false;
        setIsCreating(false);
      }
    },
    [
      buildAreaSelectionQuads,
      buildSelectionQuads,
      clearSelection,
      editingHighlightId,
      mediaId,
      pageHighlights,
      resolveTextLayerRootFromRange,
      selection,
      textGeometryReliable,
      textLayerUsable,
      onHighlightsMutated,
    ],
  );

  // Note verb (selection popover button + bare-`n` chord): snapshot the quote
  // and anchor, then raise the session synchronously in the gesture while the
  // highlight create runs concurrently (handleCreateHighlight reads the live
  // selection and clears it itself).
  const handleAddNote = useCallback(() => {
    if (!selection || highlightCreationInFlightRef.current) return;
    onAddNote?.({
      quote: selection.range.toString().trim(),
      anchorRect: selection.rect,
      creation: handleCreateHighlight(DEFAULT_COLOR),
    });
  }, [handleCreateHighlight, onAddNote, selection]);

  // Link verb over a fresh selection: compute the true page-space quads/quote
  // WITHOUT persisting a Highlight (invariant 6); the Link service materializes
  // the source Highlight on confirmation. Gated on reliable text geometry, like
  // note/quote, so `exact` carries real quote identity.
  const handleLink = useCallback(() => {
    const activeSelection = selection ?? selectionSnapshotRef.current;
    if (!activeSelection) return;
    const exact = activeSelection.range.toString().trim();
    const quads = buildSelectionQuads(
      activeSelection.range,
      activeSelection.pageNumber,
    );
    if (quads.length === 0) {
      setSelectionError(
        "No selectable text geometry was found for this selection.",
      );
      clearSelection();
      return;
    }
    onLink?.({ pageNumber: activeSelection.pageNumber, quads, exact });
  }, [buildSelectionQuads, clearSelection, onLink, selection]);

  useHighlightNoteChord({
    enabled: Boolean(onAddNote && selection && textGeometryReliable),
    onTrigger: handleAddNote,
  });

  const goToPage = useCallback(
    async (nextPage: number) => {
      const viewer = pdfViewerRef.current;
      if (!viewer || nextPage < 1 || nextPage > numPages) {
        return;
      }

      const expectedZoom = readViewerZoom(viewer) ?? zoomRef.current;
      let waitsForRender = false;
      setNavigating(true);
      clearSelection();
      setPageHighlights([]);
      onPageHighlightsChangeRef.current?.(nextPage, []);
      pageNumberRef.current = nextPage;
      setPageNumber(nextPage);
      publishCurrentResumeLocator(nextPage, zoomRef.current);

      const currentRun = runRef.current;
      try {
        const expiryMs = signedUrlExpiryRef.current;
        if (
          typeof expiryMs === "number" &&
          Date.now() >= expiryMs - SIGNED_URL_REFRESH_SKEW_MS
        ) {
          waitsForRender = waitForReaderPositioningRender(
            nextPage,
            expectedZoom,
          );
          requestSignedUrlRecovery(nextPage, currentRun);
          return;
        }
        if (!pageHasRenderedAtZoom(nextPage, expectedZoom)) {
          waitsForRender = waitForReaderPositioningRender(
            nextPage,
            expectedZoom,
          );
        } else {
          beginReaderPositioning();
        }
        applyViewerPageNumber(viewer, nextPage, "goToPage/currentPageNumber");
      } catch (err) {
        if (isLikelySignedUrlExpiryError(err)) {
          waitsForRender = waitForReaderPositioningRender(
            nextPage,
            expectedZoom,
          );
          requestSignedUrlRecovery(nextPage, currentRun);
        } else {
          waitsForRender = false;
          setError(toUserFacingError(err));
        }
      } finally {
        if (currentRun === runRef.current) {
          window.setTimeout(() => setNavigating(false), 0);
        }
        if (!waitsForRender) {
          settleReaderPositioning();
        }
      }
    },
    [
      beginReaderPositioning,
      clearSelection,
      numPages,
      pageHasRenderedAtZoom,
      publishCurrentResumeLocator,
      requestSignedUrlRecovery,
      settleReaderPositioning,
      waitForReaderPositioningRender,
    ],
  );

  const scrollToProjectedHighlight = useCallback(
    (targetPage: number, quads: PdfHighlightQuad[]): boolean => {
      if (quads.length === 0) {
        return false;
      }
      const container = viewerContainerRef.current;
      const pageElement = getPageElement(targetPage);
      if (!container || !pageElement) {
        return false;
      }
      const pageScaleValue = readPageScale(targetPage);
      if (pageScaleValue <= 0) {
        return false;
      }
      const pageView = pdfViewerRef.current?.getPageView?.(
        Math.max(0, targetPage - 1),
      );
      const viewportTransform = deriveViewportTransformFromPageView(
        pageView,
        pageScaleValue,
      ) ?? {
        scale: pageScaleValue,
        rotation: 0 as const,
        pageWidthPoints: 0,
        pageHeightPoints: 0,
        dpiScale: 1,
      };
      const projectedRect = projectPdfQuadToViewportRect(
        quads[0],
        viewportTransform,
      );
      const targetTop =
        pageElement.offsetTop +
        projectedRect.top +
        projectedRect.height / 2 -
        container.clientHeight * PDF_HIGHLIGHT_SCROLL_TARGET_FRACTION;
      let positioned = false;
      void readerScrollPositioner.run(({ setTop }) => {
        setTop(container, targetTop);
        positioned = true;
      });
      return positioned;
    },
    [getPageElement, readPageScale, readerScrollPositioner],
  );

  usePdfScrollToTarget({
    target: useMemo(
      () =>
        navigateToHighlight
          ? {
              key: `${navigateToHighlight.highlightId}:${navigateToHighlight.pageNumber}`,
              pageNumber: navigateToHighlight.pageNumber,
              quads: navigateToHighlight.quads,
            }
          : null,
      [navigateToHighlight],
    ),
    ready: readerRestoreSettled,
    runRef,
    pageNumberRef,
    goToPage,
    scrollToProjectedHighlight,
    onSettle: onHighlightNavigationComplete,
  });

  usePdfScrollToTarget({
    target: useMemo(
      () =>
        temporaryHighlight
          ? {
              key: `${temporaryHighlight.id}:${temporaryHighlight.pageNumber}`,
              pageNumber: temporaryHighlight.pageNumber,
              quads: temporaryHighlight.quads,
            }
          : null,
      [temporaryHighlight],
    ),
    ready: readerRestoreSettled,
    runRef,
    pageNumberRef,
    goToPage,
    scrollToProjectedHighlight,
  });

  const pulseHighlightOverlay = useCallback(
    (target: PdfPulseNavigationTarget) => {
      if (pulseTimerRef.current != null) {
        window.clearTimeout(pulseTimerRef.current);
      }

      const pulseId = target.highlightId ?? target.transientPulseId;
      if (!pulseId) {
        return;
      }

      if (target.transientPulseId) {
        setTransientPulseHighlight({
          id: target.transientPulseId,
          pageNumber: target.pageNumber,
          quads: target.quads,
        });
      }
      setPulsingHighlightId(pulseId);
      pulseTimerRef.current = window.setTimeout(() => {
        pulseTimerRef.current = null;
        setPulsingHighlightId((current) =>
          current === pulseId ? null : current,
        );
        if (target.transientPulseId) {
          setTransientPulseHighlight((current) =>
            current?.id === target.transientPulseId ? null : current,
          );
        }
      }, PDF_PULSE_DURATION_MS);
    },
    [],
  );

  usePdfScrollToTarget({
    target: useMemo(
      () =>
        pulseNavigationTarget
          ? {
              key: pulseNavigationTarget.key,
              pageNumber: pulseNavigationTarget.pageNumber,
              quads: pulseNavigationTarget.quads,
            }
          : null,
      [pulseNavigationTarget],
    ),
    ready: readerRestoreSettled,
    runRef,
    pageNumberRef,
    goToPage,
    scrollToProjectedHighlight,
    onSettle: useCallback(() => {
      if (!pulseNavigationTarget) {
        return;
      }
      pulseHighlightOverlay(pulseNavigationTarget);
      setPulseNavigationTarget((current) =>
        current?.key === pulseNavigationTarget.key ? null : current,
      );
    }, [pulseHighlightOverlay, pulseNavigationTarget]),
  });

  useReaderPulseHighlight(
    useCallback(
      (target) => {
        if (target.mediaId !== mediaId) return;
        const locator = target.locator;
        if (locator.type !== "pdf_page_geometry") return;
        const pageNumber = locator.page_number;
        const quads = locator.quads as PdfHighlightQuad[];
        const highlightId =
          typeof target.highlightId === "string" ? target.highlightId : null;
        pulseSequenceRef.current += 1;
        const sequence = pulseSequenceRef.current;
        const pulseTarget: PdfPulseNavigationTarget = {
          key: `${highlightId ?? "transient"}:${pageNumber}:${sequence}`,
          pageNumber,
          quads,
          highlightId,
          transientPulseId: highlightId ? null : `reader-pulse-${sequence}`,
        };
        if (quads.length > 0) {
          setPulseNavigationTarget(pulseTarget);
          return;
        }
        const navigate = async () => {
          if (pageNumber !== pageNumberRef.current) {
            await goToPage(pageNumber);
          }
          window.requestAnimationFrame(() =>
            pulseHighlightOverlay(pulseTarget),
          );
        };
        void navigate();
      },
      [goToPage, mediaId, pulseHighlightOverlay],
    ),
  );

  useEffect(() => {
    zoomRef.current = zoom;
    const viewer = pdfViewerRef.current;
    if (!viewer) {
      return;
    }
    void readerScrollPositioner.run(() => {
      pageScaleByNumberRef.current.clear();
      pageGeometryReliabilityRef.current.clear();
      if (viewer.pagesCount > 0) {
        try {
          applyViewerScale(viewer, zoom, "zoomEffect/currentScaleValue");
        } catch (error) {
          setError(toUserFacingError(error));
          return;
        }
      } else {
        pendingViewerScaleRef.current = zoom;
      }
      activePageScaleRef.current = zoom;
      setPageScale(zoom);
      setPageRenderEpoch((value) => value + 1);
      window.requestAnimationFrame(() => {
        setTextGeometryReliable(
          evaluatePageGeometryReliability(pageNumberRef.current),
        );
        scheduleIntrinsicWidthPublish();
      });
    });
  }, [
    evaluatePageGeometryReliability,
    readerScrollPositioner,
    scheduleIntrinsicWidthPublish,
    zoom,
  ]);

  useEffect(() => {
    settleReaderPositioning();
    runRef.current += 1;
    const pageScaleCache = pageScaleByNumberRef.current;
    const renderedPageZooms = renderedPageZoomByNumberRef.current;
    const textLayerRenderEpochs = textLayerRenderEpochByPageRef.current;
    const pageGeometryReliability = pageGeometryReliabilityRef.current;

    const startPage = startPageNumberRef.current ?? 1;
    const startPageProgress = startPageProgressionRef.current ?? null;
    const startZoomLevel = startZoomRef.current ?? 1;
    setLoading(true);
    setNavigating(false);
    setRecovering(false);
    setError(null);
    setPageNumber(startPage);
    setNumPages(0);
    setZoom(startZoomLevel);
    setPageScale(startZoomLevel);
    setPageRenderEpoch(0);
    setReaderRestoreSettled(false);
    setSelection(null);
    setSelectionError(null);
    setPageHighlights([]);
    setTextLayerUsable(false);
    setTextGeometryReliable(true);
    pageNumberRef.current = startPage;
    zoomRef.current = startZoomLevel;
    pendingStartPageProgressionRef.current = startPageProgress;
    pageScaleCache.clear();
    renderedPageZooms.clear();
    textLayerRenderEpochs.clear();
    pageGeometryReliability.clear();
    pendingViewerPageRef.current = null;
    pendingViewerScaleRef.current = null;
    signedUrlExpiryRef.current = null;
    recoveringFromRenderErrorRef.current = false;
    initialMobileFitDoneRef.current = false;
    recoveryTargetPageRef.current = null;
    teardownViewer();

    return () => {
      runRef.current += 1;
      signedUrlExpiryRef.current = null;
      pageScaleCache.clear();
      renderedPageZooms.clear();
      textLayerRenderEpochs.clear();
      pageGeometryReliability.clear();
      pendingViewerPageRef.current = null;
      pendingViewerScaleRef.current = null;
      recoveringFromRenderErrorRef.current = false;
      initialMobileFitDoneRef.current = false;
      recoveryTargetPageRef.current = null;
      clearSelection();
      teardownViewer();
      const existingDoc = documentRef.current;
      const existingTask = loadingTaskRef.current;
      documentRef.current = null;
      loadingTaskRef.current = null;
      void destroyPdfDocument(existingDoc);
      destroyPdfLoadingTask(existingTask);
    };
  }, [
    clearSelection,
    mediaId,
    settleReaderPositioning,
    teardownViewer,
  ]);

  useEffect(() => {
    if (
      signedUrlResource.status === "idle" ||
      signedUrlResource.status === "loading"
    ) {
      return;
    }

    const runId = runRef.current;
    const targetPage =
      recoveryTargetPageRef.current ?? startPageNumberRef.current ?? 1;
    let active = true;

    if (signedUrlResource.status === "error") {
      setError(toUserFacingError(signedUrlResource.error));
      setLoading(false);
      setRecovering(false);
      recoveringFromRenderErrorRef.current = false;
      recoveryTargetPageRef.current = null;
      return;
    }

    const bootstrap = async () => {
      try {
        const opened = await openDocument(signedUrlResource.data.url);
        if (!active || runId !== runRef.current) {
          await destroyPdfDocument(opened.doc);
          destroyPdfLoadingTask(opened.loadingTask);
          return;
        }
        signedUrlExpiryRef.current = signedUrlResource.data.expiresAtMs;
        const refreshesExistingSource =
          recoveryTargetPageRef.current !== null &&
          pdfFindRuntimeRef.current !== null;
        teardownViewer({
          publishFindUnavailable: !refreshesExistingSource,
        });
        await replaceDocument(opened);
        await attachDocumentToViewer(opened.doc, targetPage, runId);
        if (active && runId === runRef.current) {
          setError(null);
        }
      } catch (err) {
        if (active && runId === runRef.current) {
          onFindRuntimeReadyRef.current?.(null);
          setError(toUserFacingError(err));
        }
      } finally {
        if (active && runId === runRef.current) {
          setLoading(false);
          setRecovering(false);
          recoveringFromRenderErrorRef.current = false;
          recoveryTargetPageRef.current = null;
        }
      }
    };
    void bootstrap();

    return () => {
      active = false;
    };
  }, [
    attachDocumentToViewer,
    openDocument,
    replaceDocument,
    signedUrlResource,
    teardownViewer,
  ]);

  useEffect(() => {
    if (
      pageHighlightsResource.status === "idle" ||
      pageHighlightsResource.status === "loading"
    ) {
      return;
    }
    if (pageHighlightsResource.status === "error") {
      setSelectionError("Failed to load PDF highlights for this page.");
      return;
    }
    setPageHighlights(pageHighlightsResource.data);
    onPageHighlightsChangeRef.current?.(
      pageNumber,
      pageHighlightsResource.data,
    );
  }, [pageHighlightsResource, pageNumber]);

  useEffect(() => {
    document.addEventListener("selectionchange", syncSelectionFromWindow);
    return () => {
      document.removeEventListener("selectionchange", syncSelectionFromWindow);
    };
  }, [syncSelectionFromWindow]);

  const refreshRetainedSelectionGeometry = useCallback(() => {
    const retainedSelection = selectionSnapshotRef.current;
    if (!retainedSelection) return;
    let selectionContext: ReturnType<typeof resolveTextLayerRootFromRange> = null;
    try {
      selectionContext = resolveTextLayerRootFromRange(retainedSelection.range);
    } catch {
      selectionContext = null;
    }
    const refreshedSelection =
      selectionContext?.pageNumber === retainedSelection.pageNumber
        ? refreshPdfSelectionSnapshot(retainedSelection)
        : null;
    if (!refreshedSelection) {
      clearSelection();
      return;
    }
    selectionSnapshotRef.current = refreshedSelection;
    selectionSnapshotKeyRef.current =
      buildSelectionSnapshotKey(refreshedSelection);
    if (selectionVisibleRef.current) {
      publishSelection(refreshedSelection);
    }
  }, [clearSelection, publishSelection, resolveTextLayerRootFromRange]);

  useEffect(() => {
    let active = true;
    let refreshFrame = 0;
    const scheduleRefresh = () => {
      if (!active || refreshFrame !== 0) return;
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = 0;
        if (active) refreshRetainedSelectionGeometry();
      });
    };
    const viewport = viewerContainerRef.current;
    const content = internalContentRef.current;
    const visualViewport = window.visualViewport;
    const resizeObserver = new ResizeObserver(scheduleRefresh);
    if (viewport) resizeObserver.observe(viewport);
    if (content && content !== viewport) resizeObserver.observe(content);
    viewport?.addEventListener("scroll", scheduleRefresh, { passive: true });
    window.addEventListener("resize", scheduleRefresh, { passive: true });
    window.addEventListener("scroll", scheduleRefresh, true);
    visualViewport?.addEventListener?.("resize", scheduleRefresh);
    visualViewport?.addEventListener?.("scroll", scheduleRefresh);
    scheduleRefresh();
    return () => {
      active = false;
      resizeObserver.disconnect();
      if (refreshFrame !== 0) window.cancelAnimationFrame(refreshFrame);
      viewport?.removeEventListener("scroll", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
      window.removeEventListener("scroll", scheduleRefresh, true);
      visualViewport?.removeEventListener?.("resize", scheduleRefresh);
      visualViewport?.removeEventListener?.("scroll", scheduleRefresh);
    };
  }, [pageRenderEpoch, pageScale, refreshRetainedSelectionGeometry, zoom]);

  // justify-polling: browser PDF text-layer selection events can miss active
  // selections, so this bounded UI poll runs only while a text layer is usable.
  useIntervalPoll({
    enabled: textLayerUsable,
    onPoll: () => {
      const sel = getPdfSelection();
      if (!sel || sel.toString().trim().length === 0) return;
      syncSelectionFromWindow();
    },
    pollIntervalMs: PDF_SELECTION_POLL_INTERVAL_MS,
  });

  const projectedHighlightRects = useMemo(() => {
    const activeScale = pageScale <= 0 ? activePageScaleRef.current : pageScale;
    if (activeScale <= 0) {
      return [] as ProjectedHighlightRect[];
    }
    const pageView = pdfViewerRef.current?.getPageView?.(
      Math.max(0, pageNumber - 1),
    );
    const viewportTransform = deriveViewportTransformFromPageView(
      pageView,
      activeScale,
    ) ?? {
      scale: activeScale,
      rotation: 0 as const,
      pageWidthPoints: 0,
      pageHeightPoints: 0,
      dpiScale: 1,
    };
    const projected: ProjectedHighlightRect[] = [];
    for (const highlight of pageHighlights) {
      if (
        highlight.anchor.type !== "pdf_page_geometry" ||
        highlight.anchor.page_number !== pageNumber
      ) {
        continue;
      }
      highlight.anchor.quads.forEach((quad, index) => {
        projected.push({
          highlightId: highlight.id,
          color: highlight.color,
          index,
          isTemporary: false,
          ...projectPdfQuadToViewportRect(quad, viewportTransform),
        });
      });
    }
    if (temporaryHighlight?.pageNumber === pageNumber) {
      temporaryHighlight.quads.forEach((quad, index) => {
        projected.push({
          highlightId: temporaryHighlight.id,
          color: temporaryHighlight.color,
          index,
          isTemporary: true,
          ...projectPdfQuadToViewportRect(quad, viewportTransform),
        });
      });
    }
    if (transientPulseHighlight?.pageNumber === pageNumber) {
      transientPulseHighlight.quads.forEach((quad, index) => {
        projected.push({
          highlightId: transientPulseHighlight.id,
          color: "yellow",
          index,
          isTemporary: true,
          ...projectPdfQuadToViewportRect(quad, viewportTransform),
        });
      });
    }
    return projected;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: pageRenderEpoch is an intentional invalidation trigger
  }, [
    pageHighlights,
    pageNumber,
    pageRenderEpoch,
    pageScale,
    temporaryHighlight,
    transientPulseHighlight,
  ]);

  useEffect(() => {
    removeOverlayLayers();
    if (projectedHighlightRects.length === 0) {
      return;
    }
    const pageElement = getPageElement(pageNumber);
    if (!pageElement) {
      return;
    }
    const overlayLayer = document.createElement("div");
    overlayLayer.className = styles.overlayLayer;
    overlayLayer.setAttribute("data-nexus-overlay-layer", "true");

    for (const rect of projectedHighlightRects) {
      const rectEl = document.createElement("div");
      rectEl.className = styles.highlightOverlayRect;
      if (rect.isTemporary) {
        rectEl.classList.add(styles.temporaryHighlightOverlayRect);
      }
      if (focusedHighlightId === rect.highlightId) {
        rectEl.classList.add(styles.highlightOverlayRectFocused);
      }
      if (hoveredHighlightId === rect.highlightId) {
        rectEl.classList.add(styles.highlightOverlayRectHovered);
      }
      if (pulsingHighlightId === rect.highlightId) {
        rectEl.classList.add(styles.pulsing);
      }
      rectEl.setAttribute(
        "data-testid",
        `pdf-highlight-${rect.highlightId}-${rect.index}`,
      );
      rectEl.setAttribute("data-highlight-color", rect.color);
      rectEl.setAttribute("data-highlight-id", rect.highlightId);
      rectEl.setAttribute("data-reader-tap-handled", "true");
      if (rect.index === 0) {
        rectEl.setAttribute("data-highlight-anchor", rect.highlightId);
      }
      rectEl.style.left = `${rect.left}px`;
      rectEl.style.top = `${rect.top}px`;
      rectEl.style.width = `${rect.width}px`;
      rectEl.style.height = `${rect.height}px`;
      rectEl.style.backgroundColor = OVERLAY_COLOR_MAP[rect.color];
      rectEl.style.mixBlendMode = "multiply";
      if (
        (hasHighlightTapHandler || hasHighlightHoverHandler) &&
        !rect.isTemporary
      ) {
        rectEl.style.pointerEvents = "auto";
      }
      if (hasHighlightHoverHandler && !rect.isTemporary) {
        rectEl.addEventListener("pointerenter", () => {
          onHighlightHoverRef.current?.(rect.highlightId);
        });
        rectEl.addEventListener("pointerleave", (event) => {
          const relatedHighlightId =
            event.relatedTarget instanceof HTMLElement
              ? event.relatedTarget.dataset.highlightId
              : null;
          const focusedHighlightId =
            document.activeElement instanceof HTMLElement
              ? document.activeElement.dataset.highlightId
              : null;
          if (
            relatedHighlightId !== rect.highlightId &&
            focusedHighlightId !== rect.highlightId
          ) {
            onHighlightHoverRef.current?.(null);
          }
        });
        rectEl.addEventListener("focus", () => {
          onHighlightHoverRef.current?.(rect.highlightId);
        });
        rectEl.addEventListener("blur", (event) => {
          const relatedHighlightId =
            event.relatedTarget instanceof HTMLElement
              ? event.relatedTarget.dataset.highlightId
              : null;
          if (
            relatedHighlightId !== rect.highlightId &&
            !rectEl.matches(":hover")
          ) {
            onHighlightHoverRef.current?.(null);
          }
        });
      }
      if (hasHighlightTapHandler && !rect.isTemporary) {
        rectEl.setAttribute("role", "button");
        rectEl.setAttribute("tabindex", "0");
        rectEl.setAttribute("aria-label", `Open highlight ${rect.highlightId}`);
        rectEl.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          onHighlightTapRef.current?.(
            rect.highlightId,
            rectEl.getBoundingClientRect(),
          );
        });
        rectEl.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          onHighlightTapRef.current?.(
            rect.highlightId,
            rectEl.getBoundingClientRect(),
          );
        });
      }
      overlayLayer.append(rectEl);
    }
    pageElement.append(overlayLayer);
  }, [
    focusedHighlightId,
    getPageElement,
    hasHighlightHoverHandler,
    hasHighlightTapHandler,
    pageNumber,
    projectedHighlightRects,
    hoveredHighlightId,
    pulsingHighlightId,
    removeOverlayLayers,
  ]);

  const showBusy = loading || navigating || recovering;
  const zoomPercent = Math.round(zoom * 100);
  const canZoomIn = zoom < MAX_ZOOM - 0.001;
  const canZoomOut = zoom > MIN_ZOOM + 0.001;
  const canGoPrev = pageNumber > 1;
  const canGoNext = pageNumber < numPages;
  const goToPreviousPage = useCallback(() => {
    void goToPage(pageNumberRef.current - 1);
  }, [goToPage]);
  const goToNextPage = useCallback(() => {
    void goToPage(pageNumberRef.current + 1);
  }, [goToPage]);
  const zoomOut = useCallback(() => {
    if (!pdfViewerRef.current) {
      return;
    }
    const nextZoom = clamp(
      zoomRef.current - ZOOM_STEP,
      MIN_ZOOM,
      MAX_ZOOM,
    );
    if (Math.abs(nextZoom - zoomRef.current) <= 0.001) {
      return;
    }
    waitForReaderPositioningRender(pageNumberRef.current, nextZoom);
    zoomRef.current = nextZoom;
    publishCurrentResumeLocator(pageNumberRef.current, nextZoom);
    setZoom(nextZoom);
  }, [publishCurrentResumeLocator, waitForReaderPositioningRender]);
  const zoomIn = useCallback(() => {
    if (!pdfViewerRef.current) {
      return;
    }
    const nextZoom = clamp(
      zoomRef.current + ZOOM_STEP,
      MIN_ZOOM,
      MAX_ZOOM,
    );
    if (Math.abs(nextZoom - zoomRef.current) <= 0.001) {
      return;
    }
    waitForReaderPositioningRender(pageNumberRef.current, nextZoom);
    zoomRef.current = nextZoom;
    publishCurrentResumeLocator(pageNumberRef.current, nextZoom);
    setZoom(nextZoom);
  }, [publishCurrentResumeLocator, waitForReaderPositioningRender]);

  const applyResumeState = useCallback(
    (resume: PdfReaderResumeState): boolean => {
      if (!pdfViewerRef.current || numPages <= 0) {
        return false;
      }
      const nextZoom =
        resume.zoom !== null ? clamp(resume.zoom, MIN_ZOOM, MAX_ZOOM) : null;
      const zoomChanged =
        nextZoom !== null && Math.abs(nextZoom - zoomRef.current) > 0.001;
      const boundedPage = clamp(resume.page, 1, numPages);
      const pageChanged = boundedPage !== pageNumberRef.current;
      if (
        !zoomChanged &&
        !pageChanged &&
        resume.page_progression === null
      ) {
        return true;
      }

      const expectedZoom =
        zoomChanged && nextZoom !== null
          ? nextZoom
          : (readViewerZoom(pdfViewerRef.current) ?? zoomRef.current);
      let waitsForRender = false;
      if (
        zoomChanged ||
        (pageChanged &&
          !pageHasRenderedAtZoom(boundedPage, expectedZoom))
      ) {
        waitsForRender = waitForReaderPositioningRender(
          boundedPage,
          expectedZoom,
        );
      } else {
        beginReaderPositioning();
      }

      pendingStartPageProgressionRef.current = resume.page_progression;
      if (zoomChanged) {
        zoomRef.current = nextZoom;
        setZoom(nextZoom);
      }
      if (pageChanged) {
        try {
          applyPdfViewportPage(boundedPage, "ReaderRestore");
        } catch (error) {
          setError(toUserFacingError(error));
          settleReaderPositioning();
          return false;
        }
        if (!waitsForRender) {
          applyStartPageProgression();
        }
      } else if (!zoomChanged) {
        // Nothing re-renders, so the pending progression must apply now.
        applyStartPageProgression();
      }
      if (!waitsForRender) {
        settleReaderPositioning();
      }
      return true;
    },
    [
      applyPdfViewportPage,
      applyStartPageProgression,
      beginReaderPositioning,
      numPages,
      pageHasRenderedAtZoom,
      settleReaderPositioning,
      waitForReaderPositioningRender,
    ],
  );

  const captureResumeState = useCallback((): PdfReaderResumeState | null => {
    if (numPages <= 0) {
      return null;
    }
    return {
      kind: "pdf",
      position: pageNumberRef.current,
      page: pageNumberRef.current,
      page_progression: readCurrentPageProgression(),
      zoom: zoomRef.current,
    };
  }, [numPages, readCurrentPageProgression]);

  useEffect(() => {
    if (!onControlsReady) {
      return;
    }
    onControlsReady({
      goToPreviousPage,
      goToNextPage,
      zoomIn,
      zoomOut,
      applyResumeState,
      captureResumeState,
    });
    return () => {
      onControlsReady(null);
    };
  }, [
    applyResumeState,
    captureResumeState,
    goToNextPage,
    goToPreviousPage,
    onControlsReady,
    zoomIn,
    zoomOut,
  ]);

  useEffect(() => {
    if (!onControlsStateChange) {
      return;
    }

    onControlsStateChange({
      pageNumber,
      numPages,
      zoomPercent,
      canGoPrev: canGoPrev && !showBusy,
      canGoNext: canGoNext && !showBusy,
      canZoomIn: canZoomIn && !showBusy,
      canZoomOut: canZoomOut && !showBusy,
      pageRenderEpoch,
      isBusy: showBusy,
    });
  }, [
    canGoNext,
    canGoPrev,
    canZoomIn,
    canZoomOut,
    numPages,
    onControlsStateChange,
    pageRenderEpoch,
    pageNumber,
    showBusy,
    zoomPercent,
  ]);

  const selectionPopoverProps =
    selection && viewerContainerRef.current
      ? {
          selectionRect: selection.rect,
          selectionLineRects: selection.lineRects,
          containerRef: viewerContainerRef,
          onCreateHighlight: handleCreateHighlight,
          onLearn:
            onLearn && textGeometryReliable
              ? (highlight: PdfHighlightOut) =>
                  onLearn(highlight.id, highlight)
              : undefined,
          onAddNote:
            onAddNote && textGeometryReliable ? handleAddNote : undefined,
          onLink: onLink && textGeometryReliable ? handleLink : undefined,
          onDismiss: clearSelection,
          isCreating,
        }
      : null;
  return (
    <div className={styles.viewer}>
      {recovering && (
        <div className={`${styles.notice} ${styles.mobileTopState}`}>
          Refreshing secure file access…
        </div>
      )}

      {error ? (
        <div
          className={`${styles.error} ${styles.mobileTopState}`}
          role="alert"
        >
          {error}
        </div>
      ) : (
        <div className={styles.canvasWrap}>
          <p
            className={styles.srOnly}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            Page {pageNumber} of {numPages}
          </p>
          {(loading || navigating) && (
            <div className={styles.loading} role="status">
              Loading PDF…
            </div>
          )}
          <div className={styles.pdfViewport} data-testid="pdf-viewport">
            <div
              className={styles.viewerA11yMarker}
              role="img"
              aria-label="PDF page"
            />
            <div
              ref={viewerViewportRef}
              className={styles.viewerContainer}
              data-pane-content="true"
              role="region"
              aria-label="PDF document"
              tabIndex={-1}
            >
              {beforeContent}
              <div
                ref={setContentNode}
                className={`pdfViewer ${styles.viewerHost}`}
              />
            </div>
          </div>
        </div>
      )}

      {!loading && !error && !textLayerUsable && !selection && (
        <div className={styles.notice}>
          Text selection is unavailable on this page.
        </div>
      )}

      {!loading && !error && textLayerUsable && !textGeometryReliable && (
        <div className={styles.notice}>
          Text geometry is misaligned on this page. Highlights will use
          area-based bounds.
        </div>
      )}

      {selectionError && (
        <div className={styles.error} role="alert">
          {selectionError}
        </div>
      )}

      {selectionPopoverProps ? (
        onQuoteToNewChat && onQuoteToExistingChat && textGeometryReliable ? (
          <SelectionPopover
            {...selectionPopoverProps}
            onQuoteToNewChat={(highlight) =>
              onQuoteToNewChat(highlight.id, highlight)
            }
            onQuoteToExistingChat={(highlight) =>
              onQuoteToExistingChat(highlight.id, highlight)
            }
          />
        ) : (
          <SelectionPopover {...selectionPopoverProps} />
        )
      ) : null}
    </div>
  );
}
