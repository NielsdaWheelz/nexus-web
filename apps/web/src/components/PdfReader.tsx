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

interface PdfRenderTaskLike {
  promise: Promise<unknown>;
}

interface PdfTextContentLike {
  items: Array<{ str?: string }>;
  styles?: Record<string, unknown>;
}

interface PdfPageLike {
  getViewport(params: { scale: number; rotation?: number }): PdfViewportLike;
  getTextContent?: () => Promise<PdfTextContentLike>;
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewportLike;
  }): PdfRenderTaskLike;
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
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

interface PdfTextLayerLike {
  render(): Promise<unknown>;
  update?: (params: { viewport: PdfViewportLike; onBefore?: () => void }) => void;
  cancel?: () => void;
}

interface PdfTextLayerConstructorLike {
  new (params: {
    textContentSource: PdfTextContentLike;
    container: HTMLElement;
    viewport: PdfViewportLike;
  }): PdfTextLayerLike;
}

export interface PdfJsLike {
  getDocument(source: PdfDocumentSourceLike): PdfDocumentLoadingTaskLike;
  GlobalWorkerOptions: PdfGlobalWorkerOptionsLike;
  TextLayer?: PdfTextLayerConstructorLike;
}

type ApiFetchLike = <T>(path: string, options?: RequestInit) => Promise<T>;

export interface PdfReaderDeps {
  apiFetch: ApiFetchLike;
  loadPdfJs: () => Promise<PdfJsLike>;
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

const DEFAULT_WORKER_SRC = "/api/pdfjs/worker";
const SIGNED_URL_REFRESH_SKEW_MS = 2_000;
const DEFAULT_PAGE_SCALE = 1.3;
const MIN_PAGE_SCALE = 0.25;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;
const PDF_QUAD_EPSILON = 0.001;
const OVERLAY_COLOR_MAP: Record<HighlightColor, string> = {
  yellow: "rgba(255, 235, 59, 0.35)",
  green: "rgba(76, 175, 80, 0.3)",
  blue: "rgba(33, 150, 243, 0.3)",
  pink: "rgba(233, 30, 99, 0.3)",
  purple: "rgba(156, 39, 176, 0.3)",
};

// Explicit S6 reprojection triggers: page/text-layer readiness, zoom/scale, highlight data.
const OVERLAY_REPROJECTION_TRIGGER_MATRIX = [
  "page_or_text_layer_render_availability",
  "viewer_zoom_scale",
  "highlight_data",
] as const;

async function defaultLoadPdfJs(): Promise<PdfJsLike> {
  const moduleUrl = "/api/pdfjs/module";
  const pdfJsModule = await import(
    /* @vite-ignore */
    /* webpackIgnore: true */
    moduleUrl
  );
  return pdfJsModule as unknown as PdfJsLike;
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
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;
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

function hasUsableTextItems(textContent: PdfTextContentLike): boolean {
  return textContent.items.some((item) => typeof item.str === "string" && item.str.trim().length > 0);
}

function toCanonicalPoint(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampZoom(value: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
}

function projectQuadToRect(quad: PdfHighlightQuad, pageScale: number): Omit<ProjectedHighlightRect, "highlightId" | "color" | "index"> {
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

function toSelectionSnapshot(
  range: Range,
  textLayerRoot: HTMLElement | null,
): SelectionState {
  const rect = range.getBoundingClientRect();
  const effectiveRect =
    rect.width > 0 && rect.height > 0
      ? rect
      : textLayerRoot?.getBoundingClientRect() ?? rect;
  return {
    range: range.cloneRange(),
    rect: effectiveRect,
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
  const [pageScale, setPageScale] = useState(DEFAULT_PAGE_SCALE);
  const [pageRenderEpoch, setPageRenderEpoch] = useState(0);
  const [textLayerUsable, setTextLayerUsable] = useState(false);
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [pageHighlights, setPageHighlights] = useState<PdfHighlightOut[]>([]);
  const [createTelemetry, setCreateTelemetry] = useState<CreateTelemetryState>(
    createInitialCreateTelemetry
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const internalContentRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<PdfDocumentLike | null>(null);
  const loadingTaskRef = useRef<PdfDocumentLoadingTaskLike | null>(null);
  const textLayerTaskRef = useRef<PdfTextLayerLike | null>(null);
  const lastRenderedContainerWidthRef = useRef(0);
  const pdfJsRef = useRef<PdfJsLike | null>(null);
  const signedUrlExpiryRef = useRef<number | null>(null);
  const selectionSnapshotRef = useRef<SelectionState | null>(null);
  const activePageScaleRef = useRef(DEFAULT_PAGE_SCALE);
  const zoomRef = useRef(1);
  const runRef = useRef(0);

  const apiFetchDep = deps?.apiFetch ?? apiFetch;
  const loadPdfJsDep = deps?.loadPdfJs ?? defaultLoadPdfJs;
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
      // webpack entry configures workerPort automatically.
    }
    pdfJsRef.current = pdfJs;
    return pdfJs;
  }, [loadPdfJsDep, workerSrcDep]);

  const clearTextLayer = useCallback(() => {
    textLayerTaskRef.current?.cancel?.();
    textLayerTaskRef.current = null;
    if (textLayerRef.current) {
      textLayerRef.current.innerHTML = "";
    }
    setTextLayerUsable(false);
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(null);
    selectionSnapshotRef.current = null;
    setSelectionError(null);
    getSelectionDep()?.removeAllRanges();
  }, [getSelectionDep]);

  const captureSelectionSnapshotFromWindow = useCallback(() => {
    const sel = getSelectionDep();
    if (!sel || sel.rangeCount === 0 || sel.toString().trim().length === 0) {
      return;
    }
    const range = sel.getRangeAt(0);
    const textLayerRoot = textLayerRef.current;
    if (!isSelectionRangeInTextLayer(range, textLayerRoot)) {
      return;
    }
    selectionSnapshotRef.current = toSelectionSnapshot(range, textLayerRoot);
  }, [getSelectionDep]);

  const updateCreateTelemetry = useCallback(
    (updater: (prev: CreateTelemetryState) => CreateTelemetryState) => {
      setCreateTelemetry((prev) => updater(prev));
    },
    []
  );

  const fetchSignedUrl = useCallback(async () => {
    const response = await apiFetchDep<PdfFileAccessResponse>(
      `/api/media/${mediaId}/file`
    );
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

  const renderTextLayer = useCallback(
    async (
      page: PdfPageLike,
      viewport: PdfViewportLike,
      runId: number
    ): Promise<boolean> => {
      if (runId !== runRef.current) {
        return false;
      }
      const container = textLayerRef.current;
      if (!container) {
        return false;
      }

      clearTextLayer();
      if (!page.getTextContent) {
        return false;
      }

      let textContent: PdfTextContentLike;
      try {
        textContent = await page.getTextContent();
      } catch {
        return false;
      }
      if (runId !== runRef.current) {
        return false;
      }

      if (!hasUsableTextItems(textContent)) {
        return false;
      }

      const pdfJs = await ensurePdfJs();
      if (runId !== runRef.current) {
        return false;
      }

      const TextLayerCtor = pdfJs.TextLayer;
      if (TextLayerCtor) {
        const textLayerTask = new TextLayerCtor({
          textContentSource: textContent,
          container,
          viewport,
        });
        textLayerTaskRef.current = textLayerTask;
        await textLayerTask.render();
      } else {
        for (const item of textContent.items) {
          if (!item.str || item.str.trim().length === 0) {
            continue;
          }
          const span = document.createElement("span");
          span.textContent = item.str;
          container.appendChild(span);
          container.appendChild(document.createTextNode(" "));
        }
      }

      if (runId !== runRef.current) {
        return false;
      }
      return (container.textContent ?? "").trim().length > 0;
    },
    [clearTextLayer, ensurePdfJs]
  );

  const renderPage = useCallback(
    async (doc: PdfDocumentLike, targetPage: number, runId: number) => {
      const boundedPage = Math.max(1, Math.min(targetPage, doc.numPages));
      const page = await doc.getPage(boundedPage);
      if (runId !== runRef.current) {
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) {
        throw new Error("PDF canvas is not available");
      }

      const baseViewport = page.getViewport({ scale: 1 });
      const containerWidth =
        internalContentRef.current?.clientWidth ?? canvas.parentElement?.clientWidth ?? 0;
      const fitScale =
        containerWidth > 0 && baseViewport.width > 0
          ? Math.max(MIN_PAGE_SCALE, containerWidth / baseViewport.width)
          : DEFAULT_PAGE_SCALE;
      const finalScale = fitScale * zoomRef.current;
      const viewport =
        finalScale === 1 ? baseViewport : page.getViewport({ scale: finalScale });

      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("2D canvas context is unavailable");
      }

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      lastRenderedContainerWidthRef.current = Math.floor(containerWidth);
      const resolvedPageScale =
        baseViewport.width > 0 ? viewport.width / baseViewport.width : finalScale;
      activePageScaleRef.current = resolvedPageScale;
      setPageScale(resolvedPageScale);

      const task = page.render({
        canvasContext: context,
        viewport,
      });
      await task.promise;
      if (runId !== runRef.current) {
        return;
      }

      const textLayerReady = await renderTextLayer(page, viewport, runId);
      if (runId !== runRef.current) {
        return;
      }

      setTextLayerUsable(textLayerReady);
      setPageNumber(boundedPage);
      clearSelection();
      setError(null);
      setPageRenderEpoch((value) => value + 1);
    },
    [clearSelection, renderTextLayer]
  );

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
        setNumPages(refreshedOpened.doc.numPages);
        await renderPage(refreshedOpened.doc, targetPage, runId);
      } finally {
        if (runId === runRef.current) {
          setRecovering(false);
        }
      }
    },
    [fetchSignedUrl, openDocument, replaceDocument, renderPage]
  );

  const renderCurrentDocumentPage = useCallback(
    async (targetPage: number) => {
      const currentRun = runRef.current;
      const currentDoc = documentRef.current;
      if (!currentDoc) {
        return;
      }

      const expiryMs = signedUrlExpiryRef.current;
      if (
        typeof expiryMs === "number" &&
        Date.now() >= expiryMs - SIGNED_URL_REFRESH_SKEW_MS
      ) {
        try {
          await recoverAndRender(targetPage, currentRun);
          return;
        } catch (recoveryError) {
          setError(toUserFacingError(recoveryError));
          return;
        }
      }

      try {
        await renderPage(currentDoc, targetPage, currentRun);
      } catch (err) {
        if (isLikelySignedUrlExpiryError(err)) {
          try {
            await recoverAndRender(targetPage, currentRun);
            return;
          } catch (recoveryError) {
            setError(toUserFacingError(recoveryError));
            return;
          }
        }
        setError(toUserFacingError(err));
      }
    },
    [recoverAndRender, renderPage]
  );

  const buildSelectionQuads = useCallback((range: Range): PdfHighlightQuad[] => {
    const layerRect = textLayerRef.current?.getBoundingClientRect();
    const pageScaleValue = activePageScaleRef.current;
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
  }, []);

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
        const textLayerRoot = textLayerRef.current;
        if (!isSelectionRangeInTextLayer(range, textLayerRoot)) {
          return null;
        }
        return toSelectionSnapshot(range, textLayerRoot);
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
      const quads = buildSelectionQuads(activeSelection.range);
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
                page_number: pageNumber,
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
              page_number: pageNumber,
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
        await refreshPageHighlights(pageNumber, runRef.current);
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
      selection,
      textLayerUsable,
      isCreating,
      buildSelectionQuads,
      clearSelection,
      editingHighlightId,
      apiFetchDep,
      pageNumber,
      mediaId,
      getSelectionDep,
      refreshPageHighlights,
      updateCreateTelemetry,
    ]
  );

  const goToPage = useCallback(
    async (nextPage: number) => {
      if (!documentRef.current || nextPage < 1 || nextPage > numPages) {
        return;
      }
      setNavigating(true);
      setPageHighlights([]);
      onPageHighlightsChange?.(nextPage, []);
      clearSelection();
      try {
        await renderCurrentDocumentPage(nextPage);
      } finally {
        setNavigating(false);
      }
    },
    [clearSelection, numPages, onPageHighlightsChange, renderCurrentDocumentPage]
  );

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    let active = true;
    const runId = ++runRef.current;

    setLoading(true);
    setNavigating(false);
    setRecovering(false);
    setError(null);
    setPageNumber(1);
    setNumPages(0);
    setZoom(1);
    setPageScale(DEFAULT_PAGE_SCALE);
    setPageRenderEpoch(0);
    setSelection(null);
    setSelectionError(null);
    setPageHighlights([]);
    setTextLayerUsable(false);
    setCreateTelemetry(createInitialCreateTelemetry());

    const bootstrap = async () => {
      try {
        const signedAccess = await fetchSignedUrl();
        if (!active || runId !== runRef.current) {
          return;
        }

        const initialOpened = await openDocument(signedAccess.url);
        if (!active || runId !== runRef.current) {
          await destroyPdfDocument(initialOpened.doc);
          destroyPdfLoadingTask(initialOpened.loadingTask);
          return;
        }

        signedUrlExpiryRef.current = signedAccess.expiresAtMs;
        await replaceDocument(initialOpened);
        setNumPages(initialOpened.doc.numPages);
        await renderPage(initialOpened.doc, 1, runId);
      } catch (err) {
        if (!active || runId !== runRef.current) {
          return;
        }
        setError(toUserFacingError(err));
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
      clearTextLayer();
      const existingDoc = documentRef.current;
      const existingTask = loadingTaskRef.current;
      documentRef.current = null;
      loadingTaskRef.current = null;
      void destroyPdfDocument(existingDoc);
      destroyPdfLoadingTask(existingTask);
    };
  }, [
    clearTextLayer,
    fetchSignedUrl,
    mediaId,
    openDocument,
    renderPage,
    replaceDocument,
  ]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const wrap = internalContentRef.current;
    if (!wrap) {
      return;
    }

    let frameId: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (nextWidth <= 0) {
        return;
      }
      if (!documentRef.current || loading || navigating || recovering || error) {
        return;
      }
      if (Math.abs(nextWidth - lastRenderedContainerWidthRef.current) <= 1) {
        return;
      }

      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        void renderCurrentDocumentPage(pageNumber);
      });
    });

    observer.observe(wrap);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      observer.disconnect();
    };
  }, [error, loading, navigating, pageNumber, recovering, renderCurrentDocumentPage]);

  useEffect(() => {
    if (!documentRef.current || loading || navigating || recovering || error) {
      return;
    }
    void renderCurrentDocumentPage(pageNumber);
  }, [error, loading, navigating, pageNumber, recovering, renderCurrentDocumentPage, zoom]);

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
    const textLayerRoot = textLayerRef.current;
    if (!isSelectionRangeInTextLayer(range, textLayerRoot)) {
      setSelection(null);
      return;
    }

    const selectionText =
      selectedTextFromSelection.length > 0
        ? selectedTextFromSelection
        : range.toString().trim();
    if (selectionText.length === 0) {
      setSelection(null);
      return;
    }
    const snapshot = toSelectionSnapshot(range, textLayerRoot);
    selectionSnapshotRef.current = snapshot;
    setSelection(snapshot);
    setSelectionError(null);
  }, [getSelectionDep, textLayerUsable]);

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
    void OVERLAY_REPROJECTION_TRIGGER_MATRIX;
    if (!textLayerUsable || pageScale <= 0) {
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
          ...projectQuadToRect(quad, pageScale),
        });
      });
    }
    return projected;
  }, [pageHighlights, pageNumber, pageScale, textLayerUsable]);

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

      {recovering && (
        <div className={styles.notice}>Refreshing secure file access…</div>
      )}

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : (
        <div ref={setContentNode} className={styles.canvasWrap}>
          {(loading || navigating) && (
            <div className={styles.loading} role="status">
              Loading PDF…
            </div>
          )}
          <div className={styles.pageLayer}>
            <canvas
              ref={canvasRef}
              className={styles.canvas}
              role="img"
              aria-label="PDF page"
            />
            <div
              ref={textLayerRef}
              className={styles.textLayer}
              onMouseUp={syncSelectionFromWindow}
              onKeyUp={syncSelectionFromWindow}
            />
            <div className={styles.overlayLayer} aria-hidden="true">
              {projectedHighlightRects.map((rect) => (
                <div
                  key={`${rect.highlightId}-${rect.index}`}
                  data-testid={`pdf-highlight-${rect.highlightId}-${rect.index}`}
                  data-highlight-anchor={rect.index === 0 ? rect.highlightId : undefined}
                  data-highlight-color={rect.color}
                  className={`${styles.highlightOverlayRect} ${
                    focusedHighlightId === rect.highlightId
                      ? styles.highlightOverlayRectFocused
                      : ""
                  }`}
                  style={{
                    left: `${rect.left}px`,
                    top: `${rect.top}px`,
                    width: `${rect.width}px`,
                    height: `${rect.height}px`,
                    backgroundColor: OVERLAY_COLOR_MAP[rect.color],
                    mixBlendMode: "multiply",
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {!loading && !error && !textLayerUsable && (
        <div className={styles.notice}>
          Text selection is unavailable on this page.
        </div>
      )}

      {selectionError && (
        <div className={styles.error} role="alert">
          {selectionError}
        </div>
      )}

      {selection && internalContentRef.current && (
        <SelectionPopover
          selectionRect={selection.rect}
          containerRef={internalContentRef}
          onCreateHighlight={handleCreateHighlight}
          onDismiss={clearSelection}
          isCreating={isCreating}
        />
      )}
    </div>
  );
}
