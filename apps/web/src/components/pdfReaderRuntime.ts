"use client";

export interface PdfDocumentLike {
  numPages: number;
  destroy?: () => Promise<void> | void;
}

export interface PdfDocumentLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy?: () => void;
}

export interface PdfDocumentSourceLike {
  url: string;
  withCredentials?: boolean;
  disableRange?: boolean;
  disableStream?: boolean;
  disableAutoFetch?: boolean;
}

export interface PdfGlobalWorkerOptionsLike {
  workerSrc: string;
}

export interface PdfJsLike {
  getDocument(source: PdfDocumentSourceLike): PdfDocumentLoadingTaskLike;
  GlobalWorkerOptions: PdfGlobalWorkerOptionsLike;
}

export interface PdfViewportLike {
  width: number;
  height: number;
  scale?: number;
  rotation?: number;
}

export interface PdfPageViewLike {
  viewport?: PdfViewportLike;
  pdfPage?: {
    getViewport(params: { scale: number; rotation?: number }): PdfViewportLike;
  };
}

export interface PdfEventBusLike {
  on(eventName: string, listener: (event: unknown) => void): void;
  off(eventName: string, listener: (event: unknown) => void): void;
}

export interface PdfLinkServiceLike {
  setDocument(doc: PdfDocumentLike | null, baseUrl?: string | null): void;
  setViewer(viewer: PdfViewerLike): void;
}

export interface PdfViewerLike {
  setDocument(doc: PdfDocumentLike | null): void;
  currentPageNumber: number;
  currentScaleValue: string | number;
  pagesCount: number;
  update?: () => void;
  scrollMode?: number;
  getPageView?: (index: number) => PdfPageViewLike | undefined;
}

export interface PdfJsViewerLike {
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
    enableAutoLinking?: boolean;
  }) => PdfViewerLike;
  ScrollMode?: { VERTICAL?: number };
  LinkTarget?: { BLANK?: number };
}

export const PDF_WORKER_SRC = "/api/pdfjs/worker";

const PDF_VIEWER_MODULE_URL = "/api/pdfjs/viewer";
const PDF_MODULE_URL = "/api/pdfjs/module";

export async function loadPdfJs(): Promise<PdfJsLike> {
  const pdfJsModule = await import(
    /* @vite-ignore */
    /* webpackIgnore: true */
    PDF_MODULE_URL
  );
  return pdfJsModule as unknown as PdfJsLike;
}

export async function loadPdfJsViewer(): Promise<PdfJsViewerLike> {
  const pdfViewerModule = await import(
    /* @vite-ignore */
    /* webpackIgnore: true */
    PDF_VIEWER_MODULE_URL
  );
  return pdfViewerModule as unknown as PdfJsViewerLike;
}

export function getPdfSelection(): Selection | null {
  return window.getSelection();
}
