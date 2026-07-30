"use client";

export interface PdfTextItemLike {
  readonly str: string;
  readonly hasEOL: boolean;
}

export interface PdfMarkedContentLike {
  readonly type: string;
  readonly id?: string;
}

export interface PdfTextContentLike {
  readonly items: readonly (PdfTextItemLike | PdfMarkedContentLike)[];
}

export interface PdfPageLike {
  getTextContent(params: {
    includeMarkedContent: true;
    disableNormalization: true;
  }): Promise<PdfTextContentLike>;
  getViewport(params: {
    scale: number;
    rotation?: number;
  }): PdfViewportLike;
}

export interface PdfDocumentLike {
  readonly fingerprints: readonly (string | null)[];
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  destroy?: () => Promise<void> | void;
}

export interface PdfDocumentLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy?: () => void;
}

export interface PdfDocumentSourceLike {
  url: string;
  httpHeaders?: Record<string, string>;
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
  dispatch(eventName: string, event: object): void;
}

export interface PdfLinkServiceLike {
  setDocument(doc: PdfDocumentLike | null, baseUrl?: string | null): void;
  setViewer(viewer: PdfViewerLike): void;
  get page(): number;
  set page(value: number);
  readonly pagesCount: number;
}

export interface PdfFindMatchLike {
  readonly index: number;
  readonly length: number;
}

export interface PdfFindSelectionLike {
  readonly pageIdx: number;
  readonly matchIdx: number;
}

export interface PdfFindStateLike {
  readonly highlightAll: boolean;
}

export interface PdfFindControllerLike {
  readonly highlightMatches: boolean | undefined;
  readonly pageMatches:
    | readonly (readonly number[] | undefined)[]
    | undefined;
  readonly pageMatchesLength:
    | readonly (readonly number[] | undefined)[]
    | undefined;
  readonly selected: PdfFindSelectionLike | undefined;
  readonly state: PdfFindStateLike | null;
  match(
    query: string | string[],
    pageContent: string,
    pageIndex: number,
  ): readonly PdfFindMatchLike[] | undefined;
  setDocument(doc: PdfDocumentLike | null): void;
  scrollMatchIntoView(params: {
    element: HTMLElement;
    pageIndex: number;
    matchIndex: number;
  }): void;
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
  PDFFindController: new (params: {
    linkService: PdfLinkServiceLike;
    eventBus: PdfEventBusLike;
    updateMatchesCountOnProgress?: boolean;
  }) => PdfFindControllerLike;
  PDFViewer: new (params: {
    container: HTMLDivElement;
    viewer: HTMLDivElement;
    eventBus: PdfEventBusLike;
    linkService: PdfLinkServiceLike;
    findController?: PdfFindControllerLike;
    textLayerMode?: number;
    enableAutoLinking?: boolean;
  }) => PdfViewerLike;
  ScrollMode?: { VERTICAL?: number };
  LinkTarget?: { BLANK?: number };
}

export const PDF_WORKER_SRC = "/pdfjs/pdf.worker.min.mjs";

const PDF_VIEWER_MODULE_URL = "/pdfjs/pdf_viewer.mjs";
const PDF_MODULE_URL = "/pdfjs/pdf.mjs";

export async function loadPdfJs(): Promise<PdfJsLike> {
  const pdfJsModule = await import(
    /* @vite-ignore */
    /* webpackIgnore: true */
    PDF_MODULE_URL
  );
  // justify-type-assertion: the static asset is the vendored pdfjs module shape.
  return pdfJsModule as unknown as PdfJsLike;
}

export async function loadPdfJsViewer(): Promise<PdfJsViewerLike> {
  await loadPdfJs();
  const pdfViewerModule = await import(
    /* @vite-ignore */
    /* webpackIgnore: true */
    PDF_VIEWER_MODULE_URL
  );
  // justify-type-assertion: the static asset is the vendored pdfjs viewer module shape.
  return pdfViewerModule as unknown as PdfJsViewerLike;
}

export function getPdfSelection(): Selection | null {
  return window.getSelection();
}
