"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
import SelectionPopover from "./SelectionPopover";
import { type HighlightColor } from "@/lib/highlights";
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

export interface PdfHighlightQuad {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  x4: number;
  y4: number;
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
  annotation: {
    id: string;
    body: string;
    created_at: string;
    updated_at: string;
  } | null;
  author_user_id: string;
  is_owner: boolean;
}

interface PdfHighlightListResponse {
  data: {
    page_number: number;
    highlights: PdfHighlightOut[];
  };
}

interface PdfViewportLike {
  width: number;
  height: number;
  scale?: number;
  rotation?: number;
}

export interface PdfDocumentLike {
  numPages: number;
  destroy?: () => Promise<void> | void;
}

interface PdfDocumentLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy?: () => void;
}

interface OpenedPdfDocument {
  doc: PdfDocumentLike;
  loadingTask: PdfDocumentLoadingTaskLike;
}

interface PdfDocumentSourceLike {
  url: string;
  withCredentials?: boolean;
  disableRange?: boolean;
  disableStream?: boolean;
  disableAutoFetch?: boolean;
}

interface PdfGlobalWorkerOptionsLike {
  workerSrc: string;
}

export interface PdfJsLike {
  getDocument(source: PdfDocumentSourceLike): PdfDocumentLoadingTaskLike;
  GlobalWorkerOptions: PdfGlobalWorkerOptionsLike;
}

interface PdfPageViewLike {
  viewport?: PdfViewportLike;
  pdfPage?: {
    getViewport(params: { scale: number; rotation?: number }): PdfViewportLike;
  };
}

interface PdfEventBusLike {
  on(eventName: string, listener: (event: unknown) => void): void;
  off(eventName: string, listener: (event: unknown) => void): void;
}

interface PdfLinkServiceLike {
  setDocument(doc: PdfDocumentLike | null, baseUrl?: string | null): void;
  setViewer(viewer: PdfViewerLike): void;
}

interface PdfViewerLike {
  setDocument(doc: PdfDocumentLike | null): void;
  currentPageNumber: number;
  currentScaleValue: string | number;
  pagesCount: number;
  scrollMode?: number;
  getPageView?: (index: number) => PdfPageViewLike | undefined;
}

interface PdfJsViewerLike {
  EventBus: new () => PdfEventBusLike;
  PDFLinkService: new (params?: {
    eventBus?: PdfEventBusLike;
    externalLinkTarget?: number | null;
    externalLinkRel?: string | null;
  }) => PdfLinkServiceLike;
  PDFViewer: new (params: {
    container: HTMLDivElement;
    viewer: HTMLDivElement;
    eventBus: PdfEventBusLike;
    linkService: PdfLinkServiceLike;
    textLayerMode?: number;
  }) => PdfViewerLike;
  ScrollMode?: { VERTICAL?: number };
  LinkTarget?: { BLANK?: number };
}

type ApiFetchLike = <T>(path: string, options?: RequestInit) => Promise<T>;

export interface PdfReaderDeps {
  apiFetch: ApiFetchLike;
  loadPdfJs: () => Promise<PdfJsLike>;
  loadPdfJsViewer: () => Promise<PdfJsViewerLike>;
  workerSrc: string;
  getSelection: () => Selection | null;
}

interface PdfReaderProps {
  mediaId: string;
  deps?: Partial<PdfReaderDeps>;
  contentRef?: MutableRefObject<HTMLDivElement | null>;
  focusedHighlightId?: string | null;
  editingHighlightId?: string | null;
  highlightRefreshToken?: number;
  onPageHighlightsChange?: (pageNumber: number, highlights: PdfHighlightOut[]) => void;
}

interface SelectionState {
  range: Range;
  rect: DOMRect;
  pageNumber: number;
}

interface ProjectedHighlightRect {
  highlightId: string;
  color: HighlightColor;
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

type CreateTelemetryOutcome =
  | "idle"
  | "attempted"
  | "skipped_not_usable_or_creating"
  | "skipped_no_selection"
  | "skipped_no_geometry"
  | "request_patch"
  | "request_post"
  | "success"
  | "error";

interface CreateTelemetryState {
  attempts: number;
  postRequests: number;
  patchRequests: number;
  successes: number;
  errors: number;
  lastOutcome: CreateTelemetryOutcome;
}

interface ViewerEventHandlers {
  pagechanging: (event: unknown) => void;
  pagesloaded: (event: unknown) => void;
  pagerendered: (event: unknown) => void;
}

const DEFAULT_WORKER_SRC = "/api/pdfjs/worker";
const DEFAULT_VIEWER_MODULE_URL = "/api/pdfjs/viewer";
const SIGNED_URL_REFRESH_SKEW_MS = 2_000;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;
const PDF_QUAD_EPSILON = 0.001;
const PDF_VIEWER_TEXT_LAYER_MODE_ENABLE = 1;
const PDF_LINK_TARGET_BLANK = 2;
const OVERLAY_COLOR_MAP: Record<HighlightColor, string> = {
  yellow: "rgba(255, 235, 59, 0.35)",
  green: "rgba(76, 175, 80, 0.3)",
  blue: "rgba(33, 150, 243, 0.3)",
  pink: "rgba(233, 30, 99, 0.3)",
  purple: "rgba(156, 39, 176, 0.3)",
};

async function defaultLoadPdfJs(): Promise<PdfJsLike> {
  const moduleUrl = "/api/pdfjs/module";
  const pdfJsModule = await import(
    /* @vite-ignore */
    /* webpackIgnore: true */
    moduleUrl
  );
  return pdfJsModule as unknown as PdfJsLike;
}

async function defaultLoadPdfJsViewer(): Promise<PdfJsViewerLike> {
  const moduleUrl = DEFAULT_VIEWER_MODULE_URL;
  const pdfViewerModule = await import(
    /* @vite-ignore */
    /* webpackIgnore: true */
    moduleUrl
  );
  return pdfViewerModule as unknown as PdfJsViewerLike;
}

function defaultGetSelection(): Selection | null {
  return window.getSelection();
}

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
    errorMessage(error)
  );
}

function toUserFacingError(error: unknown): string {
  if (isPasswordPdfError(error)) {
    return "This PDF is password-protected and cannot be opened in v1.";
  }
  if (isApiError(error)) {
    return error.message;
  }
  return "Unable to load this PDF right now. Please retry.";
}

function isTextLayerEligibleNode(node: Node | null, textLayerRoot: HTMLElement | null): boolean {
  if (!node || !textLayerRoot) {
    return false;
  }
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return !!element && textLayerRoot.contains(element);
}

function isSelectionRangeInTextLayer(range: Range, textLayerRoot: HTMLElement | null): boolean {
  if (!textLayerRoot) {
    return false;
  }
  const startsInLayer = isTextLayerEligibleNode(range.startContainer, textLayerRoot);
  const endsInLayer = isTextLayerEligibleNode(range.endContainer, textLayerRoot);
  if (startsInLayer && endsInLayer) {
    return true;
  }

  const selectionRect = range.getBoundingClientRect();
  if (selectionRect.width <= PDF_QUAD_EPSILON || selectionRect.height <= PDF_QUAD_EPSILON) {
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

function toCanonicalPoint(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

function projectQuadToRect(
  quad: PdfHighlightQuad,
  pageScale: number
): Omit<ProjectedHighlightRect, "highlightId" | "color" | "index"> {
  const xMin = Math.min(quad.x1, quad.x2, quad.x3, quad.x4) * pageScale;
  const xMax = Math.max(quad.x1, quad.x2, quad.x3, quad.x4) * pageScale;
  const yMin = Math.min(quad.y1, quad.y2, quad.y3, quad.y4) * pageScale;
  const yMax = Math.max(quad.y1, quad.y2, quad.y3, quad.y4) * pageScale;

  return {
    left: xMin,
    top: yMin,
    width: Math.max(xMax - xMin, 1),
    height: Math.max(yMax - yMin, 1),
  };
}

function readPageNumberFromTextLayer(textLayerRoot: HTMLElement | null): number | null {
  const parsedPageNumber = Number.parseInt(
    textLayerRoot?.closest(".page")?.getAttribute("data-page-number") ?? "",
    10
  );
  if (!Number.isFinite(parsedPageNumber) || parsedPageNumber <= 0) {
    return null;
  }
  return parsedPageNumber;
}

function toSelectionSnapshot(
  range: Range,
  textLayerRoot: HTMLElement | null,
  pageNumber: number
): SelectionState {
  const rect = range.getBoundingClientRect();
  const effectiveRect =
    rect.width > 0 && rect.height > 0 ? rect : textLayerRoot?.getBoundingClientRect() ?? rect;
  return {
    range: range.cloneRange(),
    rect: effectiveRect,
    pageNumber,
  };
}

function createInitialCreateTelemetry(): CreateTelemetryState {
  return {
    attempts: 0,
    postRequests: 0,
    patchRequests: 0,
    successes: 0,
    errors: 0,
    lastOutcome: "idle",
  };
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

function deriveScaleFromPageView(pageView: PdfPageViewLike | undefined): number | null {
  if (!pageView?.viewport) {
    return null;
  }
  const viewport = pageView.viewport;
  if (typeof viewport.scale === "number" && viewport.scale > 0) {
    return viewport.scale;
  }
  if (pageView.pdfPage?.getViewport) {
    const baseViewport = pageView.pdfPage.getViewport({
      scale: 1,
      rotation: viewport.rotation,
    });
    if (baseViewport.width > 0) {
      const scale = viewport.width / baseViewport.width;
      if (Number.isFinite(scale) && scale > 0) {
        return scale;
      }
    }
  }
  return null;
}

export default function PdfReader({
  mediaId,
  deps,
  contentRef,
  focusedHighlightId = null,
  editingHighlightId = null,
  highlightRefreshToken = 0,
  onPageHighlightsChange,
}: PdfReaderProps) {
  const [loading, setLoading] = useState(true);
  const [navigating, setNavigating] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pageScale, setPageScale] = useState(1);
  const [pageRenderEpoch, setPageRenderEpoch] = useState(0);
  const [textLayerUsable, setTextLayerUsable] = useState(false);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [pageHighlights, setPageHighlights] = useState<PdfHighlightOut[]>([]);
  const [createTelemetry, setCreateTelemetry] = useState<CreateTelemetryState>(
    createInitialCreateTelemetry
  );

  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const internalContentRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<PdfDocumentLike | null>(null);
  const loadingTaskRef = useRef<PdfDocumentLoadingTaskLike | null>(null);
  const pdfJsRef = useRef<PdfJsLike | null>(null);
  const pdfJsViewerRef = useRef<PdfJsViewerLike | null>(null);
  const eventBusRef = useRef<PdfEventBusLike | null>(null);
  const linkServiceRef = useRef<PdfLinkServiceLike | null>(null);
  const pdfViewerRef = useRef<PdfViewerLike | null>(null);
  const eventHandlersRef = useRef<ViewerEventHandlers | null>(null);
  const signedUrlExpiryRef = useRef<number | null>(null);
  const selectionSnapshotRef = useRef<SelectionState | null>(null);
  const activePageScaleRef = useRef(1);
  const zoomRef = useRef(1);
  const runRef = useRef(0);
  const pageNumberRef = useRef(1);
  const pageScaleByNumberRef = useRef<Map<number, number>>(new Map());
  const recoveringFromRenderErrorRef = useRef(false);

  const apiFetchDep = deps?.apiFetch ?? apiFetch;
  const loadPdfJsDep = deps?.loadPdfJs ?? defaultLoadPdfJs;
  const loadPdfJsViewerDep = deps?.loadPdfJsViewer ?? defaultLoadPdfJsViewer;
  const workerSrcDep = deps?.workerSrc ?? DEFAULT_WORKER_SRC;
  const getSelectionDep = deps?.getSelection ?? defaultGetSelection;

  const setContentNode = useCallback(
    (node: HTMLDivElement | null) => {
      internalContentRef.current = node;
      if (contentRef) {
        contentRef.current = node;
      }
    },
    [contentRef]
  );

  const ensurePdfJs = useCallback(async () => {
    if (pdfJsRef.current) {
      return pdfJsRef.current;
    }
    const pdfJs = await loadPdfJsDep();
    try {
      pdfJs.GlobalWorkerOptions.workerSrc = workerSrcDep;
    } catch {
      // Some PDF.js bundles preconfigure worker wiring.
    }
    pdfJsRef.current = pdfJs;
    return pdfJs;
  }, [loadPdfJsDep, workerSrcDep]);

  const ensurePdfJsViewer = useCallback(async () => {
    if (pdfJsViewerRef.current) {
      return pdfJsViewerRef.current;
    }
    const pdfJsViewer = await loadPdfJsViewerDep();
    pdfJsViewerRef.current = pdfJsViewer;
    return pdfJsViewer;
  }, [loadPdfJsViewerDep]);

  const getPageElement = useCallback((targetPage: number): HTMLElement | null => {
    const root = internalContentRef.current;
    if (!root) {
      return null;
    }
    const byNumber = root.querySelector<HTMLElement>(`.page[data-page-number="${targetPage}"]`);
    if (byNumber) {
      return byNumber;
    }
    const fallback = root.querySelectorAll<HTMLElement>(".page")[targetPage - 1];
    return fallback ?? null;
  }, []);

  const getTextLayerRootForPage = useCallback(
    (targetPage: number): HTMLElement | null => {
      return getPageElement(targetPage)?.querySelector<HTMLElement>(".textLayer") ?? null;
    },
    [getPageElement]
  );

  const markPageSurfaceForTesting = useCallback(
    (targetPage: number) => {
      const pageElement = getPageElement(targetPage);
      if (pageElement) {
        pageElement.setAttribute("data-testid", `pdf-page-surface-${targetPage}`);
      }
    },
    [getPageElement]
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
      const resolvedScale = derivedScale ?? pageScaleByNumberRef.current.get(targetPage) ?? zoomRef.current;
      pageScaleByNumberRef.current.set(targetPage, resolvedScale);
      if (targetPage === pageNumberRef.current) {
        activePageScaleRef.current = resolvedScale;
        setPageScale(resolvedScale);
      }
      return resolvedScale;
    },
    []
  );

  const readPageScale = useCallback(
    (targetPage: number): number => {
      return pageScaleByNumberRef.current.get(targetPage) ?? rememberPageScale(targetPage);
    },
    [rememberPageScale]
  );

  const isTextLayerUsableForPage = useCallback(
    (targetPage: number): boolean => {
      const textLayerRoot = getTextLayerRootForPage(targetPage);
      if (!textLayerRoot) {
        return false;
      }
      return (textLayerRoot.textContent ?? "").trim().length > 0;
    },
    [getTextLayerRootForPage]
  );

  const clearSelection = useCallback(() => {
    setSelection(null);
    selectionSnapshotRef.current = null;
    setSelectionError(null);
    getSelectionDep()?.removeAllRanges();
  }, [getSelectionDep]);

  const updateCreateTelemetry = useCallback(
    (updater: (prev: CreateTelemetryState) => CreateTelemetryState) => {
      setCreateTelemetry((prev) => updater(prev));
    },
    []
  );

  const fetchSignedUrl = useCallback(async () => {
    const response = await apiFetchDep<PdfFileAccessResponse>(`/api/media/${mediaId}/file`);
    const expiresAtMs = Date.parse(response.data.expires_at);
    return {
      url: response.data.url,
      expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
    } satisfies SignedUrlAccess;
  }, [apiFetchDep, mediaId]);

  const fetchPageHighlights = useCallback(
    async (targetPage: number): Promise<PdfHighlightOut[]> => {
      const response = await apiFetchDep<PdfHighlightListResponse>(
        `/api/media/${mediaId}/pdf-highlights?page_number=${targetPage}&mine_only=false`
      );
      return response.data.highlights.filter(
        (highlight) =>
          highlight.anchor.type === "pdf_page_geometry" &&
          highlight.anchor.page_number === targetPage
      );
    },
    [apiFetchDep, mediaId]
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
    [ensurePdfJs]
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

  const teardownViewer = useCallback(() => {
    const eventBus = eventBusRef.current;
    const handlers = eventHandlersRef.current;
    if (eventBus && handlers) {
      eventBus.off("pagechanging", handlers.pagechanging);
      eventBus.off("pagesloaded", handlers.pagesloaded);
      eventBus.off("pagerendered", handlers.pagerendered);
    }
    eventHandlersRef.current = null;
    linkServiceRef.current?.setDocument(null, null);
    pdfViewerRef.current?.setDocument(null);
    eventBusRef.current = null;
    linkServiceRef.current = null;
    pdfViewerRef.current = null;
    removeOverlayLayers();
    if (internalContentRef.current) {
      internalContentRef.current.innerHTML = "";
    }
  }, [removeOverlayLayers]);

  const recoverAndRenderRef = useRef<
    ((targetPage: number, runId: number) => Promise<void>) | null
  >(null);

  const initializeViewerIfNeeded = useCallback(
    async (runId: number) => {
      if (pdfViewerRef.current && eventBusRef.current && linkServiceRef.current) {
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
        externalLinkTarget: viewerModule.LinkTarget?.BLANK ?? PDF_LINK_TARGET_BLANK,
        externalLinkRel: "noopener noreferrer nofollow",
      });
      const pdfViewer = new viewerModule.PDFViewer({
        container,
        viewer: viewerHost,
        eventBus,
        linkService,
        textLayerMode: PDF_VIEWER_TEXT_LAYER_MODE_ENABLE,
      });
      try {
        if (typeof viewerModule.ScrollMode?.VERTICAL === "number") {
          pdfViewer.scrollMode = viewerModule.ScrollMode.VERTICAL;
        }
      } catch {
        // Some viewer shims may not expose scrollMode mutability.
      }
      linkService.setViewer(pdfViewer);

      const handlePageChanging = (rawEvent: unknown) => {
        if (runId !== runRef.current) {
          return;
        }
        const event = rawEvent as { pageNumber?: number };
        const nextPage = Number.isFinite(event.pageNumber)
          ? Math.max(1, Math.floor(event.pageNumber as number))
          : 1;
        pageNumberRef.current = nextPage;
        setPageNumber(nextPage);
        setNavigating(false);
        clearSelection();
        setPageHighlights([]);
        onPageHighlightsChange?.(nextPage, []);
        rememberPageScale(nextPage);
        setTextLayerUsable(isTextLayerUsableForPage(nextPage));
        setPageRenderEpoch((value) => value + 1);
      };

      const handlePagesLoaded = (rawEvent: unknown) => {
        if (runId !== runRef.current) {
          return;
        }
        const event = rawEvent as { pagesCount?: number };
        const pagesCount =
          Number.isFinite(event.pagesCount) && (event.pagesCount as number) > 0
            ? Math.floor(event.pagesCount as number)
            : documentRef.current?.numPages ?? 0;
        setNumPages(pagesCount);
        window.requestAnimationFrame(() => {
          if (runId !== runRef.current) {
            return;
          }
          for (let index = 1; index <= pagesCount; index += 1) {
            markPageSurfaceForTesting(index);
          }
        });
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
        const renderedPage =
          Number.isFinite(event.pageNumber) && (event.pageNumber as number) > 0
            ? Math.floor(event.pageNumber as number)
            : pageNumberRef.current;

        markPageSurfaceForTesting(renderedPage);
        rememberPageScale(renderedPage, event.source);

        if (
          event.error &&
          isLikelySignedUrlExpiryError(event.error) &&
          !recoveringFromRenderErrorRef.current
        ) {
          recoveringFromRenderErrorRef.current = true;
          void recoverAndRenderRef.current
            ?.(
              pageNumberRef.current,
              runRef.current
            )
            .finally(() => {
              if (runId === runRef.current) {
                recoveringFromRenderErrorRef.current = false;
              }
            });
        }

        if (renderedPage === pageNumberRef.current) {
          window.requestAnimationFrame(() => {
            if (runId !== runRef.current) {
              return;
            }
            setTextLayerUsable(isTextLayerUsableForPage(renderedPage));
            setPageRenderEpoch((value) => value + 1);
          });
        }
      };

      eventBus.on("pagechanging", handlePageChanging);
      eventBus.on("pagesloaded", handlePagesLoaded);
      eventBus.on("pagerendered", handlePageRendered);

      eventBusRef.current = eventBus;
      linkServiceRef.current = linkService;
      pdfViewerRef.current = pdfViewer;
      eventHandlersRef.current = {
        pagechanging: handlePageChanging,
        pagesloaded: handlePagesLoaded,
        pagerendered: handlePageRendered,
      };
    },
    [
      clearSelection,
      ensurePdfJsViewer,
      isTextLayerUsableForPage,
      markPageSurfaceForTesting,
      onPageHighlightsChange,
      rememberPageScale,
    ]
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
      removeOverlayLayers();

      linkService.setDocument(doc, null);
      viewer.setDocument(doc);

      const boundedPage = Math.max(1, Math.min(targetPage, doc.numPages));
      pageNumberRef.current = boundedPage;
      setPageNumber(boundedPage);
      setNumPages(doc.numPages);
      setTextLayerUsable(false);
      setPageScale(zoomRef.current);
      activePageScaleRef.current = zoomRef.current;

      try {
        viewer.currentScaleValue = `${zoomRef.current}`;
      } catch {
        // Ignore for lightweight test shims.
      }
      try {
        viewer.currentPageNumber = boundedPage;
      } catch {
        // Ignore for lightweight test shims.
      }
    },
    [initializeViewerIfNeeded, removeOverlayLayers]
  );

  const recoverAndRender = useCallback(
    async (targetPage: number, runId: number) => {
      setRecovering(true);
      try {
        const refreshedAccess = await fetchSignedUrl();
        if (runId !== runRef.current) {
          return;
        }
        const refreshedOpened = await openDocument(refreshedAccess.url);
        if (runId !== runRef.current) {
          await destroyPdfDocument(refreshedOpened.doc);
          destroyPdfLoadingTask(refreshedOpened.loadingTask);
          return;
        }

        signedUrlExpiryRef.current = refreshedAccess.expiresAtMs;
        await replaceDocument(refreshedOpened);
        await attachDocumentToViewer(refreshedOpened.doc, targetPage, runId);
        setError(null);
      } catch (err) {
        if (runId === runRef.current) {
          setError(toUserFacingError(err));
        }
      } finally {
        if (runId === runRef.current) {
          setRecovering(false);
        }
      }
    },
    [attachDocumentToViewer, fetchSignedUrl, openDocument, replaceDocument]
  );

  useEffect(() => {
    recoverAndRenderRef.current = recoverAndRender;
    return () => {
      recoverAndRenderRef.current = null;
    };
  }, [recoverAndRender]);

  const refreshPageHighlights = useCallback(
    async (targetPage: number, runId: number) => {
      const highlights = await fetchPageHighlights(targetPage);
      if (runId !== runRef.current) {
        return;
      }
      setPageHighlights(highlights);
      onPageHighlightsChange?.(targetPage, highlights);
    },
    [fetchPageHighlights, onPageHighlightsChange]
  );

  const resolveTextLayerRootFromRange = useCallback(
    (targetRange: Range): { textLayerRoot: HTMLElement; pageNumber: number } | null => {
      const contexts = [targetRange.startContainer, targetRange.endContainer]
        .map((node) => {
          const element =
            node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
          return element?.closest(".textLayer");
        })
        .filter((element): element is HTMLElement => element instanceof HTMLElement);
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
    [getTextLayerRootForPage]
  );

  const captureSelectionSnapshotFromWindow = useCallback(() => {
    const sel = getSelectionDep();
    if (!sel || sel.rangeCount === 0 || sel.toString().trim().length === 0) {
      return;
    }
    const range = sel.getRangeAt(0);
    const selectionContext = resolveTextLayerRootFromRange(range);
    if (!selectionContext) {
      return;
    }
    selectionSnapshotRef.current = toSelectionSnapshot(
      range,
      selectionContext.textLayerRoot,
      selectionContext.pageNumber
    );
  }, [getSelectionDep, resolveTextLayerRootFromRange]);

  const buildSelectionQuads = useCallback(
    (range: Range, targetPage: number): PdfHighlightQuad[] => {
      const layerRect = getTextLayerRootForPage(targetPage)?.getBoundingClientRect();
      const pageScaleValue = readPageScale(targetPage);
      if (!layerRect || pageScaleValue <= 0) {
        return [];
      }

      const rectsFromRange = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > PDF_QUAD_EPSILON && rect.height > PDF_QUAD_EPSILON
      );
      const fallbackRect = range.getBoundingClientRect();
      const rects =
        rectsFromRange.length > 0
          ? rectsFromRange
          : fallbackRect.width > PDF_QUAD_EPSILON && fallbackRect.height > PDF_QUAD_EPSILON
            ? [fallbackRect]
            : layerRect.width > PDF_QUAD_EPSILON && layerRect.height > PDF_QUAD_EPSILON
              ? [layerRect]
              : [];

      return rects.map((rect) => {
        const left = toCanonicalPoint((rect.left - layerRect.left) / pageScaleValue);
        const right = toCanonicalPoint((rect.right - layerRect.left) / pageScaleValue);
        const top = toCanonicalPoint((rect.top - layerRect.top) / pageScaleValue);
        const bottom = toCanonicalPoint((rect.bottom - layerRect.top) / pageScaleValue);

        return {
          x1: left,
          y1: top,
          x2: right,
          y2: top,
          x3: right,
          y3: bottom,
          x4: left,
          y4: bottom,
        };
      });
    },
    [getTextLayerRootForPage, readPageScale]
  );

  const syncSelectionFromWindow = useCallback(() => {
    if (!textLayerUsable) {
      setSelection(null);
      selectionSnapshotRef.current = null;
      return;
    }

    const sel = getSelectionDep();
    if (!sel || sel.rangeCount === 0) {
      setSelection(null);
      return;
    }
    const selectedTextFromSelection = sel.toString().trim();
    if (sel.isCollapsed && selectedTextFromSelection.length === 0) {
      setSelection(null);
      return;
    }

    const range = sel.getRangeAt(0);
    const selectionContext = resolveTextLayerRootFromRange(range);
    if (!selectionContext) {
      setSelection(null);
      return;
    }

    const selectionText =
      selectedTextFromSelection.length > 0 ? selectedTextFromSelection : range.toString().trim();
    if (selectionText.length === 0) {
      setSelection(null);
      return;
    }

    const snapshot = toSelectionSnapshot(
      range,
      selectionContext.textLayerRoot,
      selectionContext.pageNumber
    );
    selectionSnapshotRef.current = snapshot;
    setSelection(snapshot);
    setSelectionError(null);
  }, [getSelectionDep, resolveTextLayerRootFromRange, textLayerUsable]);

  const handleCreateHighlight = useCallback(
    async (color: HighlightColor) => {
      updateCreateTelemetry((prev) => ({
        ...prev,
        attempts: prev.attempts + 1,
        lastOutcome: "attempted",
      }));
      if (!textLayerUsable || isCreating) {
        updateCreateTelemetry((prev) => ({
          ...prev,
          lastOutcome: "skipped_not_usable_or_creating",
        }));
        return;
      }

      const fallbackSelection: SelectionState | null = (() => {
        const sel = getSelectionDep();
        if (!sel || sel.rangeCount === 0 || sel.toString().trim().length === 0) {
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
          selectionContext.pageNumber
        );
      })();

      const activeSelection = selection ?? selectionSnapshotRef.current ?? fallbackSelection;
      if (!activeSelection) {
        updateCreateTelemetry((prev) => ({
          ...prev,
          lastOutcome: "skipped_no_selection",
        }));
        return;
      }

      const exact = activeSelection.range.toString().trim();
      const quads = buildSelectionQuads(activeSelection.range, activeSelection.pageNumber);
      if (quads.length === 0) {
        updateCreateTelemetry((prev) => ({
          ...prev,
          lastOutcome: "skipped_no_geometry",
        }));
        setSelectionError("No selectable text geometry was found for this selection.");
        clearSelection();
        return;
      }

      setIsCreating(true);
      setSelectionError(null);
      try {
        if (editingHighlightId) {
          updateCreateTelemetry((prev) => ({
            ...prev,
            patchRequests: prev.patchRequests + 1,
            lastOutcome: "request_patch",
          }));
          await apiFetchDep(`/api/highlights/${editingHighlightId}`, {
            method: "PATCH",
            body: JSON.stringify({
              pdf_bounds: {
                page_number: activeSelection.pageNumber,
                quads,
                exact,
              },
            }),
          });
        } else {
          updateCreateTelemetry((prev) => ({
            ...prev,
            postRequests: prev.postRequests + 1,
            lastOutcome: "request_post",
          }));
          await apiFetchDep(`/api/media/${mediaId}/pdf-highlights`, {
            method: "POST",
            body: JSON.stringify({
              page_number: activeSelection.pageNumber,
              quads,
              exact,
              color,
            }),
          });
        }

        updateCreateTelemetry((prev) => ({
          ...prev,
          successes: prev.successes + 1,
          lastOutcome: "success",
        }));
        await refreshPageHighlights(activeSelection.pageNumber, runRef.current);
        clearSelection();
      } catch (err) {
        updateCreateTelemetry((prev) => ({
          ...prev,
          errors: prev.errors + 1,
          lastOutcome: "error",
        }));
        setSelectionError(toUserFacingError(err));
      } finally {
        setIsCreating(false);
      }
    },
    [
      apiFetchDep,
      buildSelectionQuads,
      clearSelection,
      editingHighlightId,
      getSelectionDep,
      isCreating,
      mediaId,
      refreshPageHighlights,
      resolveTextLayerRootFromRange,
      selection,
      textLayerUsable,
      updateCreateTelemetry,
    ]
  );

  const goToPage = useCallback(
    async (nextPage: number) => {
      const viewer = pdfViewerRef.current;
      if (!viewer || nextPage < 1 || nextPage > numPages) {
        return;
      }

      setNavigating(true);
      clearSelection();
      setPageHighlights([]);
      onPageHighlightsChange?.(nextPage, []);

      const currentRun = runRef.current;
      try {
        const expiryMs = signedUrlExpiryRef.current;
        if (typeof expiryMs === "number" && Date.now() >= expiryMs - SIGNED_URL_REFRESH_SKEW_MS) {
          await recoverAndRender(nextPage, currentRun);
          return;
        }
        viewer.currentPageNumber = nextPage;
      } catch (err) {
        if (isLikelySignedUrlExpiryError(err)) {
          await recoverAndRender(nextPage, currentRun);
        } else {
          setError(toUserFacingError(err));
        }
      } finally {
        if (currentRun === runRef.current) {
          window.setTimeout(() => setNavigating(false), 0);
        }
      }
    },
    [clearSelection, numPages, onPageHighlightsChange, recoverAndRender]
  );

  useEffect(() => {
    zoomRef.current = zoom;
    const viewer = pdfViewerRef.current;
    if (!viewer) {
      return;
    }
    pageScaleByNumberRef.current.clear();
    try {
      viewer.currentScaleValue = `${zoom}`;
    } catch {
      // Ignore for lightweight test shims.
    }
    activePageScaleRef.current = zoom;
    setPageScale(zoom);
    setPageRenderEpoch((value) => value + 1);
  }, [zoom]);

  useEffect(() => {
    let active = true;
    const runId = ++runRef.current;
    const pageScaleCache = pageScaleByNumberRef.current;

    setLoading(true);
    setNavigating(false);
    setRecovering(false);
    setError(null);
    setPageNumber(1);
    setNumPages(0);
    setZoom(1);
    setPageScale(1);
    setPageRenderEpoch(0);
    setSelection(null);
    setSelectionError(null);
    setPageHighlights([]);
    setTextLayerUsable(false);
    setCreateTelemetry(createInitialCreateTelemetry());
    pageNumberRef.current = 1;
    pageScaleCache.clear();
    signedUrlExpiryRef.current = null;
    recoveringFromRenderErrorRef.current = false;
    teardownViewer();

    const bootstrap = async () => {
      try {
        const signedAccess = await fetchSignedUrl();
        if (!active || runId !== runRef.current) {
          return;
        }
        const opened = await openDocument(signedAccess.url);
        if (!active || runId !== runRef.current) {
          await destroyPdfDocument(opened.doc);
          destroyPdfLoadingTask(opened.loadingTask);
          return;
        }
        signedUrlExpiryRef.current = signedAccess.expiresAtMs;
        await replaceDocument(opened);
        await attachDocumentToViewer(opened.doc, 1, runId);
      } catch (err) {
        if (active && runId === runRef.current) {
          setError(toUserFacingError(err));
        }
      } finally {
        if (active && runId === runRef.current) {
          setLoading(false);
        }
      }
    };
    void bootstrap();

    return () => {
      active = false;
      runRef.current += 1;
      signedUrlExpiryRef.current = null;
      pageScaleCache.clear();
      recoveringFromRenderErrorRef.current = false;
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
    attachDocumentToViewer,
    clearSelection,
    fetchSignedUrl,
    mediaId,
    openDocument,
    replaceDocument,
    teardownViewer,
  ]);

  useEffect(() => {
    if (!documentRef.current || numPages <= 0 || loading || error) {
      return;
    }

    const runId = runRef.current;
    let cancelled = false;
    const sync = async () => {
      try {
        const highlights = await fetchPageHighlights(pageNumber);
        if (cancelled || runId !== runRef.current) {
          return;
        }
        setPageHighlights(highlights);
        onPageHighlightsChange?.(pageNumber, highlights);
      } catch {
        if (!cancelled && runId === runRef.current) {
          setSelectionError("Failed to load PDF highlights for this page.");
        }
      }
    };
    void sync();

    return () => {
      cancelled = true;
    };
  }, [
    error,
    fetchPageHighlights,
    highlightRefreshToken,
    loading,
    numPages,
    onPageHighlightsChange,
    pageNumber,
  ]);

  useEffect(() => {
    document.addEventListener("selectionchange", syncSelectionFromWindow);
    return () => {
      document.removeEventListener("selectionchange", syncSelectionFromWindow);
    };
  }, [syncSelectionFromWindow]);

  useEffect(() => {
    if (!textLayerUsable) {
      return;
    }
    const pollId = window.setInterval(() => {
      const sel = getSelectionDep();
      if (!sel || sel.toString().trim().length === 0) {
        return;
      }
      syncSelectionFromWindow();
    }, 150);
    return () => {
      window.clearInterval(pollId);
    };
  }, [getSelectionDep, syncSelectionFromWindow, textLayerUsable]);

  const projectedHighlightRects = useMemo(() => {
    const activeScale = pageScale <= 0 ? activePageScaleRef.current : pageScale;
    if (activeScale <= 0) {
      return [] as ProjectedHighlightRect[];
    }
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
          ...projectQuadToRect(quad, activeScale),
        });
      });
    }
    return projected;
  }, [pageHighlights, pageNumber, pageScale]);

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
      if (focusedHighlightId === rect.highlightId) {
        rectEl.classList.add(styles.highlightOverlayRectFocused);
      }
      rectEl.setAttribute("data-testid", `pdf-highlight-${rect.highlightId}-${rect.index}`);
      rectEl.setAttribute("data-highlight-color", rect.color);
      if (rect.index === 0) {
        rectEl.setAttribute("data-highlight-anchor", rect.highlightId);
      }
      rectEl.style.left = `${rect.left}px`;
      rectEl.style.top = `${rect.top}px`;
      rectEl.style.width = `${rect.width}px`;
      rectEl.style.height = `${rect.height}px`;
      rectEl.style.backgroundColor = OVERLAY_COLOR_MAP[rect.color];
      rectEl.style.mixBlendMode = "multiply";
      overlayLayer.append(rectEl);
    }
    pageElement.append(overlayLayer);
  }, [focusedHighlightId, getPageElement, pageNumber, projectedHighlightRects, removeOverlayLayers]);

  const showBusy = loading || navigating || recovering;
  const zoomPercent = Math.round(zoom * 100);
  const canZoomIn = zoom < MAX_ZOOM - 0.001;
  const canZoomOut = zoom > MIN_ZOOM + 0.001;

  return (
    <div className={styles.viewer}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.navButton}
          onClick={() => void goToPage(pageNumber - 1)}
          disabled={showBusy || pageNumber <= 1}
          aria-label="Previous page"
        >
          Previous page
        </button>
        <span className={styles.pageIndicator}>
          Page {pageNumber} of {numPages || 0}
        </span>
        <button
          type="button"
          className={styles.navButton}
          onClick={() => void goToPage(pageNumber + 1)}
          disabled={showBusy || pageNumber >= numPages}
          aria-label="Next page"
        >
          Next page
        </button>
        <button
          type="button"
          className={styles.navButton}
          onMouseDown={(event) => {
            event.preventDefault();
            captureSelectionSnapshotFromWindow();
          }}
          onClick={() => void handleCreateHighlight("yellow")}
          disabled={showBusy || !textLayerUsable || isCreating}
          aria-label="Highlight selection"
          data-create-attempts={createTelemetry.attempts}
          data-create-post-requests={createTelemetry.postRequests}
          data-create-patch-requests={createTelemetry.patchRequests}
          data-create-successes={createTelemetry.successes}
          data-create-errors={createTelemetry.errors}
          data-create-last-outcome={createTelemetry.lastOutcome}
          data-page-render-epoch={pageRenderEpoch}
          data-selection-popover-ignore-outside="true"
        >
          Highlight selection
        </button>
        <div className={styles.zoomControls}>
          <button
            type="button"
            className={styles.navButton}
            onClick={() => setZoom((value) => clampZoom(value - ZOOM_STEP))}
            disabled={showBusy || !canZoomOut}
            aria-label="Zoom out"
          >
            Zoom out
          </button>
          <span className={styles.zoomLabel}>{zoomPercent}%</span>
          <button
            type="button"
            className={styles.navButton}
            onClick={() => setZoom((value) => clampZoom(value + ZOOM_STEP))}
            disabled={showBusy || !canZoomIn}
            aria-label="Zoom in"
          >
            Zoom in
          </button>
        </div>
      </div>

      {recovering && <div className={styles.notice}>Refreshing secure file access…</div>}

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : (
        <div className={styles.canvasWrap}>
          {(loading || navigating) && (
            <div className={styles.loading} role="status">
              Loading PDF…
            </div>
          )}
          <div className={styles.pdfViewport}>
            <div className={styles.viewerA11yMarker} role="img" aria-label="PDF page" />
            <div
              ref={viewerContainerRef}
              className={styles.viewerContainer}
              aria-label="PDF document"
            >
              <div ref={setContentNode} className={`pdfViewer ${styles.viewerHost}`} />
            </div>
          </div>
        </div>
      )}

      {!loading && !error && !textLayerUsable && (
        <div className={styles.notice}>Text selection is unavailable on this page.</div>
      )}

      {selectionError && (
        <div className={styles.error} role="alert">
          {selectionError}
        </div>
      )}

      {selection && viewerContainerRef.current && (
        <SelectionPopover
          selectionRect={selection.rect}
          containerRef={viewerContainerRef}
          onCreateHighlight={handleCreateHighlight}
          onDismiss={clearSelection}
          isCreating={isCreating}
        />
      )}
    </div>
  );
}
