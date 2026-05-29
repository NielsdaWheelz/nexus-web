import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PdfReader from "@/components/PdfReader";
import { apiFetch } from "@/lib/api/client";
import { dispatchReaderPulse } from "@/lib/reader/pulseEvent";

const pdfRuntimeState = vi.hoisted(() => ({
  eventBus: null as null | {
    dispatch: (eventName: string, event: unknown) => void;
  },
  viewerHost: null as HTMLDivElement | null,
  textNode: null as Text | null,
  numPages: 1,
  pageWidths: [600] as number[],
  pageHighlights: [] as unknown[],
  createdHighlightId: "created-highlight-1",
}));

function rectList(rects: DOMRect[]): DOMRectList {
  return Object.assign(rects, {
    item: (index: number) => rects[index] ?? null,
  }) as unknown as DOMRectList;
}

vi.mock("@/components/workspace/PaneShell", () => ({
  usePaneMobileChromeController: () => null,
}));

vi.mock("@/lib/api/client", () => ({
  ApiError: class ApiError extends Error {},
  isApiError: (error: unknown) =>
    error instanceof Error && error.name === "ApiError",
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/media/media-1/file") {
      return {
        data: {
          url: "https://example.test/document.pdf",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      };
    }

    if (
      (path === "/api/media/media-1/pdf-highlights?page_number=1" ||
        path ===
          "/api/media/media-1/pdf-highlights?page_number=1&mine_only=false") &&
      !init
    ) {
      return {
        data: {
          page_number: 1,
          highlights: pdfRuntimeState.pageHighlights,
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
}));

vi.mock("@/components/pdfReaderRuntime", () => {
  function setElementRect(element: HTMLElement, rect: DOMRect): void {
    element.getBoundingClientRect = vi.fn(() => rect);
  }

  class FakeEventBus {
    private listeners = new Map<string, Array<(event: unknown) => void>>();

    constructor() {
      pdfRuntimeState.eventBus = {
        dispatch: (eventName: string, event: unknown) => {
          this.listeners.get(eventName)?.forEach((listener) => listener(event));
        },
      };
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
    setDocument() {}
    setViewer() {}
  }

  class FakePDFViewer {
    currentPageNumber = 1;
    currentScaleValue: string | number = 1;
    pagesCount = 0;

    constructor({ viewer }: { viewer: HTMLDivElement }) {
      pdfRuntimeState.viewerHost = viewer;
    }

    setDocument(doc: { numPages: number } | null) {
      const viewer = pdfRuntimeState.viewerHost;
      if (!viewer) {
        return;
      }
      viewer.innerHTML = "";

      if (!doc) {
        this.pagesCount = 0;
        return;
      }

      this.pagesCount = doc.numPages;
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        const width = pdfRuntimeState.pageWidths[pageNumber - 1] ?? 600;
        const pageRect = new DOMRect(40, 80 * pageNumber, width, 800);
        const page = document.createElement("div");
        page.className = "page";
        page.setAttribute("data-page-number", String(pageNumber));
        setElementRect(page, pageRect);
        Object.defineProperty(page, "offsetTop", {
          configurable: true,
          value: (pageNumber - 1) * 820,
        });

        const canvasWrapper = document.createElement("div");
        canvasWrapper.className = "canvasWrapper";
        setElementRect(canvasWrapper, pageRect);
        const canvas = document.createElement("canvas");
        setElementRect(canvas, pageRect);
        canvasWrapper.append(canvas);

        const textLayer = document.createElement("div");
        textLayer.className = "textLayer";
        setElementRect(textLayer, pageRect);
        const span = document.createElement("span");
        const textNode = document.createTextNode("Alpha selected quote Omega");
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
        pdfRuntimeState.eventBus?.dispatch("pagechanging", { pageNumber: 1 });
      });
    }

    getPageView(index = 0) {
      const width = pdfRuntimeState.pageWidths[index] ?? 600;
      return {
        viewport: {
          width,
          height: 800,
          scale: 1,
          rotation: 0,
        },
        pdfPage: {
          getViewport: () => ({
            width,
            height: 800,
            scale: 1,
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
          destroy: vi.fn(),
        }),
        destroy: vi.fn(),
      }),
    }),
    loadPdfJsViewer: async () => ({
      EventBus: FakeEventBus,
      PDFLinkService: FakePDFLinkService,
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
    pdfRuntimeState.pageHighlights = [];
    pdfRuntimeState.createdHighlightId = "created-highlight-1";
    vi.mocked(apiFetch).mockClear();
  });

  it("creates a PDF highlight and quotes it to a new chat", async () => {
    pdfRuntimeState.createdHighlightId = "created-highlight-42";
    const onQuoteToNewChat = vi.fn<(highlightId: string) => void>();
    const onQuoteToExtantChat = vi.fn<(highlightId: string) => void>();
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
        onQuoteToExtantChat={onQuoteToExtantChat}
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
      name: "Quote to new chat",
    });
    expect(
      screen.getByRole("button", { name: "Quote to existing chat" }),
    ).toBeInTheDocument();

    fireEvent.click(newChatButton);

    await waitFor(() => {
      expect(onQuoteToNewChat).toHaveBeenCalledTimes(1);
    });
    expect(onQuoteToNewChat).toHaveBeenCalledWith("created-highlight-42");
    expect(onQuoteToExtantChat).not.toHaveBeenCalled();

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
      sourceVersion: "pdf:media-1:v1",
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
});
