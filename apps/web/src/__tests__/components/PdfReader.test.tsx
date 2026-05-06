import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PdfReader, { type PdfReaderSelectionQuote } from "@/components/PdfReader";
import { apiFetch } from "@/lib/api/client";

const pdfRuntimeState = vi.hoisted(() => ({
  eventBus: null as null | {
    dispatch: (eventName: string, event: unknown) => void;
  },
  viewerHost: null as HTMLDivElement | null,
  textNode: null as Text | null,
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
  isApiError: (error: unknown) => error instanceof Error && error.name === "ApiError",
  apiFetch: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/media/media-1/file") {
      return {
        data: {
          url: "https://example.test/document.pdf",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      };
    }

    if (path === "/api/media/media-1/pdf-highlights?page_number=1" && !init) {
      return {
        data: {
          page_number: 1,
          highlights: [],
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
        listeners.filter((candidate) => candidate !== listener)
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
      const pageRect = new DOMRect(40, 80, 600, 800);
      const page = document.createElement("div");
      page.className = "page";
      page.setAttribute("data-page-number", "1");
      setElementRect(page, pageRect);
      Object.defineProperty(page, "offsetTop", {
        configurable: true,
        value: 0,
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
      pdfRuntimeState.textNode = textNode;

      window.requestAnimationFrame(() => {
        pdfRuntimeState.eventBus?.dispatch("pagesloaded", { pagesCount: doc.numPages });
        pdfRuntimeState.eventBus?.dispatch("pagerendered", {
          pageNumber: 1,
          source: this.getPageView(0),
        });
        pdfRuntimeState.eventBus?.dispatch("pagechanging", { pageNumber: 1 });
      });
    }

    getPageView(_index?: number) {
      return {
        viewport: {
          width: 600,
          height: 800,
          scale: 1,
          rotation: 0,
        },
        pdfPage: {
          getViewport: () => ({
            width: 600,
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
    PDF_WORKER_SRC: "/api/pdfjs/worker",
    getPdfSelection: () => window.getSelection(),
    loadPdfJs: async () => ({
      GlobalWorkerOptions: { workerSrc: "" },
      getDocument: () => ({
        promise: Promise.resolve({ numPages: 1, destroy: vi.fn() }),
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

describe("PdfReader selection Ask", () => {
  beforeEach(() => {
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 900);
    pdfRuntimeState.eventBus = null;
    pdfRuntimeState.viewerHost = null;
    pdfRuntimeState.textNode = null;
  });

  it("emits a transient reader-selection quote without creating a saved PDF highlight", async () => {
    const onAskSelection = vi.fn<(selection: PdfReaderSelectionQuote) => void>();
    vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(110, 140, 160, 20)
    );
    vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(
      rectList([new DOMRect(110, 140, 160, 20)])
    );

    render(<PdfReader mediaId="media-1" onAskSelection={onAskSelection} />);

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

    fireEvent.click(await screen.findByRole("button", { name: "Ask" }));

    expect(onAskSelection).toHaveBeenCalledTimes(1);
    expect(onAskSelection.mock.calls[0]![0]).toMatchObject({
      kind: "reader_selection",
      media_id: "media-1",
      color: "yellow",
      exact: "selected quote",
      prefix: "Alpha",
      suffix: "Omega",
      preview: "selected quote",
      locator: {
        type: "pdf_text_quote",
        page_number: 1,
        page_text_start_offset: 6,
        page_text_end_offset: 20,
        text_quote_selector: {
          exact: "selected quote",
          prefix: "Alpha",
          suffix: "Omega",
        },
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
    });
    expect(onAskSelection.mock.calls[0]![0].client_context_id).toEqual(expect.any(String));
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.some(
          ([path, init]) =>
            String(path).includes("/pdf-highlights") && init?.method === "POST"
        )
    ).toBe(false);
  });
});
