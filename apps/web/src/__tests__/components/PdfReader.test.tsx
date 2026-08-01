import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef, useRef, type ComponentProps } from "react";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import PdfReaderImplementation from "@/components/PdfReader";
import type { PdfReaderControlActions } from "@/components/PdfReader";
import type {
  PdfFindRuntime,
  PdfRuntimeFindResult,
} from "@/components/pdfPaneFind";
import { isPdfFindSourceAccessRefreshAbort } from "@/components/pdfPaneFind";
import { apiFetch } from "@/lib/api/client";
import { dispatchReaderPulse } from "@/lib/reader/pulseEvent";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  MobileChromeProvider,
  useMobileChrome,
  useMobileChromeSurface,
} from "@/lib/workspace/mobileChrome";

const pdfRuntimeState = vi.hoisted(() => ({
  eventBus: null as null | {
    dispatch: (eventName: string, event: unknown) => void;
  },
  viewerHost: null as HTMLDivElement | null,
  textNode: null as Text | null,
  numPages: 1,
  pageWidths: [600] as number[],
  viewportScaleMultiplier: 1,
  pageBorderTop: 0,
  pageTexts: ["Alpha selected quote Omega"] as string[],
  pageHighlights: [] as unknown[],
  createdHighlightId: "created-highlight-1",
}));

type PdfReaderProps = ComponentProps<typeof PdfReaderImplementation>;
const MOBILE_CHROME_COLLAPSE_PROPERTY = "--mobile-chrome-collapse";

function MobileChromeBehaviorProbe() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { motionPhase } = useMobileChrome();
  const isMobile = useIsMobileViewport();
  useMobileChromeSurface(surfaceRef, "AppBar", true);
  return (
    <div
      ref={surfaceRef}
      data-testid="mobile-chrome-behavior-probe"
      data-mobile={isMobile ? "true" : "false"}
      data-motion-phase={motionPhase.kind}
    />
  );
}

function PdfReader({
  mobileChromeEnabled = true,
  ...props
}: Omit<PdfReaderProps, "mobileChromeEnabled"> & {
  mobileChromeEnabled?: boolean;
}) {
  return (
    <MobileChromeProvider>
      <PdfReaderImplementation
        mobileChromeEnabled={mobileChromeEnabled}
        {...props}
      />
      <MobileChromeBehaviorProbe />
    </MobileChromeProvider>
  );
}

vi.mock("@/lib/sharing/controller", () => ({
  useShareController: () => ({
    openShare: vi.fn(),
    closeShare: vi.fn(),
  }),
}));

function rectList(rects: DOMRect[]): DOMRectList {
  return Object.assign(rects, {
    item: (index: number) => rects[index] ?? null,
  }) as unknown as DOMRectList;
}

function prepareScrollableReader(viewport: HTMLElement): void {
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 400 },
  });
  viewport.scrollTop = 0;
}

vi.mock("@/lib/api/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api/client")>(
      "@/lib/api/client",
    );
  return {
    ...actual,
    ApiError: class ApiError extends Error {},
    isApiError: (error: unknown) =>
      error instanceof Error && error.name === "ApiError",
    isUnauthenticatedApiError: () => false,
    apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/media/media-1/file" || path === "/api/media/media-2/file") {
        return {
          data: {
            url: "https://example.test/document.pdf",
            expires_at: "2099-01-01T00:00:00.000Z",
          },
        };
      }

      if (
        (path.startsWith("/api/media/media-1/pdf-highlights?") ||
          path.startsWith("/api/media/media-2/pdf-highlights?")) &&
        (init?.method ?? "GET") === "GET"
      ) {
        const params = new URLSearchParams(path.split("?")[1] ?? "");
        const pageNumber = Number(params.get("page_number") ?? "1");
        return {
          data: {
            page_number: pageNumber,
            highlights: pdfRuntimeState.pageHighlights.filter(
              (highlight) =>
                typeof highlight === "object" &&
                highlight !== null &&
                "anchor" in highlight &&
                typeof highlight.anchor === "object" &&
                highlight.anchor !== null &&
                "page_number" in highlight.anchor &&
                highlight.anchor.page_number === pageNumber,
            ),
          },
        };
      }

      if (
        path === "/api/media/media-1/pdf-highlights" &&
        init?.method === "POST"
      ) {
        return {
          data: {
            id: pdfRuntimeState.createdHighlightId,
            anchor: {
              type: "pdf_page_geometry",
              media_id: "media-1",
              page_number: 1,
              quads: [],
            },
            color: "yellow",
            exact: "selected quote",
            prefix: "",
            suffix: "",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
            author_user_id: "user-1",
            is_owner: true,
          },
        };
      }

      throw new Error(`Unexpected apiFetch call: ${path}`);
    }),
  };
});

vi.mock("@/components/pdfReaderRuntime", () => {
  class FakeEventBus {
    private listeners = new Map<string, Array<(event: unknown) => void>>();

    constructor() {
      pdfRuntimeState.eventBus = {
        dispatch: (eventName: string, event: unknown) => {
          this.dispatch(eventName, event);
        },
      };
    }

    dispatch(eventName: string, event: unknown) {
      this.listeners.get(eventName)?.forEach((listener) => listener(event));
    }

    on(eventName: string, listener: (event: unknown) => void) {
      const listeners = this.listeners.get(eventName) ?? [];
      listeners.push(listener);
      this.listeners.set(eventName, listeners);
    }

    off(eventName: string, listener: (event: unknown) => void) {
      const listeners = this.listeners.get(eventName) ?? [];
      this.listeners.set(
        eventName,
        listeners.filter((candidate) => candidate !== listener),
      );
    }
  }

  class FakePDFLinkService {
    private document: { numPages: number } | null = null;
    private viewer: FakePDFViewer | null = null;

    get page() {
      return this.viewer?.currentPageNumber ?? 1;
    }

    set page(value: number) {
      if (this.viewer) {
        this.viewer.currentPageNumber = value;
      }
    }

    get pagesCount() {
      return this.document?.numPages ?? 0;
    }

    setDocument(document: { numPages: number } | null) {
      this.document = document;
    }

    setViewer(viewer: FakePDFViewer) {
      this.viewer = viewer;
    }
  }

  class FakePDFFindController {
    highlightMatches = false;
    pageMatches: number[][] = [];
    pageMatchesLength: number[][] = [];
    state: { highlightAll: boolean } | null = null;
    private document: { numPages: number } | null = null;

    constructor({
      eventBus,
    }: {
      eventBus: FakeEventBus;
    }) {
      eventBus.on("find", (rawEvent) => {
        const event = rawEvent as {
          query?: string;
          caseSensitive?: boolean;
          entireWord?: boolean;
          highlightAll?: boolean;
        };
        const query = event.query ?? "";
        this.state = { highlightAll: event.highlightAll ?? false };
        this.highlightMatches = this.state.highlightAll;
        this.pageMatches = [];
        this.pageMatchesLength = [];
        let total = 0;
        for (
          let pageIndex = 0;
          pageIndex < (this.document?.numPages ?? 0);
          pageIndex += 1
        ) {
          const matches = this.match(
            query,
            pdfRuntimeState.pageTexts[pageIndex] ?? "",
            pageIndex,
          );
          const starts = (matches ?? []).map((match) => match.index);
          const lengths = (matches ?? []).map((match) => match.length);
          this.pageMatches.push(starts);
          this.pageMatchesLength.push(lengths);
          total += starts.length;
        }
        eventBus.dispatch("updatefindmatchescount", {
          source: this,
          matchesCount: { current: total > 0 ? 1 : 0, total },
        });
      });
    }

    get selected() {
      return { pageIdx: -1, matchIdx: -1 };
    }

    match(
      query: string | string[],
      pageContent: string,
      _pageIndex: number,
    ) {
      const needle = Array.isArray(query) ? query.join("") : query;
      if (needle.length === 0) {
        return [];
      }
      const starts: { index: number; length: number }[] = [];
      let offset = 0;
      while (offset <= pageContent.length - needle.length) {
        const index = pageContent.indexOf(needle, offset);
        if (index < 0) {
          break;
        }
        starts.push({ index, length: needle.length });
        offset = index + needle.length;
      }
      return starts;
    }

    setDocument(document: { numPages: number } | null) {
      this.document = document;
      this.pageMatches = [];
      this.pageMatchesLength = [];
    }

    scrollMatchIntoView({
      element,
    }: {
      element: HTMLElement;
      pageIndex: number;
      matchIndex: number;
    }) {
      element.scrollIntoView();
    }
  }

  class FakePDFViewer {
    private pageNumber = 1;
    private scale = 1;
    pagesCount = 0;
    private readonly container: HTMLDivElement;
    private readonly eventBus: FakeEventBus;

    constructor({
      container,
      viewer,
      eventBus,
    }: {
      container: HTMLDivElement;
      viewer: HTMLDivElement;
      eventBus: FakeEventBus;
    }) {
      this.container = container;
      this.eventBus = eventBus;
      pdfRuntimeState.viewerHost = viewer;
    }

    get currentPageNumber() {
      return this.pageNumber;
    }

    set currentPageNumber(value: number) {
      this.pageNumber = value;
      this.container.scrollTop = (value - 1) * 820;
      this.eventBus.dispatch("pagechanging", { pageNumber: value });
    }

    get currentScaleValue() {
      return this.scale;
    }

    get currentScale() {
      return this.scale;
    }

    set currentScaleValue(value: string | number) {
      this.scale = typeof value === "number" ? value : 1;
      window.requestAnimationFrame(() => {
        this.eventBus.dispatch("pagerendered", {
          pageNumber: this.pageNumber,
          source: this.getPageView(this.pageNumber - 1),
        });
        this.eventBus.dispatch("textlayerrendered", {
          pageNumber: this.pageNumber,
        });
      });
    }

    setDocument(doc: { numPages: number } | null) {
      const viewer = pdfRuntimeState.viewerHost;
      if (!viewer) {
        return;
      }
      viewer.innerHTML = "";

      if (!doc) {
        this.pagesCount = 0;
        viewer.style.height = "";
        return;
      }

      this.pagesCount = doc.numPages;
      viewer.style.height = `${doc.numPages * 820}px`;
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        const width = pdfRuntimeState.pageWidths[pageNumber - 1] ?? 600;
        const pageTop = (pageNumber - 1) * 820;
        const page = document.createElement("div");
        page.className = "page";
        page.setAttribute("data-page-number", String(pageNumber));
        page.style.width = `${width}px`;
        page.style.height = "800px";
        page.getBoundingClientRect = vi.fn(
          () =>
            new DOMRect(
              40,
              pageTop -
                pdfRuntimeState.pageBorderTop -
                this.container.scrollTop,
              width,
              800,
            ),
        );
        Object.defineProperty(page, "clientTop", {
          configurable: true,
          value: pdfRuntimeState.pageBorderTop,
        });
        Object.defineProperty(page, "offsetTop", {
          configurable: true,
          value: pageTop,
        });

        const canvasWrapper = document.createElement("div");
        canvasWrapper.className = "canvasWrapper";
        canvasWrapper.getBoundingClientRect = page.getBoundingClientRect;
        const canvas = document.createElement("canvas");
        canvas.getBoundingClientRect = page.getBoundingClientRect;
        canvasWrapper.append(canvas);

        const textLayer = document.createElement("div");
        textLayer.className = "textLayer";
        textLayer.getBoundingClientRect = page.getBoundingClientRect;
        const span = document.createElement("span");
        const textNode = document.createTextNode(
          pdfRuntimeState.pageTexts[pageNumber - 1] ?? "",
        );
        span.append(textNode);
        textLayer.append(span);

        page.append(canvasWrapper, textLayer);
        viewer.append(page);
        if (pageNumber === 1) {
          pdfRuntimeState.textNode = textNode;
        }
      }

      window.requestAnimationFrame(() => {
        pdfRuntimeState.eventBus?.dispatch("pagesloaded", {
          pagesCount: doc.numPages,
        });
        pdfRuntimeState.eventBus?.dispatch("pagerendered", {
          pageNumber: 1,
          source: this.getPageView(0),
        });
        for (
          let pageNumber = 1;
          pageNumber <= doc.numPages;
          pageNumber += 1
        ) {
          pdfRuntimeState.eventBus?.dispatch("textlayerrendered", {
            pageNumber,
          });
        }
        pdfRuntimeState.eventBus?.dispatch("pagechanging", { pageNumber: 1 });
      });
    }

    getPageView(index = 0) {
      const width = pdfRuntimeState.pageWidths[index] ?? 600;
      return {
        viewport: {
          width,
          height: 800,
          scale: this.scale * pdfRuntimeState.viewportScaleMultiplier,
          rotation: 0,
        },
        pdfPage: {
          getViewport: () => ({
            width,
            height: 800,
            scale: this.scale,
            rotation: 0,
          }),
        },
      };
    }

    update() {}
  }

  return {
    PDF_WORKER_SRC: "/pdfjs/pdf.worker.min.mjs",
    getPdfSelection: () => window.getSelection(),
    loadPdfJs: async () => ({
      GlobalWorkerOptions: { workerSrc: "" },
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: pdfRuntimeState.numPages,
          fingerprints: ["pdf-reader-test-fingerprint"],
          getPage: async (pageNumber: number) => ({
            getTextContent: async () => ({
              items: [
                {
                  str: pdfRuntimeState.pageTexts[pageNumber - 1] ?? "",
                  hasEOL: false,
                },
              ],
            }),
            getViewport: () => ({
              width: pdfRuntimeState.pageWidths[pageNumber - 1] ?? 600,
              height: 800,
              scale: 1,
              rotation: 0,
            }),
          }),
          destroy: vi.fn(),
        }),
        destroy: vi.fn(),
      }),
    }),
    loadPdfJsViewer: async () => ({
      EventBus: FakeEventBus,
      PDFLinkService: FakePDFLinkService,
      PDFFindController: FakePDFFindController,
      PDFViewer: FakePDFViewer,
      ScrollMode: { VERTICAL: 0 },
      LinkTarget: { BLANK: 2 },
    }),
  };
});

describe("PdfReader selection chat destinations", () => {
  beforeEach(() => {
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 900);
    pdfRuntimeState.eventBus = null;
    pdfRuntimeState.viewerHost = null;
    pdfRuntimeState.textNode = null;
    pdfRuntimeState.numPages = 1;
    pdfRuntimeState.pageWidths = [600];
    pdfRuntimeState.viewportScaleMultiplier = 1;
    pdfRuntimeState.pageBorderTop = 0;
    pdfRuntimeState.pageTexts = ["Alpha selected quote Omega"];
    pdfRuntimeState.pageHighlights = [];
    pdfRuntimeState.createdHighlightId = "created-highlight-1";
    vi.mocked(apiFetch).mockClear();
  });

  it("renders reader banners inside the PDF scroll owner", async () => {
    render(
      <PdfReader
        mediaId="media-1"
        beforeContent={<div>Reader readiness</div>}
      />,
    );

    const viewport = await screen.findByLabelText("PDF document");
    expect(viewport).toContainElement(screen.getByText("Reader readiness"));
  });

  it("publishes distinct viewport and content refs", async () => {
    const viewportRef = createRef<HTMLDivElement>();
    const contentRef = createRef<HTMLDivElement>();
    const view = render(
      <PdfReader
        mediaId="media-1"
        viewportRef={viewportRef}
        contentRef={contentRef}
      />,
    );

    const viewport = await screen.findByRole("region", {
      name: "PDF document",
    });
    expect(viewportRef.current).toBe(viewport);
    expect(viewportRef.current).toHaveAttribute("data-pane-content", "true");
    expect(contentRef.current).toHaveClass("pdfViewer");
    expect(viewportRef.current).toContainElement(contentRef.current);
    expect(contentRef.current).not.toBe(viewportRef.current);
    await waitFor(() =>
      expect(
        screen.getByTestId("pdf-page-text-layer-1"),
      ).toHaveAttribute("data-reader-tap-reveal-surface", "true"),
    );

    view.unmount();
    expect(viewportRef.current).toBeNull();
    expect(contentRef.current).toBeNull();
  });

  it("drives the real chrome provider from the actual PDF viewport and rebaselines on source replacement", async () => {
    vi.stubGlobal("innerWidth", 390);
    fireEvent(window, new Event("resize"));
    const view = render(
      withRenderEnvironment(<PdfReader mediaId="media-1" />, {
        initialViewport: "mobile",
      }),
    );

    const viewport = await screen.findByLabelText("PDF document");
    const probe = screen.getByTestId("mobile-chrome-behavior-probe");
    await waitFor(() =>
      expect(probe).toHaveAttribute("data-mobile", "true"),
    );
    await waitFor(() =>
      expect(probe).toHaveAttribute("data-motion-phase", "Visible"),
    );
    await waitFor(() =>
      expect(
        probe.style.getPropertyValue(MOBILE_CHROME_COLLAPSE_PROPERTY),
      ).toBe("0"),
    );
    prepareScrollableReader(viewport);
    await waitFor(() =>
      expect(
        screen.getByTestId("pdf-page-text-layer-1"),
      ).toHaveAttribute("data-reader-tap-reveal-surface", "true"),
    );
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    viewport.scrollTop = 80;
    fireEvent.scroll(viewport);
    await waitFor(() =>
      expect(probe).toHaveAttribute("data-motion-phase", "Hidden"),
    );

    view.rerender(
      withRenderEnvironment(<PdfReader mediaId="media-2" />, {
        initialViewport: "mobile",
      }),
    );
    await waitFor(() =>
      expect(probe).toHaveAttribute("data-motion-phase", "Visible"),
    );
    await waitFor(() =>
      expect(
        probe.style.getPropertyValue(MOBILE_CHROME_COLLAPSE_PROPERTY),
      ).toBe("0"),
    );

    view.unmount();
  });

  it("pins and rebaselines the real PDF viewport across a zoom reflow", async () => {
    vi.stubGlobal("innerWidth", 390);
    fireEvent(window, new Event("resize"));
    let controls: PdfReaderControlActions | null = null;
    render(
      withRenderEnvironment(
        <PdfReader
          mediaId="media-1"
          onControlsReady={(nextControls) => {
            controls = nextControls;
          }}
        />,
        { initialViewport: "mobile" },
      ),
    );

    const viewport = await screen.findByLabelText("PDF document");
    const probe = screen.getByTestId("mobile-chrome-behavior-probe");
    prepareScrollableReader(viewport);
    fireEvent(window, new Event("resize"));
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await waitFor(() =>
      expect(probe).toHaveAttribute("data-motion-phase", "Visible"),
    );

    viewport.scrollTop = 80;
    fireEvent.scroll(viewport);
    await waitFor(() =>
      expect(probe).toHaveAttribute("data-motion-phase", "Hidden"),
    );
    if (!controls) {
      throw new Error("Expected PDF controls");
    }

    act(() => (controls as PdfReaderControlActions | null)?.zoomIn());
    await waitFor(() =>
      expect(probe).toHaveAttribute("data-motion-phase", "Pinned"),
    );
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    await waitFor(() => {
      expect(probe).toHaveAttribute("data-motion-phase", "Visible");
      expect(
        probe.style.getPropertyValue(MOBILE_CHROME_COLLAPSE_PROPERTY),
      ).toBe("0");
    });

    const baseline = viewport.scrollTop;
    for (const offset of [8, 16, 24]) {
      viewport.scrollTop = baseline + offset;
      fireEvent.scroll(viewport);
    }
    await waitFor(() =>
      expect(probe).toHaveAttribute("data-motion-phase", "Tracking"),
    );
  });

  it("publishes PDF Find semantic preview and return intents from the real viewport", async () => {
    pdfRuntimeState.numPages = 2;
    pdfRuntimeState.pageWidths = [600, 600];
    pdfRuntimeState.viewportScaleMultiplier = 4 / 3;
    pdfRuntimeState.pageBorderTop = 9;
    pdfRuntimeState.pageTexts = ["", "Alpha selected quote Omega"];
    const onSemanticViewportChange = vi.fn();
    const onFindRuntimeReady = vi.fn();
    let resolveRuntime!: (runtime: PdfFindRuntime) => void;
    const runtimeReady = new Promise<PdfFindRuntime>((resolve) => {
      resolveRuntime = resolve;
    });

    const view = render(
      <PdfReader
        mediaId="media-1"
        onSemanticViewportChange={onSemanticViewportChange}
        onFindRuntimeReady={(nextRuntime) => {
          if (nextRuntime) {
            resolveRuntime(nextRuntime);
          }
          onFindRuntimeReady(nextRuntime);
        }}
      />,
    );

    const viewport = await screen.findByRole("region", {
      name: "PDF document",
    });
    const activeRuntime = await runtimeReady;
    expect(activeRuntime.source).toEqual({
      mediaId: "media-1",
      fingerprints: ["pdf-reader-test-fingerprint"],
      numPages: 2,
    });

    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400);
    viewport.scrollTop = 135;
    viewport.scrollLeft = 9;
    fireEvent.scroll(viewport);
    await waitFor(() => {
      expect(onSemanticViewportChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ intent: "Reader" }),
      );
    });
    onSemanticViewportChange.mockClear();
    const origin = activeRuntime.captureOrigin();
    expect(origin.kind).toBe("Captured");

    let result!: PdfRuntimeFindResult;
    await act(async () => {
      result = await activeRuntime.search({
        generation: 1,
        query: "selected quote",
        scope: { kind: "EntirePdf" },
        matchCase: false,
        wholeWord: false,
        signal: new AbortController().signal,
      });
    });
    if (result.kind !== "Ready") {
      throw new Error(`Expected ready PDF Find result, got ${result.kind}`);
    }
    expect(result.occurrences).toHaveLength(1);
    const occurrence = result.occurrences[0]!;
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();

    await act(async () => {
      await activeRuntime.activate(
        occurrence.locator,
        new AbortController().signal,
      );
    });
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        onSemanticViewportChange.mock.calls.some(
          ([snapshot]) => snapshot?.intent === "Preview",
        ),
      ).toBe(true),
    );

    if (origin.kind !== "Captured") {
      throw new Error("Expected a captured PDF Find origin");
    }
    onSemanticViewportChange.mockClear();
    await act(async () => {
      await activeRuntime.restoreOrigin(
        origin.value,
        new AbortController().signal,
      );
    });
    await waitFor(() => {
      expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
      expect(viewport).toHaveFocus();
    });
    expect(viewport.scrollTop).toBe(135);
    expect(viewport.scrollLeft).toBe(9);
    await waitFor(() =>
      expect(
        onSemanticViewportChange.mock.calls.some(
          ([snapshot]) => snapshot?.intent === "Return",
        ),
      ).toBe(true),
    );

    view.unmount();
    expect(onFindRuntimeReady).toHaveBeenLastCalledWith(null);
  });

  it("captures unequal PDF pages as full page-space fractions once per frame", async () => {
    pdfRuntimeState.numPages = 2;
    pdfRuntimeState.pageWidths = [600, 600];
    const onSemanticViewportChange = vi.fn();

    render(
      <PdfReader
        mediaId="media-1"
        onSemanticViewportChange={onSemanticViewportChange}
      />,
    );

    const viewport = await screen.findByRole("region", {
      name: "PDF document",
    });
    const firstPage = await screen.findByTestId("pdf-page-surface-1");
    const secondPage = await screen.findByTestId("pdf-page-surface-2");
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400);
    firstPage.setAttribute("data-nexus-page-viewport-height", "600");
    secondPage.setAttribute("data-nexus-page-viewport-height", "300");
    firstPage.getBoundingClientRect = () =>
      new DOMRect(40, -550, 600, 600);
    secondPage.getBoundingClientRect = () =>
      new DOMRect(40, 150, 600, 300);

    fireEvent.scroll(viewport);
    await waitFor(() =>
      expect(onSemanticViewportChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          intent: "Reader",
          visibleStart: expect.objectContaining({ pageFraction: 550 / 600 }),
        }),
      ),
    );
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    onSemanticViewportChange.mockClear();
    fireEvent.scroll(viewport);
    fireEvent.scroll(viewport);
    fireEvent.scroll(viewport);

    await waitFor(() => {
      expect(
        onSemanticViewportChange.mock.calls.filter(
          ([snapshot]) => snapshot !== null,
        ),
      ).toHaveLength(1);
    });
    expect(onSemanticViewportChange).toHaveBeenLastCalledWith({
      sourceKey: expect.any(String),
      layoutGeneration: expect.any(Number),
      intent: "Reader",
      primaryLocator: {
        kind: "pdf",
        page: 1,
        page_progression: 550 / 600,
        zoom: 1,
        position: 1,
      },
      visibleStart: {
        kind: "Pdf",
        page: 1,
        pageFraction: 550 / 600,
      },
      visibleEnd: {
        kind: "Pdf",
        page: 2,
        pageFraction: 250 / 300,
      },
      atEnd: false,
    });

    onSemanticViewportChange.mockClear();
    firstPage.getBoundingClientRect = () =>
      new DOMRect(40, -700, 600, 600);
    secondPage.getBoundingClientRect = () =>
      new DOMRect(40, 500, 600, 300);
    fireEvent.scroll(viewport);
    await waitFor(() =>
      expect(onSemanticViewportChange).toHaveBeenLastCalledWith(null),
    );
  });

  it("refreshes expired source access without publishing a false source exit", async () => {
    const publishedRuntimes: Array<PdfFindRuntime | null> = [];
    let resolveRuntime!: (runtime: PdfFindRuntime) => void;
    const runtimeReady = new Promise<PdfFindRuntime>((resolve) => {
      resolveRuntime = resolve;
    });
    const view = render(
      <PdfReader
        mediaId="media-1"
        onFindRuntimeReady={(runtime) => {
          publishedRuntimes.push(runtime);
          if (runtime) {
            resolveRuntime(runtime);
          }
        }}
      />,
    );
    const initialRuntime = await runtimeReady;
    const publicationCountBeforeRefresh = publishedRuntimes.length;
    const origin = initialRuntime.captureOrigin();
    if (origin.kind !== "Captured") {
      throw new Error("Expected a captured PDF Find origin");
    }
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2100-01-01T00:00:00.000Z"));

    let refreshAbort: unknown;
    await act(async () => {
      try {
        await initialRuntime.restoreOrigin(
          origin.value,
          new AbortController().signal,
        );
      } catch (error) {
        refreshAbort = error;
      }
    });
    expect(isPdfFindSourceAccessRefreshAbort(refreshAbort)).toBe(true);
    await waitFor(() => {
      expect(
        vi
          .mocked(apiFetch)
          .mock.calls.filter(([path]) => path === "/api/media/media-1/file"),
      ).toHaveLength(2);
      expect(publishedRuntimes.length).toBeGreaterThan(
        publicationCountBeforeRefresh,
      );
    });
    const refreshPublications = publishedRuntimes.slice(
      publicationCountBeforeRefresh,
    );
    expect(refreshPublications).not.toContain(null);
    expect(refreshPublications.at(-1)).not.toBe(initialRuntime);

    now.mockRestore();
    const publicationCountBeforeUnmount = publishedRuntimes.length;
    view.unmount();
    expect(publishedRuntimes).toHaveLength(publicationCountBeforeUnmount + 1);
    expect(publishedRuntimes.at(-1)).toBeNull();
  });

  it("creates a PDF highlight and quotes it to a new chat", async () => {
    pdfRuntimeState.createdHighlightId = "created-highlight-42";
    const onQuoteToNewChat =
      vi.fn<(highlightId: string, highlight: unknown) => void>();
    const onQuoteToExistingChat =
      vi.fn<(highlightId: string, highlight: unknown) => void>();
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(110, 140, 160, 20),
    );
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(
      rectList([new DOMRect(110, 140, 160, 20)]),
    );

    render(
      <PdfReader
        mediaId="media-1"
        onQuoteToNewChat={onQuoteToNewChat}
        onQuoteToExistingChat={onQuoteToExistingChat}
      />,
    );

    const textLayer = await screen.findByTestId("pdf-page-text-layer-1");
    await waitFor(() => {
      expect(textLayer.textContent).toContain("selected quote");
    });

    const textNode = pdfRuntimeState.textNode;
    expect(textNode).not.toBeNull();
    const range = document.createRange();
    range.setStart(textNode!, "Alpha ".length);
    range.setEnd(textNode!, "Alpha selected quote".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    const newChatButton = await screen.findByRole("button", {
      name: "Ask in new chat",
    });
    expect(
      screen.getByRole("button", { name: "Ask in existing chat…" }),
    ).toBeInTheDocument();

    fireEvent.click(newChatButton);

    await waitFor(() => {
      expect(onQuoteToNewChat).toHaveBeenCalledTimes(1);
    });
    expect(onQuoteToNewChat).toHaveBeenCalledWith(
      "created-highlight-42",
      expect.objectContaining({
        id: "created-highlight-42",
        exact: "selected quote",
        prefix: "",
        suffix: "",
      }),
    );
    expect(onQuoteToExistingChat).not.toHaveBeenCalled();

    const postCalls = vi
      .mocked(apiFetch)
      .mock.calls.filter(
        ([path, init]) =>
          path === "/api/media/media-1/pdf-highlights" &&
          init?.method === "POST",
      );
    expect(postCalls).toHaveLength(1);
    const postBody = JSON.parse(String(postCalls[0]![1]!.body)) as {
      page_number: number;
      color: string;
      exact: string;
    };
    expect(postBody).toMatchObject({
      page_number: 1,
      color: "yellow",
      exact: "selected quote",
    });
  });

  it("keeps captured PDF selection actions usable after transient selection collapse", async () => {
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(110, 140, 160, 20),
    );
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(
      rectList([new DOMRect(110, 140, 160, 20)]),
    );

    render(<PdfReader mediaId="media-1" />);

    const textLayer = await screen.findByTestId("pdf-page-text-layer-1");
    await waitFor(() => {
      expect(textLayer.textContent).toContain("selected quote");
    });

    const textNode = pdfRuntimeState.textNode;
    expect(textNode).not.toBeNull();
    const range = document.createRange();
    range.setStart(textNode!, "Alpha ".length);
    range.setEnd(textNode!, "Alpha selected quote".length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    const colorButton = await screen.findByRole("button", {
      name: "Highlight color",
    });
    selection?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));

    expect(
      screen.getByRole("group", { name: "Selection actions" }),
    ).toBeInTheDocument();

    fireEvent.click(colorButton);
    fireEvent.click(await screen.findByRole("button", { name: "Green" }));

    await waitFor(() => {
      expect(
        vi
          .mocked(apiFetch)
          .mock.calls.some(
            ([path, init]) =>
              path === "/api/media/media-1/pdf-highlights" &&
              init?.method === "POST",
          ),
      ).toBe(true);
    });
    const postCall = vi
      .mocked(apiFetch)
      .mock.calls.find(
        ([path, init]) =>
          path === "/api/media/media-1/pdf-highlights" &&
          init?.method === "POST",
      );
    expect(postCall).toBeDefined();
    const postBody = JSON.parse(String(postCall![1]!.body)) as {
      page_number: number;
      color: string;
      exact: string;
    };
    expect(postBody).toMatchObject({
      page_number: 1,
      color: "green",
      exact: "selected quote",
    });
  });

  it("publishes the widest rendered page width", async () => {
    pdfRuntimeState.numPages = 2;
    pdfRuntimeState.pageWidths = [600, 735.4];
    const onIntrinsicWidthChange = vi.fn();

    render(
      <PdfReader
        mediaId="media-1"
        onIntrinsicWidthChange={onIntrinsicWidthChange}
      />,
    );

    await waitFor(() => {
      expect(onIntrinsicWidthChange).toHaveBeenCalledWith({
        maxRenderedPageWidthPx: 736,
      });
    });
  });

  it("loads active page highlights once per page owner, not per render event", async () => {
    render(<PdfReader mediaId="media-1" />);

    await screen.findByTestId("pdf-page-text-layer-1");

    const highlightCalls = () =>
      vi
        .mocked(apiFetch)
        .mock.calls.filter(
          ([path, init]) =>
            path ===
              "/api/media/media-1/pdf-highlights?page_number=1&mine_only=false" &&
            (init?.method ?? "GET") === "GET",
        );

    await waitFor(() => {
      expect(highlightCalls()).toHaveLength(1);
    });

    act(() => {
      pdfRuntimeState.eventBus?.dispatch("pagerendered", { pageNumber: 1 });
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(highlightCalls()).toHaveLength(1);
  });

  it("keeps PDF highlight hover and focus reciprocal without activating it", async () => {
    pdfRuntimeState.pageHighlights = [
      {
        id: "hovered-highlight",
        anchor: {
          type: "pdf_page_geometry",
          media_id: "media-1",
          page_number: 1,
          quads: [
            {
              x1: 70,
              y1: 60,
              x2: 230,
              y2: 60,
              x3: 230,
              y3: 80,
              x4: 70,
              y4: 80,
            },
          ],
        },
        color: "yellow",
        exact: "Hovered quote",
        prefix: "",
        suffix: "",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        author_user_id: "user-1",
        is_owner: true,
      },
    ];

    const onHighlightHover = vi.fn();
    const onHighlightTap = vi.fn();
    const { rerender } = render(
      <PdfReader
        mediaId="media-1"
        onHighlightHover={onHighlightHover}
        onHighlightTap={onHighlightTap}
      />,
    );
    const overlay = await screen.findByTestId(
      "pdf-highlight-hovered-highlight-0",
    );
    expect(overlay).toHaveAttribute("data-reader-tap-handled", "true");
    expect(overlay.className).not.toContain("highlightOverlayRectHovered");

    fireEvent.pointerEnter(overlay);
    expect(onHighlightHover).toHaveBeenLastCalledWith("hovered-highlight");
    fireEvent.pointerLeave(overlay);
    expect(onHighlightHover).toHaveBeenLastCalledWith(null);
    act(() => overlay.focus());
    expect(onHighlightHover).toHaveBeenLastCalledWith("hovered-highlight");
    fireEvent.pointerLeave(overlay);
    expect(onHighlightHover).toHaveBeenLastCalledWith("hovered-highlight");
    act(() => overlay.blur());
    expect(onHighlightHover).toHaveBeenLastCalledWith(null);
    expect(onHighlightTap).not.toHaveBeenCalled();

    rerender(
      <PdfReader
        mediaId="media-1"
        hoveredHighlightId="hovered-highlight"
        onHighlightHover={onHighlightHover}
        onHighlightTap={onHighlightTap}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("pdf-highlight-hovered-highlight-0").className,
      ).toContain("highlightOverlayRectHovered");
    });
  });

  it("pulses only the requested PDF highlight", async () => {
    const quads = [
      {
        x1: 70,
        y1: 60,
        x2: 230,
        y2: 60,
        x3: 230,
        y3: 80,
        x4: 70,
        y4: 80,
      },
    ];
    pdfRuntimeState.pageHighlights = [
      {
        id: "h1",
        anchor: {
          type: "pdf_page_geometry",
          media_id: "media-1",
          page_number: 1,
          quads,
        },
        color: "yellow",
        exact: "First quote",
        prefix: "",
        suffix: "",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        author_user_id: "user-1",
        is_owner: true,
      },
      {
        id: "h2",
        anchor: {
          type: "pdf_page_geometry",
          media_id: "media-1",
          page_number: 1,
          quads: [
            {
              x1: 80,
              y1: 120,
              x2: 180,
              y2: 120,
              x3: 180,
              y3: 140,
              x4: 80,
              y4: 140,
            },
          ],
        },
        color: "green",
        exact: "Second quote",
        prefix: "",
        suffix: "",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        author_user_id: "user-1",
        is_owner: true,
      },
    ];

    render(<PdfReader mediaId="media-1" />);

    await screen.findByTestId("pdf-highlight-h1-0");
    await screen.findByTestId("pdf-highlight-h2-0");

    dispatchReaderPulse({
      mediaId: "media-1",
      highlightId: "h1",
      locator: {
        type: "pdf_page_geometry",
        media_id: "media-1",
        page_number: 1,
        quads,
        exact: "First quote",
      },
      snippet: "First quote",
      highlightBehavior: "pulse",
      focusBehavior: "scroll_into_view",
    });

    await waitFor(() => {
      const first = screen.getByTestId("pdf-highlight-h1-0");
      expect(
        Array.from(first.classList).some((name) => name.includes("pulsing")),
      ).toBe(true);
    });
    const second = screen.getByTestId("pdf-highlight-h2-0");
    expect(
      Array.from(second.classList).some((name) => name.includes("pulsing")),
    ).toBe(false);
  });

  it("renders apparatus PDF geometry pulses without pulsing unrelated highlights", async () => {
    const persistedQuad = {
      x1: 80,
      y1: 120,
      x2: 180,
      y2: 120,
      x3: 180,
      y3: 140,
      x4: 80,
      y4: 140,
    };
    const apparatusQuad = {
      x1: 70,
      y1: 60,
      x2: 230,
      y2: 60,
      x3: 230,
      y3: 80,
      x4: 70,
      y4: 80,
    };
    pdfRuntimeState.pageHighlights = [
      {
        id: "persisted-highlight",
        anchor: {
          type: "pdf_page_geometry",
          media_id: "media-1",
          page_number: 1,
          quads: [persistedQuad],
        },
        color: "green",
        exact: "Persisted quote",
        prefix: "",
        suffix: "",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        author_user_id: "user-1",
        is_owner: true,
      },
    ];

    render(<PdfReader mediaId="media-1" />);

    const persisted = await screen.findByTestId(
      "pdf-highlight-persisted-highlight-0",
    );

    dispatchReaderPulse({
      mediaId: "media-1",
      locator: {
        type: "pdf_page_geometry",
        media_id: "media-1",
        page_number: 1,
        quads: [apparatusQuad],
        exact: "[13]",
      },
      snippet: "[13]",
      highlightBehavior: "pulse",
      focusBehavior: "scroll_into_view",
    });

    const transient = await screen.findByTestId(/^pdf-highlight-reader-pulse-/);
    await waitFor(() => {
      expect(
        Array.from(transient.classList).some((name) =>
          name.includes("pulsing"),
        ),
      ).toBe(true);
    });
    expect(
      Array.from(persisted.classList).some((name) => name.includes("pulsing")),
    ).toBe(false);
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.some(
          ([path, init]) =>
            path === "/api/media/media-1/pdf-highlights" &&
            init?.method === "POST",
        ),
    ).toBe(false);
  });

  it("uses retrying PDF scroll navigation for cross-page reader pulses", async () => {
    vi.stubGlobal("innerWidth", 390);
    fireEvent(window, new Event("resize"));
    pdfRuntimeState.numPages = 2;
    pdfRuntimeState.pageWidths = [600, 600];
    pdfRuntimeState.viewportScaleMultiplier = 4 / 3;
    const quads = [
      {
        x1: 70,
        y1: 60,
        x2: 230,
        y2: 60,
        x3: 230,
        y3: 80,
        x4: 70,
        y4: 80,
      },
    ];

    render(
      withRenderEnvironment(<PdfReader mediaId="media-1" />, {
        initialViewport: "mobile",
      }),
    );

    await screen.findByTestId("pdf-page-text-layer-2");

    dispatchReaderPulse({
      mediaId: "media-1",
      locator: {
        type: "pdf_page_geometry",
        media_id: "media-1",
        page_number: 2,
        quads,
        exact: "[13]",
      },
      snippet: "[13]",
      highlightBehavior: "pulse",
      focusBehavior: "scroll_into_view",
    });

    await waitFor(() => {
      expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    });
    expect(
      await screen.findByTestId(/^pdf-highlight-reader-pulse-/),
    ).toBeInTheDocument();
    const probe = screen.getByTestId("mobile-chrome-behavior-probe");
    await waitFor(() => expect(probe).toHaveAttribute("data-mobile", "true"));
    await waitFor(() =>
      expect(probe).toHaveAttribute("data-motion-phase", "Pinned"),
    );
    act(() => {
      pdfRuntimeState.eventBus?.dispatch("pagerendered", { pageNumber: 2 });
    });
    await waitFor(() =>
      expect(probe).toHaveAttribute("data-motion-phase", "Visible"),
    );
  });

  it("retains an initial cross-page target until the PDF viewer is ready", async () => {
    pdfRuntimeState.numPages = 2;
    pdfRuntimeState.pageWidths = [600, 600];
    const target = {
      id: "evidence-late-viewer",
      pageNumber: 2,
      quads: [
        {
          x1: 70,
          y1: 60,
          x2: 230,
          y2: 60,
          x3: 230,
          y3: 80,
          x4: 70,
          y4: 80,
        },
      ],
      color: "blue" as const,
    };

    render(
      <PdfReader mediaId="media-1" temporaryHighlight={target} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    });
    expect(
      await screen.findByTestId("pdf-highlight-evidence-late-viewer-0"),
    ).toBeVisible();
  });
});
