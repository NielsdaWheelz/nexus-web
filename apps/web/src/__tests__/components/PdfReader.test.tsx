import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PdfReader, { type PdfReaderDeps } from "@/components/PdfReader";

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

function createFakePage(options?: {
  textItems?: string[];
  viewportWidth?: number;
  viewportHeight?: number;
}) {
  const textItems = options?.textItems ?? ["example text"];
  const viewportWidth = options?.viewportWidth ?? 800;
  const viewportHeight = options?.viewportHeight ?? 1100;

  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: viewportWidth * scale,
      height: viewportHeight * scale,
      scale,
    })),
    render: vi.fn(() => ({ promise: Promise.resolve() })),
    getTextContent: vi.fn(async () => ({
      items: textItems.map((str, idx) => ({
        str,
        dir: "ltr",
        width: Math.max(str.length * 7, 20),
        height: 12,
        transform: [12, 0, 0, 12, 72, 720 - idx * 20],
        fontName: "f1",
        hasEOL: false,
      })),
      styles: {
        f1: {
          fontFamily: "sans-serif",
          ascent: 0.8,
          descent: -0.2,
          vertical: false,
        },
      },
    })),
  };
}

function createFakeDocument(
  numPages: number,
  pagesByNumber?: Record<number, ReturnType<typeof createFakePage>>
) {
  return {
    numPages,
    getPage: vi.fn(async (pageNumber: number) => {
      return pagesByNumber?.[pageNumber] ?? createFakePage();
    }),
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

class FakeTextLayer {
  private textContentSource: { items?: Array<{ str?: string }> };
  private container: HTMLElement;

  constructor(options: {
    textContentSource: { items?: Array<{ str?: string }> };
    container: HTMLElement;
  }) {
    this.textContentSource = options.textContentSource;
    this.container = options.container;
  }

  async render() {
    this.container.innerHTML = "";
    for (const item of this.textContentSource.items ?? []) {
      const span = document.createElement("span");
      span.textContent = item.str ?? "";
      this.container.appendChild(span);
      this.container.appendChild(document.createTextNode(" "));
    }
  }

  update() {
    // no-op for test shim
  }

  cancel() {
    // no-op for test shim
  }
}

function createDeps(options: {
  urls: string[];
  docsByUrl: Record<string, ReturnType<typeof createFakeDocument>>;
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
      TextLayer: FakeTextLayer,
      GlobalWorkerOptions: { workerSrc: "" },
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

    const firstDoc = createFakeDocument(2);
    firstDoc.getPage.mockImplementation(async (pageNumber: number) => {
      if (pageNumber === 1) {
        return createFakePage();
      }
      const err = new Error("Unexpected server response (403) while loading PDF page");
      (err as { status?: number }).status = 403;
      throw err;
    });

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

    await userEvent.click(
      screen.getByRole("button", { name: /highlight selection/i })
    );

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
});
