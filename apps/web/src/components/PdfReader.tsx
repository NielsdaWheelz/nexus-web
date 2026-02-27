"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, isApiError } from "@/lib/api/client";
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

interface PdfViewportLike {
  width: number;
  height: number;
}

interface PdfRenderTaskLike {
  promise: Promise<unknown>;
}

interface PdfPageLike {
  getViewport(params: { scale: number }): PdfViewportLike;
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

export interface PdfJsLike {
  getDocument(source: PdfDocumentSourceLike): PdfDocumentLoadingTaskLike;
  GlobalWorkerOptions: PdfGlobalWorkerOptionsLike;
}

type ApiFetchLike = <T>(path: string, options?: RequestInit) => Promise<T>;

export interface PdfReaderDeps {
  apiFetch: ApiFetchLike;
  loadPdfJs: () => Promise<PdfJsLike>;
  workerSrc: string;
}

interface PdfReaderProps {
  mediaId: string;
  deps?: Partial<PdfReaderDeps>;
}

const DEFAULT_WORKER_SRC = "/api/pdfjs/worker";
const SIGNED_URL_REFRESH_SKEW_MS = 2_000;
const DEFAULT_PAGE_SCALE = 1.3;
const MIN_PAGE_SCALE = 0.25;

async function defaultLoadPdfJs(): Promise<PdfJsLike> {
  const moduleUrl = "/api/pdfjs/module";
  const pdfJsModule = await import(
    /* @vite-ignore */
    /* webpackIgnore: true */
    moduleUrl
  );
  return pdfJsModule as unknown as PdfJsLike;
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

export default function PdfReader({ mediaId, deps }: PdfReaderProps) {
  const [loading, setLoading] = useState(true);
  const [navigating, setNavigating] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [numPages, setNumPages] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const documentRef = useRef<PdfDocumentLike | null>(null);
  const loadingTaskRef = useRef<PdfDocumentLoadingTaskLike | null>(null);
  const lastRenderedContainerWidthRef = useRef(0);
  const pdfJsRef = useRef<PdfJsLike | null>(null);
  const signedUrlExpiryRef = useRef<number | null>(null);
  const runRef = useRef(0);

  const apiFetchDep = deps?.apiFetch ?? apiFetch;
  const loadPdfJsDep = deps?.loadPdfJs ?? defaultLoadPdfJs;
  const workerSrcDep = deps?.workerSrc ?? DEFAULT_WORKER_SRC;

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
        canvasWrapRef.current?.clientWidth ?? canvas.parentElement?.clientWidth ?? 0;
      const fitScale =
        containerWidth > 0 && baseViewport.width > 0
          ? Math.max(MIN_PAGE_SCALE, containerWidth / baseViewport.width)
          : DEFAULT_PAGE_SCALE;
      const viewport =
        fitScale === 1 ? baseViewport : page.getViewport({ scale: fitScale });

      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("2D canvas context is unavailable");
      }

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      lastRenderedContainerWidthRef.current = Math.floor(containerWidth);

      const task = page.render({
        canvasContext: context,
        viewport,
      });

      await task.promise;

      if (runId !== runRef.current) {
        return;
      }

      setPageNumber(boundedPage);
      setError(null);
    },
    []
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

  useEffect(() => {
    let active = true;
    const runId = ++runRef.current;

    setLoading(true);
    setNavigating(false);
    setRecovering(false);
    setError(null);
    setPageNumber(1);
    setNumPages(0);

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
      const existingDoc = documentRef.current;
      const existingTask = loadingTaskRef.current;
      documentRef.current = null;
      loadingTaskRef.current = null;
      void destroyPdfDocument(existingDoc);
      destroyPdfLoadingTask(existingTask);
    };
  }, [fetchSignedUrl, mediaId, openDocument, renderPage, replaceDocument]);

  const goToPage = useCallback(
    async (nextPage: number) => {
      if (!documentRef.current || nextPage < 1 || nextPage > numPages) {
        return;
      }
      setNavigating(true);
      try {
        await renderCurrentDocumentPage(nextPage);
      } finally {
        setNavigating(false);
      }
    },
    [numPages, renderCurrentDocumentPage]
  );

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const wrap = canvasWrapRef.current;
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

  const showBusy = loading || navigating || recovering;

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
      </div>

      {recovering && (
        <div className={styles.notice}>Refreshing secure file access…</div>
      )}

      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : (
        <div ref={canvasWrapRef} className={styles.canvasWrap}>
          {(loading || navigating) && (
            <div className={styles.loading} role="status">
              Loading PDF…
            </div>
          )}
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            role="img"
            aria-label="PDF page"
          />
        </div>
      )}
    </div>
  );
}
