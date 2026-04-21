import { afterEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import userEvent from "@testing-library/user-event";
import PdfReader, {
  type PdfReaderControlActions,
  type PdfReaderControlsState,
  type PdfReaderDeps,
} from "@/components/PdfReader";
import PaneShell from "@/components/workspace/PaneShell";
import "pdfjs-dist/web/pdf_viewer.css";

afterEach(() => {
  vi.unstubAllGlobals();
});

type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";

interface PdfQuad {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  x4: number;
  y4: number;
}

interface FakePdfLink {
  kind: "internal" | "external";
  label: string;
  pageNumber?: number;
  href?: string;
}

interface FakePdfPageSpec {
  textItems: string[];
  links: FakePdfLink[];
  textLayerScale: number;
}

interface FakePdfDocumentLike {
  numPages: number;
  __pages: FakePdfPageSpec[];
  __renderErrorsByPage: Record<number, unknown>;
  __annotationLayerErrorsByPage: Record<number, unknown>;
  destroy: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function createFakePage(options?: {
  textItems?: string[];
  links?: FakePdfLink[];
  textLayerScale?: number;
}): FakePdfPageSpec {
  return {
    textItems: options?.textItems ?? ["example text"],
    links: options?.links ?? [],
    textLayerScale: options?.textLayerScale ?? 1,
  };
}

function createFakeDocument(
  numPages: number,
  pagesByNumber?: Record<number, FakePdfPageSpec>,
  options?: {
    renderErrorsByPage?: Record<number, unknown>;
    annotationLayerErrorsByPage?: Record<number, unknown>;
  }
): FakePdfDocumentLike {
  const pages: FakePdfPageSpec[] = [];
  for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
    pages.push(pagesByNumber?.[pageNumber] ?? createFakePage());
  }
  return {
    numPages,
    __pages: pages,
    __renderErrorsByPage: options?.renderErrorsByPage ?? {},
    __annotationLayerErrorsByPage: options?.annotationLayerErrorsByPage ?? {},
    destroy: vi.fn(async () => undefined),
  };
}

function makePdfHighlight(
  id: string,
  color: HighlightColor,
  exact: string,
  pageNumber: number,
  quads: PdfQuad[]
) {
  return {
    id,
    anchor: {
      type: "pdf_page_geometry" as const,
      media_id: "media-id",
      page_number: pageNumber,
      quads,
    },
    color,
    exact,
    prefix: "",
    suffix: "",
    annotation: null,
    author_user_id: "user-1",
    is_owner: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

class FakeEventBus {
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  on(eventName: string, listener: (event: unknown) => void) {
    const bucket = this.listeners.get(eventName) ?? new Set<(event: unknown) => void>();
    bucket.add(listener);
    this.listeners.set(eventName, bucket);
  }

  off(eventName: string, listener: (event: unknown) => void) {
    this.listeners.get(eventName)?.delete(listener);
  }

  dispatch(eventName: string, event: unknown) {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(event);
    }
  }
}

class FakePDFLinkService {
  setDocument() {
    // no-op for test shim
  }

  setViewer() {
    // no-op for test shim
  }
}

class FakePDFViewer {
  private static updateCallCount = 0;
  private static _scaleHistory: (string | number)[] = [];
  private static _lastInitOptions: { enableAutoLinking?: boolean } | null = null;

  static resetUpdateCallCount() {
    FakePDFViewer.updateCallCount = 0;
  }

  static getUpdateCallCount() {
    return FakePDFViewer.updateCallCount;
  }

  static resetScaleHistory() {
    FakePDFViewer._scaleHistory = [];
  }

  static getScaleHistory() {
    return FakePDFViewer._scaleHistory;
  }

  static resetLastInitOptions() {
    FakePDFViewer._lastInitOptions = null;
  }

  static getLastInitOptions() {
    return FakePDFViewer._lastInitOptions;
  }

  private readonly container: HTMLDivElement;
  private readonly viewer: HTMLDivElement;
  private readonly eventBus: FakeEventBus;
  private doc: FakePdfDocumentLike | null = null;
  private pageViews = new Map<number, { viewport: { width: number; height: number; scale: number } }>();
  private _currentPageNumber = 1;
  private _currentScaleValue: string | number = 1;
  pagesCount = 0;
  scrollMode = 0;

  constructor(options: {
    container: HTMLDivElement;
    viewer: HTMLDivElement;
    eventBus: FakeEventBus;
    enableAutoLinking?: boolean;
  }) {
    FakePDFViewer._lastInitOptions = options;
    this.container = options.container;
    this.viewer = options.viewer;
    this.eventBus = options.eventBus;
  }

  private normalizedScale(): number {
    if (typeof this._currentScaleValue === "number") {
      return this._currentScaleValue;
    }
    const parsed = Number.parseFloat(this._currentScaleValue);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  private pageDimensionsForScale(scale: number) {
    return {
      width: 800 * scale,
      height: 1100 * scale,
    };
  }

  private setPageTestStructure(pageNumber: number, page: FakePdfPageSpec, scale: number) {
    const pageRoot = document.createElement("div");
    pageRoot.className = "page";
    pageRoot.setAttribute("data-page-number", String(pageNumber));
    pageRoot.style.position = "relative";
    const dims = this.pageDimensionsForScale(scale);
    pageRoot.style.width = `${dims.width}px`;
    pageRoot.style.height = `${dims.height}px`;

    const canvasWrapper = document.createElement("div");
    canvasWrapper.className = "canvasWrapper";
    canvasWrapper.style.width = `${dims.width}px`;
    canvasWrapper.style.height = `${dims.height}px`;
    const canvas = document.createElement("canvas");
    canvas.style.width = `${dims.width}px`;
    canvas.style.height = `${dims.height}px`;
    canvasWrapper.append(canvas);
    pageRoot.append(canvasWrapper);

    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    textLayer.style.position = "absolute";
    textLayer.style.left = "0";
    textLayer.style.top = "0";
    textLayer.style.width = `${dims.width * page.textLayerScale}px`;
    textLayer.style.height = `${dims.height * page.textLayerScale}px`;
    for (const text of page.textItems) {
      const span = document.createElement("span");
      span.textContent = text;
      span.style.position = "absolute";
      span.style.whiteSpace = "pre";
      textLayer.append(span);
      textLayer.append(document.createTextNode(" "));
    }
    pageRoot.append(textLayer);

    const annotationLayer = document.createElement("div");
    annotationLayer.className = "annotationLayer";
    annotationLayer.style.position = "absolute";
    annotationLayer.style.inset = "0";
    for (const link of page.links) {
      const section = document.createElement("section");
      section.className = "linkAnnotation";
      const anchor = document.createElement("a");
      anchor.textContent = link.label;
      if (link.kind === "internal") {
        const destinationPage = link.pageNumber ?? 1;
        anchor.href = `#page=${destinationPage}`;
        anchor.addEventListener("click", (event) => {
          event.preventDefault();
          this.currentPageNumber = destinationPage;
        });
      } else {
        anchor.href = link.href ?? "https://example.com";
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer nofollow";
      }
      section.append(anchor);
      annotationLayer.append(section);
    }
    pageRoot.append(annotationLayer);

    this.viewer.append(pageRoot);
    this.pageViews.set(pageNumber, {
      viewport: {
        ...dims,
        scale,
      },
    });
  }

  private emitPageRendered(pageNumber: number) {
    if (!this.doc) {
      return;
    }
    this.eventBus.dispatch("pagerendered", {
      pageNumber,
      source: this.pageViews.get(pageNumber),
      error: this.doc.__renderErrorsByPage[pageNumber],
    });
    this.eventBus.dispatch("annotationlayerrendered", {
      pageNumber,
      error: this.doc.__annotationLayerErrorsByPage[pageNumber],
    });
  }

  private renderDocumentPages() {
    this.viewer.innerHTML = "";
    this.pageViews.clear();
    if (!this.doc) {
      this.pagesCount = 0;
      return;
    }
    const scale = this.normalizedScale();
    this.pagesCount = this.doc.numPages;
    for (let pageNumber = 1; pageNumber <= this.doc.numPages; pageNumber += 1) {
      this.setPageTestStructure(pageNumber, this.doc.__pages[pageNumber - 1], scale);
    }
  }

  setDocument(doc: FakePdfDocumentLike | null) {
    this.doc = doc;
    this.renderDocumentPages();
    if (!this.doc) {
      this.eventBus.dispatch("pagesloaded", { pagesCount: 0 });
      return;
    }
    this.eventBus.dispatch("pagesloaded", { pagesCount: this.doc.numPages });
    this.currentPageNumber = Math.max(1, Math.min(this._currentPageNumber, this.doc.numPages));
  }

  getPageView(index: number) {
    return this.pageViews.get(index + 1);
  }

  get currentPageNumber() {
    return this._currentPageNumber;
  }

  set currentPageNumber(value: number) {
    if (!this.doc || !Number.isFinite(value)) {
      return;
    }
    const bounded = Math.max(1, Math.min(Math.floor(value), this.doc.numPages));
    const previous = this._currentPageNumber;
    this._currentPageNumber = bounded;
    this.eventBus.dispatch("pagechanging", {
      pageNumber: bounded,
      previous,
    });
    this.emitPageRendered(bounded);
    this.container.scrollTop = (bounded - 1) * this.pageDimensionsForScale(this.normalizedScale()).height;
  }

  get currentScaleValue() {
    return this._currentScaleValue;
  }

  set currentScaleValue(value: string | number) {
    FakePDFViewer._scaleHistory.push(value);
    this._currentScaleValue = value;
    if (!this.doc) {
      return;
    }
    this.renderDocumentPages();
    this.emitPageRendered(this._currentPageNumber);
  }

  update() {
    FakePDFViewer.updateCallCount += 1;
  }
}

function createDeps(options: {
  urls: string[];
  docsByUrl: Record<string, FakePdfDocumentLike>;
  highlightsByPage?: Record<number, Array<ReturnType<typeof makePdfHighlight>>>;
  getSelection?: () => Selection | null;
}): {
  deps: PdfReaderDeps;
  apiFetchMock: ReturnType<typeof vi.fn>;
  getDocumentMock: ReturnType<typeof vi.fn>;
} {
  let fileCallCount = 0;
  const apiFetchImpl: PdfReaderDeps["apiFetch"] = async <T,>(
    path: string,
    init?: RequestInit
  ): Promise<T> => {
    if (/\/api\/media\/[^/]+\/file$/.test(path)) {
      const nextUrl = options.urls[fileCallCount] ?? options.urls[options.urls.length - 1];
      fileCallCount += 1;
      return {
        data: {
          url: nextUrl,
          expires_at: "2030-01-01T00:00:00Z",
        },
      } as T;
    }

    if (/\/api\/media\/[^/]+\/pdf-highlights/.test(path)) {
      if (init?.method === "POST") {
        return {
          data: makePdfHighlight("created-highlight", "yellow", "created", 1, [
            { x1: 72, y1: 100, x2: 140, y2: 100, x3: 140, y3: 112, x4: 72, y4: 112 },
          ]),
        } as T;
      }

      const parsed = new URL(path, "http://localhost");
      const pageNumber = Number(parsed.searchParams.get("page_number") ?? "1");
      return {
        data: {
          page_number: pageNumber,
          highlights: options.highlightsByPage?.[pageNumber] ?? [],
        },
      } as T;
    }

    throw new Error(`Unexpected apiFetch path: ${path}`);
  };
  const apiFetchMock = vi.fn(apiFetchImpl);

  const getDocumentMock = vi.fn((source: { url: string }) => {
    const doc = options.docsByUrl[source.url];
    if (!doc) {
      return { promise: Promise.reject(new Error(`Unknown URL: ${source.url}`)) };
    }
    return { promise: Promise.resolve(doc) };
  });

  const deps: PdfReaderDeps = {
    apiFetch: apiFetchMock as unknown as PdfReaderDeps["apiFetch"],
    loadPdfJs: async () => ({
      getDocument: getDocumentMock,
      GlobalWorkerOptions: { workerSrc: "" },
    }),
    loadPdfJsViewer: async () => ({
      EventBus: FakeEventBus as unknown as PdfReaderDeps["loadPdfJsViewer"] extends () => Promise<infer T>
        ? T extends { EventBus: infer E }
          ? E
          : never
        : never,
      PDFLinkService: FakePDFLinkService as unknown as PdfReaderDeps["loadPdfJsViewer"] extends () => Promise<infer T>
        ? T extends { PDFLinkService: infer L }
          ? L
          : never
        : never,
      PDFViewer: FakePDFViewer as unknown as PdfReaderDeps["loadPdfJsViewer"] extends () => Promise<infer T>
        ? T extends { PDFViewer: infer V }
          ? V
          : never
        : never,
      ScrollMode: { VERTICAL: 0 },
      LinkTarget: { BLANK: 2 },
    }),
    workerSrc: "/pdf.worker.test.mjs",
    getSelection: options.getSelection ?? (() => window.getSelection()),
  };

  return { deps, apiFetchMock, getDocumentMock };
}

function renderPdfReaderWithControls(props: Parameters<typeof PdfReader>[0]) {
  const stateEvents: PdfReaderControlsState[] = [];
  const actionsRef: { current: PdfReaderControlActions | null } = { current: null };

  const renderWithControls = (nextProps: Parameters<typeof PdfReader>[0]) => (
    <PdfReader
      {...nextProps}
      onControlsStateChange={(state) => {
        stateEvents.push(state);
        nextProps.onControlsStateChange?.(state);
      }}
      onControlsReady={(actions) => {
        actionsRef.current = actions;
        nextProps.onControlsReady?.(actions);
      }}
    />
  );

  const view = render(renderWithControls(props));

  return {
    ...view,
    actionsRef,
    stateEvents,
    rerenderWithControls(nextProps: Parameters<typeof PdfReader>[0]) {
      view.rerender(renderWithControls(nextProps));
    },
  };
}

async function expectLatestControlsState(
  stateEvents: PdfReaderControlsState[],
  expected: Partial<PdfReaderControlsState>
) {
  await waitFor(() => {
    expect(stateEvents.at(-1)).toMatchObject(expected);
  });
}

describe("PdfReader", () => {
  it("loads via canonical file endpoint and renders canvas viewer without iframe", async () => {
    const url = "https://storage.example/signed-1";
    const doc = createFakeDocument(3);
    const { deps, apiFetchMock, getDocumentMock } = createDeps({
      urls: [url],
      docsByUrl: { [url]: doc },
    });

    const { stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-1",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 3,
      zoomPercent: 100,
    });
    expect(apiFetchMock).toHaveBeenCalledWith("/api/media/media-1/file");
    expect(getDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ url })
    );
    expect(screen.getByRole("img", { name: "PDF page" })).toBeInTheDocument();
  });

  it("refreshes signed URL and recovers when page load fails with expiry error", async () => {
    const signedUrl1 = "https://storage.example/signed-1";
    const signedUrl2 = "https://storage.example/signed-2";
    const renderExpiryError = new Error("Unexpected server response (403) while loading PDF page");
    (renderExpiryError as { status?: number }).status = 403;
    const firstDoc = createFakeDocument(
      2,
      {
        1: createFakePage({ textItems: ["first page"] }),
        2: createFakePage({ textItems: ["expires on second page"] }),
      },
      {
        renderErrorsByPage: {
          2: renderExpiryError,
        },
      }
    );

    const secondDoc = createFakeDocument(2);

    const { deps, apiFetchMock, getDocumentMock } = createDeps({
      urls: [signedUrl1, signedUrl2],
      docsByUrl: {
        [signedUrl1]: firstDoc,
        [signedUrl2]: secondDoc,
      },
    });

    const { actionsRef, stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-2",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 2,
    });
    expect(actionsRef.current).not.toBeNull();
    actionsRef.current?.goToNextPage();

    await expectLatestControlsState(stateEvents, {
      pageNumber: 2,
      numPages: 2,
    });
    const fileCalls = apiFetchMock.mock.calls.filter(
      ([path]) => path === "/api/media/media-2/file"
    );
    expect(fileCalls).toHaveLength(2);
    expect(getDocumentMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ url: signedUrl1 })
    );
    expect(getDocumentMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ url: signedUrl2 })
    );
  });

  it("shows deterministic non-success state for password-protected PDFs", async () => {
    const signedUrl = "https://storage.example/signed-password";
    const passwordError = new Error("Password required");
    passwordError.name = "PasswordException";

    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: {},
    });

    const loadPdfJs = async () => ({
      getDocument: vi.fn(() => ({ promise: Promise.reject(passwordError) })),
      GlobalWorkerOptions: { workerSrc: "" },
    });

    render(<PdfReader mediaId="media-3" deps={{ ...deps, loadPdfJs }} />);

    expect(
      await screen.findByText(/password-protected and cannot be opened/i)
    ).toBeInTheDocument();
  });

  it("loads page-scoped PDF highlights and renders color-specific overlays", async () => {
    const signedUrl = "https://storage.example/signed-overlay";
    const doc = createFakeDocument(2, {
      1: createFakePage({ textItems: ["alpha beta gamma"] }),
    });
    const pageOneHighlights = [
      makePdfHighlight("h-yellow", "yellow", "alpha", 1, [
        { x1: 72, y1: 120, x2: 140, y2: 120, x3: 140, y3: 132, x4: 72, y4: 132 },
      ]),
      makePdfHighlight("h-blue", "blue", "beta", 1, [
        { x1: 72, y1: 160, x2: 130, y2: 160, x3: 130, y3: 172, x4: 72, y4: 172 },
      ]),
    ];

    const { deps, apiFetchMock } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: pageOneHighlights },
    });

    const { stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-4",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 2,
    });
    await waitFor(() => {
      const pageOneHighlightGets = apiFetchMock.mock.calls.filter(
        ([path, init]) =>
          path === "/api/media/media-4/pdf-highlights?page_number=1&mine_only=false" &&
          (((init as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "GET")
      );
      expect(pageOneHighlightGets).toHaveLength(1);
    });

    const yellowOverlay = await screen.findByTestId("pdf-highlight-h-yellow-0");
    const blueOverlay = await screen.findByTestId("pdf-highlight-h-blue-0");

    expect(yellowOverlay).toHaveAttribute("data-highlight-color", "yellow");
    expect(blueOverlay).toHaveAttribute("data-highlight-color", "blue");
    expect((yellowOverlay as HTMLElement).style.mixBlendMode).toBe("multiply");
    expect((yellowOverlay as HTMLElement).style.backgroundColor).not.toBe(
      (blueOverlay as HTMLElement).style.backgroundColor
    );
  });

  it("exposes interactive overlay controls when highlight tap callback is provided", async () => {
    const user = userEvent.setup();
    const onHighlightTap = vi.fn();
    const signedUrl = "https://storage.example/signed-overlay-tap";
    const doc = createFakeDocument(1, {
      1: createFakePage({ textItems: ["alpha beta gamma"] }),
    });
    const pageOneHighlights = [
      makePdfHighlight("h-tap", "yellow", "alpha", 1, [
        { x1: 72, y1: 120, x2: 140, y2: 120, x3: 140, y3: 132, x4: 72, y4: 132 },
      ]),
    ];

    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: pageOneHighlights },
    });

    render(<PdfReader mediaId="media-tap" deps={deps} onHighlightTap={onHighlightTap} />);

    const overlay = await screen.findByTestId("pdf-highlight-h-tap-0");
    expect(overlay).toHaveAttribute("role", "button");
    expect(overlay).toHaveAttribute("tabindex", "0");

    await user.click(overlay);
    expect(onHighlightTap).toHaveBeenCalledTimes(1);
    expect(onHighlightTap).toHaveBeenCalledWith("h-tap", expect.any(DOMRect));

    fireEvent.keyDown(overlay, { key: "Enter" });
    fireEvent.keyDown(overlay, { key: " " });
    expect(onHighlightTap).toHaveBeenCalledTimes(3);
  });

  it("keeps overlays non-interactive when highlight tap callback is absent", async () => {
    const signedUrl = "https://storage.example/signed-overlay-no-tap";
    const doc = createFakeDocument(1, {
      1: createFakePage({ textItems: ["alpha beta gamma"] }),
    });
    const pageOneHighlights = [
      makePdfHighlight("h-static", "blue", "beta", 1, [
        { x1: 72, y1: 160, x2: 130, y2: 160, x3: 130, y3: 172, x4: 72, y4: 172 },
      ]),
    ];

    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: pageOneHighlights },
    });

    render(<PdfReader mediaId="media-static" deps={deps} />);

    const overlay = await screen.findByTestId("pdf-highlight-h-static-0");
    expect(overlay).not.toHaveAttribute("role");
    expect(overlay).not.toHaveAttribute("tabindex");
  });

  it("captures text-layer selection and posts persistent PDF highlight geometry", async () => {
    const signedUrl = "https://storage.example/signed-create";
    const doc = createFakeDocument(1, {
      1: createFakePage({ textItems: ["lorem ipsum dolor sit amet"] }),
    });
    let selectionForDeps: Selection | null = null;
    const { deps, apiFetchMock } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [] },
      getSelection: () => selectionForDeps,
    });

    const { actionsRef, stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-5",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 1,
      canCreateHighlight: true,
    });
    const textNode = await screen.findByText("lorem ipsum dolor sit amet");
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const syntheticRect = new DOMRect(72, 120, 140, 16);
    const clientRectsSpy = vi
      .spyOn(range, "getClientRects")
      .mockReturnValue([syntheticRect] as unknown as DOMRectList);
    const boundingRectSpy = vi
      .spyOn(range, "getBoundingClientRect")
      .mockReturnValue(syntheticRect);
    selectionForDeps = {
      rangeCount: 1,
      isCollapsed: false,
      toString: () => "lorem ipsum dolor sit amet",
      getRangeAt: () => range,
      removeAllRanges: () => undefined,
      addRange: () => undefined,
    } as unknown as Selection;

    actionsRef.current?.captureSelectionSnapshot();
    actionsRef.current?.createHighlight("yellow");

    await waitFor(() => {
      const hasPostCall = apiFetchMock.mock.calls.some(
        ([path, init]) =>
          path === "/api/media/media-5/pdf-highlights" &&
          (init as RequestInit | undefined)?.method === "POST"
      );
      expect(hasPostCall).toBe(true);
    });

    const postCall = apiFetchMock.mock.calls.find(
      ([path, init]) =>
        path === "/api/media/media-5/pdf-highlights" &&
        (init as RequestInit | undefined)?.method === "POST"
    );

    expect(postCall).toBeDefined();
    const payload = JSON.parse(((postCall?.[1] as RequestInit).body as string) ?? "{}");
    expect(payload.page_number).toBe(1);
    expect(payload.exact).toContain("lorem ipsum");
    expect(payload.quads.length).toBeGreaterThan(0);
    clientRectsSpy.mockRestore();
    boundingRectSpy.mockRestore();
  });

  it("waits for mobile selection stabilization before showing the selection popover", async () => {
    const originalInnerWidth = window.innerWidth;
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));

    const signedUrl = "https://storage.example/signed-mobile-selection-delay";
    const doc = createFakeDocument(1, {
      1: createFakePage({ textItems: ["mobile popup selection target"] }),
    });
    let selectionForDeps: Selection | null = null;
    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [] },
      getSelection: () => selectionForDeps,
    });

    try {
      const { stateEvents } = renderPdfReaderWithControls({
        mediaId: "media-mobile-selection-delay",
        deps,
      });

      await expectLatestControlsState(stateEvents, {
        pageNumber: 1,
        numPages: 1,
        canCreateHighlight: true,
      });

      const textNode = await screen.findByText("mobile popup selection target");
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const syntheticRect = new DOMRect(72, 180, 180, 18);
      const clientRectsSpy = vi
        .spyOn(range, "getClientRects")
        .mockReturnValue([syntheticRect] as unknown as DOMRectList);
      const boundingRectSpy = vi
        .spyOn(range, "getBoundingClientRect")
        .mockReturnValue(syntheticRect);
      selectionForDeps = {
        rangeCount: 1,
        isCollapsed: false,
        toString: () => "mobile popup selection target",
        getRangeAt: () => range,
        removeAllRanges: () => undefined,
        addRange: () => undefined,
      } as unknown as Selection;

      try {
        fireEvent(document, new Event("selectionchange"));
        expect(
          screen.queryByRole("dialog", { name: /highlight actions/i })
        ).not.toBeInTheDocument();

        await new Promise((resolve) => window.setTimeout(resolve, 120));
        expect(
          screen.queryByRole("dialog", { name: /highlight actions/i })
        ).not.toBeInTheDocument();

        await waitFor(() => {
          expect(
            screen.getByRole("dialog", { name: /highlight actions/i })
          ).toBeInTheDocument();
        });
      } finally {
        clientRectsSpy.mockRestore();
        boundingRectSpy.mockRestore();
      }
    } finally {
      vi.stubGlobal("innerWidth", originalInnerWidth);
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("creates a mobile highlight from the retained snapshot after the live selection collapses", async () => {
    const originalInnerWidth = window.innerWidth;
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));

    const signedUrl = "https://storage.example/signed-mobile-selection-retained";
    const doc = createFakeDocument(1, {
      1: createFakePage({ textItems: ["retained mobile selection"] }),
    });
    let selectionForDeps: Selection | null = null;
    const { deps, apiFetchMock } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [] },
      getSelection: () => selectionForDeps,
    });

    try {
      const { stateEvents } = renderPdfReaderWithControls({
        mediaId: "media-mobile-selection-retained",
        deps,
      });

      await expectLatestControlsState(stateEvents, {
        pageNumber: 1,
        numPages: 1,
        canCreateHighlight: true,
      });

      const textNode = await screen.findByText("retained mobile selection");
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const syntheticRect = new DOMRect(84, 210, 170, 20);
      const clientRectsSpy = vi
        .spyOn(range, "getClientRects")
        .mockReturnValue([syntheticRect] as unknown as DOMRectList);
      const boundingRectSpy = vi
        .spyOn(range, "getBoundingClientRect")
        .mockReturnValue(syntheticRect);
      selectionForDeps = {
        rangeCount: 1,
        isCollapsed: false,
        toString: () => "retained mobile selection",
        getRangeAt: () => range,
        removeAllRanges: () => undefined,
        addRange: () => undefined,
      } as unknown as Selection;

      try {
        fireEvent(document, new Event("selectionchange"));

        const popover = await screen.findByRole("dialog", {
          name: /highlight actions/i,
        });
        expect(popover).toBeInTheDocument();

        selectionForDeps = {
          rangeCount: 0,
          isCollapsed: true,
          toString: () => "",
          getRangeAt: () => range,
          removeAllRanges: () => undefined,
          addRange: () => undefined,
        } as unknown as Selection;
        fireEvent(document, new Event("selectionchange"));

        expect(
          screen.getByRole("dialog", { name: /highlight actions/i })
        ).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: /^Yellow/i }));

        await waitFor(() => {
          const hasPostCall = apiFetchMock.mock.calls.some(
            ([path, init]) =>
              path === "/api/media/media-mobile-selection-retained/pdf-highlights" &&
              (init as RequestInit | undefined)?.method === "POST"
          );
          expect(hasPostCall).toBe(true);
        });
      } finally {
        clientRectsSpy.mockRestore();
        boundingRectSpy.mockRestore();
      }
    } finally {
      vi.stubGlobal("innerWidth", originalInnerWidth);
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("reprojects overlays on zoom and refreshes when active page changes", async () => {
    const signedUrl = "https://storage.example/signed-reproject";
    const doc = createFakeDocument(2, {
      1: createFakePage({ textItems: ["page one text"] }),
      2: createFakePage({ textItems: ["page two text"] }),
    });

    const { deps, apiFetchMock } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: {
        1: [
          makePdfHighlight("h-page-1", "purple", "one", 1, [
            { x1: 72, y1: 120, x2: 140, y2: 120, x3: 140, y3: 132, x4: 72, y4: 132 },
          ]),
        ],
        2: [
          makePdfHighlight("h-page-2", "green", "two", 2, [
            { x1: 72, y1: 200, x2: 165, y2: 200, x3: 165, y3: 212, x4: 72, y4: 212 },
          ]),
        ],
      },
    });

    const { actionsRef, stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-6",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 2,
      zoomPercent: 100,
    });
    const page1Overlay = await screen.findByTestId("pdf-highlight-h-page-1-0");
    const widthBeforeZoom = (page1Overlay as HTMLElement).style.width;

    actionsRef.current?.zoomIn();

    await waitFor(() => {
      const widthAfterZoom = (
        screen.getByTestId("pdf-highlight-h-page-1-0") as HTMLElement
      ).style.width;
      expect(widthAfterZoom).not.toBe(widthBeforeZoom);
    });

    actionsRef.current?.goToNextPage();
    await expectLatestControlsState(stateEvents, {
      pageNumber: 2,
      numPages: 2,
    });
    await waitFor(() => {
      const pageTwoHighlightGets = apiFetchMock.mock.calls.filter(
        ([path, init]) =>
          path === "/api/media/media-6/pdf-highlights?page_number=2&mine_only=false" &&
          (((init as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "GET")
      );
      expect(pageTwoHighlightGets).toHaveLength(1);
    });
    expect(await screen.findByTestId("pdf-highlight-h-page-2-0")).toBeInTheDocument();
  });

  it("emits active-page scoped highlight snapshots for linked-items consumers", async () => {
    const signedUrl = "https://storage.example/signed-linked-items";
    const doc = createFakeDocument(2, {
      1: createFakePage({ textItems: ["page one text"] }),
      2: createFakePage({ textItems: ["page two text"] }),
    });
    const onPageHighlightsChange = vi.fn();

    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: {
        1: [
          makePdfHighlight("h-page-1", "yellow", "one", 1, [
            { x1: 72, y1: 120, x2: 140, y2: 120, x3: 140, y3: 132, x4: 72, y4: 132 },
          ]),
        ],
        2: [
          makePdfHighlight("h-page-2", "green", "two", 2, [
            { x1: 72, y1: 200, x2: 165, y2: 200, x3: 165, y3: 212, x4: 72, y4: 212 },
          ]),
        ],
      },
    });

    const { actionsRef, stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-8",
      deps,
      onPageHighlightsChange,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 2,
    });
    await waitFor(() => {
      const calls = onPageHighlightsChange.mock.calls as Array<
        [number, Array<ReturnType<typeof makePdfHighlight>>]
      >;
      const sawPageOneSnapshot = calls.some(
        ([pageNumber, highlights]) =>
          pageNumber === 1 &&
          highlights.length === 1 &&
          highlights[0]?.id === "h-page-1"
      );
      expect(sawPageOneSnapshot).toBe(true);
    });

    actionsRef.current?.goToNextPage();
    await expectLatestControlsState(stateEvents, {
      pageNumber: 2,
      numPages: 2,
    });

    await waitFor(() => {
      const calls = onPageHighlightsChange.mock.calls as Array<
        [number, Array<ReturnType<typeof makePdfHighlight>>]
      >;
      const sawPageTwoReset = calls.some(
        ([pageNumber, highlights]) => pageNumber === 2 && highlights.length === 0
      );
      const sawPageTwoSnapshot = calls.some(
        ([pageNumber, highlights]) =>
          pageNumber === 2 &&
          highlights.length === 1 &&
          highlights[0]?.id === "h-page-2"
      );
      expect(sawPageTwoReset).toBe(true);
      expect(sawPageTwoSnapshot).toBe(true);
    });

    const calls = onPageHighlightsChange.mock.calls as Array<
      [number, Array<ReturnType<typeof makePdfHighlight>>]
    >;
    const latestPageTwoSnapshot = [...calls]
      .reverse()
      .find(([pageNumber]) => pageNumber === 2)?.[1];
    expect(latestPageTwoSnapshot?.map((highlight) => highlight.id)).toEqual([
      "h-page-2",
    ]);
  });

  it("does not reopen the PDF when onPageHighlightsChange callback identity changes", async () => {
    const signedUrl = "https://storage.example/signed-callback-stability";
    const doc = createFakeDocument(1, {
      1: createFakePage({ textItems: ["callback stability text"] }),
    });
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    const { deps, getDocumentMock } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: {
        1: [
          makePdfHighlight("h-stable", "yellow", "stable", 1, [
            { x1: 72, y1: 120, x2: 140, y2: 120, x3: 140, y3: 132, x4: 72, y4: 132 },
          ]),
        ],
      },
    });

    const { rerenderWithControls, stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-stable-callback",
      deps,
      onPageHighlightsChange: firstHandler,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 1,
    });
    await waitFor(() => {
      expect(getDocumentMock).toHaveBeenCalledTimes(1);
    });

    rerenderWithControls({
      mediaId: "media-stable-callback",
      deps,
      onPageHighlightsChange: secondHandler,
    });

    await waitFor(() => {
      expect(stateEvents.at(-1)).toMatchObject({ pageNumber: 1, numPages: 1 });
      expect(getDocumentMock).toHaveBeenCalledTimes(1);
    });
  });

  it("treats start page and zoom as open-time seeds instead of live control props", async () => {
    const signedUrl = "https://storage.example/signed-seed-contract";
    const doc = createFakeDocument(3, {
      1: createFakePage({ textItems: ["page one"] }),
      2: createFakePage({ textItems: ["page two"] }),
      3: createFakePage({ textItems: ["page three"] }),
    });
    const { deps, getDocumentMock } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [], 2: [], 3: [] },
    });

    const { actionsRef, rerenderWithControls, stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-seed-contract",
      deps,
      startPageNumber: 2,
      startZoom: 1.25,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 2,
      numPages: 3,
      zoomPercent: 125,
    });
    await waitFor(() => {
      expect(getDocumentMock).toHaveBeenCalledTimes(1);
    });

    actionsRef.current?.goToNextPage();
    await expectLatestControlsState(stateEvents, {
      pageNumber: 3,
      numPages: 3,
    });
    actionsRef.current?.zoomIn();
    await expectLatestControlsState(stateEvents, {
      pageNumber: 3,
      numPages: 3,
      zoomPercent: 150,
    });

    rerenderWithControls({
      mediaId: "media-seed-contract",
      deps,
      startPageNumber: 1,
      startZoom: 1,
    });

    await waitFor(() => {
      expect(stateEvents.at(-1)).toMatchObject({
        pageNumber: 3,
        numPages: 3,
        zoomPercent: 150,
      });
      expect(getDocumentMock).toHaveBeenCalledTimes(1);
    });
  });

  it("navigates to a requested highlight using projected PDF quad geometry", async () => {
    const signedUrl = "https://storage.example/signed-navigate-highlight";
    const doc = createFakeDocument(2, {
      1: createFakePage({ textItems: ["page one text"] }),
      2: createFakePage({ textItems: ["page two text"] }),
    });
    const targetQuad = {
      x1: 72,
      y1: 320,
      x2: 180,
      y2: 320,
      x3: 180,
      y3: 336,
      x4: 72,
      y4: 336,
    };

    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: {
        1: [],
        2: [makePdfHighlight("h-target", "green", "target", 2, [targetQuad])],
      },
    });

    const { rerenderWithControls, stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-nav",
      deps,
      navigateToHighlight: null,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 2,
    });
    const viewerContainer = screen.getByLabelText("PDF document");
    expect(viewerContainer).toBeInstanceOf(HTMLDivElement);

    rerenderWithControls({
      mediaId: "media-nav",
      deps,
      navigateToHighlight: {
        highlightId: "h-target",
        pageNumber: 2,
        quads: [targetQuad],
      },
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 2,
      numPages: 2,
    });
    await waitFor(() => {
      expect((viewerContainer as HTMLDivElement).scrollTop).toBeGreaterThan(1100);
    });
  });

  it("does not expose false-success highlight creation when page has no usable text layer", async () => {
    const signedUrl = "https://storage.example/signed-no-text";
    const doc = createFakeDocument(1, {
      1: createFakePage({ textItems: [] }),
    });

    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [] },
    });

    const { stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-7",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 1,
      canCreateHighlight: false,
    });
    expect(
      await screen.findByText(/text selection is unavailable on this page/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: /create highlight/i })
    ).not.toBeInTheDocument();
  });

  it("applies pdf.js text-layer positioning contract so text does not collapse to top-left", async () => {
    const signedUrl = "https://storage.example/signed-text-positioning";
    const doc = createFakeDocument(1, {
      1: createFakePage({ textItems: ["positioned text layer"] }),
    });
    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [] },
    });

    const { stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-9",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 1,
    });
    const textSpan = await screen.findByText("positioned text layer");
    const computed = getComputedStyle(textSpan);
    expect(computed.position).toBe("absolute");
    expect(computed.whiteSpace).toBe("pre");
  });

  it("enforces pdf.js content-box sizing even with global border-box reset", async () => {
    const resetStyle = document.createElement("style");
    resetStyle.textContent = "*, *::before, *::after { box-sizing: border-box; }";
    document.head.append(resetStyle);

    try {
      const signedUrl = "https://storage.example/signed-box-sizing";
      const doc = createFakeDocument(1, {
        1: createFakePage({ textItems: ["box sizing sentinel"] }),
      });
      const { deps } = createDeps({
        urls: [signedUrl],
        docsByUrl: { [signedUrl]: doc },
        highlightsByPage: { 1: [] },
      });

      const { stateEvents } = renderPdfReaderWithControls({
        mediaId: "media-12",
        deps,
      });
      await expectLatestControlsState(stateEvents, {
        pageNumber: 1,
        numPages: 1,
      });

      await waitFor(() => {
        expect(getComputedStyle(screen.getByTestId("pdf-page-surface-1")).boxSizing).toBe(
          "content-box"
        );
        expect(getComputedStyle(screen.getByTestId("pdf-page-text-layer-1")).boxSizing).toBe(
          "content-box"
        );
        expect(getComputedStyle(screen.getByTestId("pdf-page-canvas-wrapper-1")).boxSizing).toBe(
          "content-box"
        );
        expect(getComputedStyle(screen.getByTestId("pdf-page-canvas-1")).boxSizing).toBe(
          "content-box"
        );
      });
    } finally {
      resetStyle.remove();
    }
  });

  it("calls viewer update on initial render and zoom changes", async () => {
    FakePDFViewer.resetUpdateCallCount();
    const signedUrl = "https://storage.example/signed-update-calls";
    const doc = createFakeDocument(1, {
      1: createFakePage({ textItems: ["update sentinel"] }),
    });
    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [] },
    });

    const { actionsRef, stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-13",
      deps,
    });
    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 1,
      zoomPercent: 100,
    });
    await waitFor(() => {
      expect(FakePDFViewer.getUpdateCallCount()).toBeGreaterThan(0);
    });

    const updateCallsBeforeZoom = FakePDFViewer.getUpdateCallCount();
    actionsRef.current?.zoomIn();
    await waitFor(() => {
      expect(FakePDFViewer.getUpdateCallCount()).toBeGreaterThan(updateCallsBeforeZoom);
    });
  });

  it("surfaces viewer scale/page lifecycle failures instead of silently swallowing them", async () => {
    class BrokenScalePdfViewer extends FakePDFViewer {
      get currentScaleValue() {
        return 1;
      }

      set currentScaleValue(_value: string | number) {
        throw new Error("scale setter failed");
      }
    }

    const signedUrl = "https://storage.example/signed-broken-scale";
    const doc = createFakeDocument(1);
    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [] },
    });

    const loadPdfJsViewer: PdfReaderDeps["loadPdfJsViewer"] = async () => ({
      EventBus: FakeEventBus as unknown as PdfReaderDeps["loadPdfJsViewer"] extends () => Promise<infer T>
        ? T extends { EventBus: infer E }
          ? E
          : never
        : never,
      PDFLinkService:
        FakePDFLinkService as unknown as PdfReaderDeps["loadPdfJsViewer"] extends () => Promise<infer T>
          ? T extends { PDFLinkService: infer L }
            ? L
            : never
          : never,
      PDFViewer:
        BrokenScalePdfViewer as unknown as PdfReaderDeps["loadPdfJsViewer"] extends () => Promise<infer T>
          ? T extends { PDFViewer: infer V }
            ? V
            : never
          : never,
      ScrollMode: { VERTICAL: 0 },
      LinkTarget: { BLANK: 2 },
    });

    render(<PdfReader mediaId="media-14" deps={{ ...deps, loadPdfJsViewer }} />);

    expect(
      await screen.findByText(/unable to load this pdf right now\. please retry\./i)
    ).toBeInTheDocument();
  });

  it("refreshes signed URL and recovers when annotation layer render fails with expiry error", async () => {
    const signedUrlA = "https://storage.example/signed-annotation-expired";
    const signedUrlB = "https://storage.example/signed-annotation-refreshed";
    const annotationExpiryError = new Error(
      "Unexpected server response (403) while loading annotation layer"
    );
    (annotationExpiryError as { status?: number }).status = 403;
    const expiredDoc = createFakeDocument(
      1,
      {
        1: createFakePage({ textItems: ["expired annotation layer"] }),
      },
      {
        annotationLayerErrorsByPage: {
          1: annotationExpiryError,
        },
      }
    );
    const refreshedDoc = createFakeDocument(1, {
      1: createFakePage({ textItems: ["refreshed annotation layer"] }),
    });
    const { deps, apiFetchMock } = createDeps({
      urls: [signedUrlA, signedUrlB],
      docsByUrl: {
        [signedUrlA]: expiredDoc,
        [signedUrlB]: refreshedDoc,
      },
      highlightsByPage: { 1: [] },
    });

    const { stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-16",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 1,
    });
    expect(await screen.findByText("refreshed annotation layer")).toBeInTheDocument();
    await waitFor(() => {
      const fileCalls = apiFetchMock.mock.calls.filter(([path]) => path === "/api/media/media-16/file");
      expect(fileCalls).toHaveLength(2);
    });
    expect(screen.queryByText(/unable to load this pdf right now\. please retry\./i)).not.toBeInTheDocument();
  });

  it("contains non-expiry annotation layer failures without retrying PDF load", async () => {
    const signedUrl = "https://storage.example/signed-annotation-non-expiry";
    const annotationLayerError = new Error("annotation layer render crashed");
    const doc = createFakeDocument(
      1,
      {
        1: createFakePage({ textItems: ["annotation layer stable page"] }),
      },
      {
        annotationLayerErrorsByPage: {
          1: annotationLayerError,
        },
      }
    );
    const { deps, apiFetchMock } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [] },
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { stateEvents } = renderPdfReaderWithControls({
        mediaId: "media-17",
        deps,
      });

      await expectLatestControlsState(stateEvents, {
        pageNumber: 1,
        numPages: 1,
      });
      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          "PDF annotation layer render failed:",
          annotationLayerError
        );
      });
      const fileCalls = apiFetchMock.mock.calls.filter(([path]) => path === "/api/media/media-17/file");
      expect(fileCalls).toHaveLength(1);
      expect(
        screen.queryByText(/unable to load this pdf right now\. please retry\./i)
      ).not.toBeInTheDocument();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("disables pdf.js auto-link inference in viewer construction", async () => {
    FakePDFViewer.resetLastInitOptions();
    const signedUrl = "https://storage.example/signed-no-autolink";
    const doc = createFakeDocument(1, {
      1: createFakePage({ textItems: ["auto-link toggle check"] }),
    });
    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [] },
    });

    const { stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-18",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 1,
    });
    expect(FakePDFViewer.getLastInitOptions()?.enableAutoLinking).toBe(false);
  });

  it("degrades to area-style geometry when text layer and canvas scale diverge", async () => {
    const signedUrl = "https://storage.example/signed-geometry-drift";
    const doc = createFakeDocument(1, {
      1: createFakePage({
        textItems: ["geometry drift sentinel"],
        textLayerScale: 1.08,
      }),
    });

    let selectionForDeps: Selection | null = null;
    const { deps, apiFetchMock } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [] },
      getSelection: () => selectionForDeps,
    });

    const { actionsRef, stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-15",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 1,
      canCreateHighlight: true,
    });
    const textNode = await screen.findByText("geometry drift sentinel");
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const syntheticRect = new DOMRect(84, 160, 180, 18);
    const clientRectsSpy = vi
      .spyOn(range, "getClientRects")
      .mockReturnValue([syntheticRect] as unknown as DOMRectList);
    const boundingRectSpy = vi
      .spyOn(range, "getBoundingClientRect")
      .mockReturnValue(syntheticRect);
    selectionForDeps = {
      rangeCount: 1,
      isCollapsed: false,
      toString: () => "geometry drift sentinel",
      getRangeAt: () => range,
      removeAllRanges: () => undefined,
      addRange: () => undefined,
    } as unknown as Selection;

    try {
      actionsRef.current?.captureSelectionSnapshot();
      actionsRef.current?.createHighlight("yellow");

      await waitFor(() => {
        const hasPostCall = apiFetchMock.mock.calls.some(
          ([path, init]) =>
            path === "/api/media/media-15/pdf-highlights" &&
            (init as RequestInit | undefined)?.method === "POST"
        );
        expect(hasPostCall).toBe(true);
      });

      const postCall = apiFetchMock.mock.calls.find(
        ([path, init]) =>
          path === "/api/media/media-15/pdf-highlights" &&
          (init as RequestInit | undefined)?.method === "POST"
      );
      expect(postCall).toBeDefined();
      const payload = JSON.parse(((postCall?.[1] as RequestInit).body as string) ?? "{}");
      expect(payload.exact).toBe("");
      expect(payload.quads.length).toBeGreaterThan(0);
      expect(
        await screen.findByText(/text geometry is misaligned on this page/i)
      ).toBeInTheDocument();
    } finally {
      clientRectsSpy.mockRestore();
      boundingRectSpy.mockRestore();
    }
  });

  it("renders PDF link annotations for internal and external links", async () => {
    const signedUrl = "https://storage.example/signed-links";
    const doc = createFakeDocument(2, {
      1: createFakePage({
        textItems: ["page with links"],
        links: [
          {
            kind: "internal",
            label: "Internal destination: page 2",
            pageNumber: 2,
          },
          {
            kind: "external",
            label: "External reference",
            href: "https://example.com/reference",
          },
        ],
      }),
      2: createFakePage({ textItems: ["target page"] }),
    });
    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [] },
    });

    const { stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-10",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 2,
    });
    expect(
      screen.getByRole("link", { name: /internal destination: page 2/i })
    ).toBeInTheDocument();
    const external = screen.getByRole("link", { name: /external reference/i });
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute("href", "https://example.com/reference");
  });

  it("renders pages in continuous scroll mode instead of single-page-only mode", async () => {
    const signedUrl = "https://storage.example/signed-continuous";
    const doc = createFakeDocument(3, {
      1: createFakePage({ textItems: ["page one"] }),
      2: createFakePage({ textItems: ["page two"] }),
      3: createFakePage({ textItems: ["page three"] }),
    });
    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [] },
    });

    const { stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-11",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 3,
    });
    await waitFor(() => {
      expect(screen.getAllByTestId(/^pdf-page-surface-/)).toHaveLength(3);
    });
  });

  it("exposes external header controls through callbacks with no inline toolbar", async () => {
    const signedUrl = "https://storage.example/signed-external-controls";
    const doc = createFakeDocument(2, {
      1: createFakePage({ textItems: ["external controls page one"] }),
      2: createFakePage({ textItems: ["external controls page two"] }),
    });
    const { deps } = createDeps({
      urls: [signedUrl],
      docsByUrl: { [signedUrl]: doc },
      highlightsByPage: { 1: [], 2: [] },
    });

    const stateEvents: Array<{
      pageNumber: number;
      numPages: number;
      zoomPercent: number;
      canGoNext: boolean;
      canCreateHighlight: boolean;
      highlightLabel: string;
      createTelemetry: { attempts: number };
    }> = [];
    const actionsRef: {
      current:
        | {
            goToNextPage: () => void;
            zoomIn: () => void;
            createHighlight: () => void;
          }
        | null;
    } = { current: null };

    render(
      <PdfReader
        mediaId="media-12"
        deps={deps}
        onControlsStateChange={(state) => stateEvents.push(state)}
        onControlsReady={(next) => {
          actionsRef.current = next;
        }}
      />
    );

    expect(screen.queryByRole("button", { name: /next page/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /zoom in/i })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(stateEvents.length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      const latest = stateEvents.at(-1);
      expect(latest?.numPages).toBe(2);
      expect(latest?.canGoNext).toBe(true);
      expect(actionsRef.current).not.toBeNull();
    });
    expect(stateEvents.at(-1)?.pageNumber).toBe(1);
    expect(stateEvents.at(-1)?.highlightLabel).toMatch(/highlight/i);

    actionsRef.current?.goToNextPage();
    await waitFor(() => {
      expect(stateEvents.at(-1)?.pageNumber).toBe(2);
    });

    const zoomBefore = stateEvents.at(-1)?.zoomPercent ?? 0;
    actionsRef.current?.zoomIn();
    await waitFor(() => {
      expect((stateEvents.at(-1)?.zoomPercent ?? 0) >= zoomBefore).toBe(true);
    });

    const attemptsBefore = stateEvents.at(-1)?.createTelemetry.attempts ?? 0;
    actionsRef.current?.createHighlight();
    await waitFor(() => {
      expect((stateEvents.at(-1)?.createTelemetry.attempts ?? 0) >= attemptsBefore + 1).toBe(true);
    });
  });

  it("uses page-width scale mode on mobile viewport instead of numeric zoom", async () => {
    const originalInnerWidth = window.innerWidth;
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));
    FakePDFViewer.resetScaleHistory();

    const url = "https://storage.example/signed-mobile-fit";
    const doc = createFakeDocument(1);
    const { deps } = createDeps({
      urls: [url],
      docsByUrl: { [url]: doc },
    });

    const { stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-mobile-fit",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 1,
    });
    const scaleHistory = FakePDFViewer.getScaleHistory();
    expect(
      scaleHistory.some((v) => v === "page-width"),
      `Expected "page-width" in scale history but got: [${scaleHistory.join(", ")}]`
    ).toBe(true);

    vi.stubGlobal("innerWidth", originalInnerWidth);
    window.dispatchEvent(new Event("resize"));
  });

  it("forwards mobile PDF scroll events to the pane chrome scroll handler", async () => {
    const originalInnerWidth = window.innerWidth;
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));

    const url = "https://storage.example/signed-mobile-chrome";
    const doc = createFakeDocument(1);
    const { deps } = createDeps({
      urls: [url],
      docsByUrl: { [url]: doc },
    });
    const onResizePane = vi.fn();

    try {
      const { container } = render(
        createElement(
          PaneShell,
          {
            paneId: "pane-mobile-chrome",
            title: "Reader",
            widthPx: 480,
            minWidthPx: 280,
            maxWidthPx: 900,
            bodyMode: "document",
            onResizePane,
            isMobile: true,
          },
          createElement(PdfReader, { mediaId: "media-mobile-chrome", deps })
        )
      );

      const viewerContainer = await screen.findByLabelText("PDF document");
      viewerContainer.scrollTop = 260;
      fireEvent.scroll(viewerContainer);

      await waitFor(() => {
        expect(container.querySelector('[data-pane-shell="true"]')).toHaveAttribute(
          "data-mobile-chrome-hidden",
          "true"
        );
      });
    } finally {
      vi.stubGlobal("innerWidth", originalInnerWidth);
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("keeps mobile chrome visible when reduced motion is preferred", async () => {
    const originalInnerWidth = window.innerWidth;
    vi.stubGlobal("innerWidth", 390);
    window.dispatchEvent(new Event("resize"));
    stubMatchMedia(true);

    const url = "https://storage.example/signed-reduced-motion";
    const doc = createFakeDocument(1);
    const { deps } = createDeps({
      urls: [url],
      docsByUrl: { [url]: doc },
    });
    const onResizePane = vi.fn();

    try {
      const { container } = render(
        createElement(
          PaneShell,
          {
            paneId: "pane-reduced-motion",
            title: "Reader",
            widthPx: 480,
            minWidthPx: 280,
            maxWidthPx: 900,
            bodyMode: "document",
            onResizePane,
            isMobile: true,
          },
          createElement(PdfReader, { mediaId: "media-reduced-motion", deps })
        )
      );

      await screen.findByLabelText("PDF document");
      await waitFor(() => {
        expect(container.querySelector('[data-pane-shell="true"]')).toHaveAttribute(
          "data-mobile-chrome-hidden",
          "false"
        );
      });

      const viewerContainer = screen.getByLabelText("PDF document");
      viewerContainer.scrollTop = 280;
      fireEvent.scroll(viewerContainer);

      expect(container.querySelector('[data-pane-shell="true"]')).toHaveAttribute(
        "data-mobile-chrome-hidden",
        "false"
      );
    } finally {
      vi.stubGlobal("innerWidth", originalInnerWidth);
      window.dispatchEvent(new Event("resize"));
    }
  });

  it("applies minimum width to PDF viewport element", async () => {
    const url = "https://storage.example/signed-minw";
    const doc = createFakeDocument(1);
    const { deps } = createDeps({
      urls: [url],
      docsByUrl: { [url]: doc },
    });

    const { stateEvents } = renderPdfReaderWithControls({
      mediaId: "media-minw",
      deps,
    });

    await expectLatestControlsState(stateEvents, {
      pageNumber: 1,
      numPages: 1,
    });
    expect(screen.getByRole("img", { name: "PDF page" })).toBeInTheDocument();
    const viewport = screen.getByTestId("pdf-viewport");
    const computedMinWidth = getComputedStyle(viewport).minWidth;
    expect(
      parseInt(computedMinWidth, 10),
      `Expected min-width >= 280px but got: ${computedMinWidth}`
    ).toBeGreaterThanOrEqual(280);
  });
});
