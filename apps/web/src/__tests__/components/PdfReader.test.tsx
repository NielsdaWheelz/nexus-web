import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PdfReader, { type PdfReaderDeps } from "@/components/PdfReader";
import "pdfjs-dist/web/pdf_viewer.css";

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
}

interface FakePdfDocumentLike {
  numPages: number;
  __pages: FakePdfPageSpec[];
  __renderErrorsByPage: Record<number, unknown>;
  destroy: ReturnType<typeof vi.fn>;
}

function createFakePage(options?: {
  textItems?: string[];
  links?: FakePdfLink[];
}): FakePdfPageSpec {
  return {
    textItems: options?.textItems ?? ["example text"],
    links: options?.links ?? [],
  };
}

function createFakeDocument(
  numPages: number,
  pagesByNumber?: Record<number, FakePdfPageSpec>,
  options?: { renderErrorsByPage?: Record<number, unknown> }
): FakePdfDocumentLike {
  const pages: FakePdfPageSpec[] = [];
  for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
    pages.push(pagesByNumber?.[pageNumber] ?? createFakePage());
  }
  return {
    numPages,
    __pages: pages,
    __renderErrorsByPage: options?.renderErrorsByPage ?? {},
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
  }) {
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

    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    textLayer.style.position = "absolute";
    textLayer.style.inset = "0";
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
    this._currentScaleValue = value;
    if (!this.doc) {
      return;
    }
    this.renderDocumentPages();
    this.emitPageRendered(this._currentPageNumber);
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

describe("PdfReader", () => {
  it("loads via canonical file endpoint and renders canvas viewer without iframe", async () => {
    const url = "https://storage.example/signed-1";
    const doc = createFakeDocument(3);
    const { deps, apiFetchMock, getDocumentMock } = createDeps({
      urls: [url],
      docsByUrl: { [url]: doc },
    });

    render(<PdfReader mediaId="media-1" deps={deps} />);

    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
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

    render(<PdfReader mediaId="media-2" deps={deps} />);

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /next page/i }));

    expect(await screen.findByText("Page 2 of 2")).toBeInTheDocument();
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

    render(<PdfReader mediaId="media-4" deps={deps} />);

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
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

    render(<PdfReader mediaId="media-5" deps={deps} />);

    expect(await screen.findByText("Page 1 of 1")).toBeInTheDocument();
    const textNode = await screen.findByText("lorem ipsum dolor sit amet");
    const range = document.createRange();
    const rawText = textNode.firstChild;
    if (!rawText) {
      throw new Error("Expected text-layer span to include a text node");
    }
    range.setStart(rawText, 0);
    range.setEnd(rawText, rawText.textContent?.length ?? 0);
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

    fireEvent.click(screen.getByRole("button", { name: /highlight selection/i }));

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

    render(<PdfReader mediaId="media-6" deps={deps} />);

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    const page1Overlay = await screen.findByTestId("pdf-highlight-h-page-1-0");
    const widthBeforeZoom = (page1Overlay as HTMLElement).style.width;

    await userEvent.click(screen.getByRole("button", { name: /zoom in/i }));

    await waitFor(() => {
      const widthAfterZoom = (
        screen.getByTestId("pdf-highlight-h-page-1-0") as HTMLElement
      ).style.width;
      expect(widthAfterZoom).not.toBe(widthBeforeZoom);
    });

    await userEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(await screen.findByText("Page 2 of 2")).toBeInTheDocument();
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

    render(
      <PdfReader
        mediaId="media-8"
        deps={deps}
        onPageHighlightsChange={onPageHighlightsChange}
      />
    );

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
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

    await userEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(await screen.findByText("Page 2 of 2")).toBeInTheDocument();

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

    render(<PdfReader mediaId="media-7" deps={deps} />);

    expect(await screen.findByText("Page 1 of 1")).toBeInTheDocument();
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

    render(<PdfReader mediaId="media-9" deps={deps} />);

    expect(await screen.findByText("Page 1 of 1")).toBeInTheDocument();
    const textSpan = await screen.findByText("positioned text layer");
    const computed = getComputedStyle(textSpan);
    expect(computed.position).toBe("absolute");
    expect(computed.whiteSpace).toBe("pre");
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

    render(<PdfReader mediaId="media-10" deps={deps} />);

    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
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

    render(<PdfReader mediaId="media-11" deps={deps} />);

    expect(await screen.findByText("Page 1 of 3")).toBeInTheDocument();
    await waitFor(() => {
      const renderedPages = document.querySelectorAll('[data-testid^="pdf-page-surface-"]');
      expect(renderedPages.length).toBe(3);
    });
  });
});
