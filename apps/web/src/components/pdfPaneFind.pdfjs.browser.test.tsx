import { afterEach, expect, it, vi } from "vitest";
import * as pdfjsLib from "pdfjs-dist";
import { createPdfFindRuntime } from "@/components/pdfPaneFind";
import type {
  PdfDocumentLike,
  PdfJsViewerLike,
  PdfViewerLike,
} from "@/components/pdfReaderRuntime";

interface PdfJsTestDocument extends PdfDocumentLike {
  readonly pagesMapper: {
    readonly pagesNumber: number;
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "pdfjsLib");
});

it("composes the pinned PDF.js Find runtime without native navigation or rematching", async () => {
  expect(pdfjsLib.version).toBe("5.7.284");
  Reflect.set(globalThis, "pdfjsLib", pdfjsLib);
  const viewerModule = (await import(
    "pdfjs-dist/web/pdf_viewer.mjs"
  )) as unknown as PdfJsViewerLike;
  const eventBus = new viewerModule.EventBus();
  const finalCounts: number[] = [];
  const findTypes: string[] = [];
  eventBus.on("updatefindmatchescount", (event) => {
    if (
      event !== null &&
      typeof event === "object" &&
      "matchesCount" in event &&
      event.matchesCount !== null &&
      typeof event.matchesCount === "object" &&
      "total" in event.matchesCount &&
      typeof event.matchesCount.total === "number"
    ) {
      finalCounts.push(event.matchesCount.total);
    }
  });
  eventBus.on("find", (event) => {
    if (
      event !== null &&
      typeof event === "object" &&
      "type" in event &&
      typeof event.type === "string"
    ) {
      findTypes.push(event.type);
    }
  });

  const pages = ["needle then needle", "no match here"] as const;
  const pdfDocument: PdfJsTestDocument = {
    fingerprints: ["real-pdfjs-find", null],
    numPages: pages.length,
    pagesMapper: { pagesNumber: pages.length },
    async getPage(pageNumber) {
      const text = pages[pageNumber - 1];
      if (text === undefined) {
        throw new Error("Page is outside the test PDF.");
      }
      return {
        async getTextContent() {
          return { items: [{ str: text, hasEOL: false }] };
        },
        getViewport() {
          return { width: 600, height: 800 };
        },
      };
    },
  };
  const viewer: PdfViewerLike = {
    currentPageNumber: 2,
    currentScaleValue: 1,
    pagesCount: pages.length,
    setDocument: vi.fn(),
  };
  const revealPage = vi.fn(async () => undefined);
  const binding = createPdfFindRuntime({
    mediaId: "media-real-pdfjs",
    viewerModule,
    eventBus,
    revealPage,
    revealMatch: vi.fn(),
    captureOrigin: () => ({ kind: "Unavailable" }),
    restoreOrigin: async () => undefined,
  });
  binding.setViewer(viewer);
  const runtime = binding.setDocument(pdfDocument);

  const originalMatch = binding.findController.match.bind(
    binding.findController,
  );
  let matchCalls = 0;
  binding.findController.match = (...args) => {
    matchCalls += 1;
    return originalMatch(...args);
  };

  const result = await runtime.search({
    generation: 1,
    query: "needle",
    scope: { kind: "EntirePdf" },
    matchCase: true,
    wholeWord: false,
    signal: new AbortController().signal,
  });
  if (result.kind !== "Ready") {
    throw new Error("Expected the real PDF.js Find query to settle Ready.");
  }

  expect(finalCounts).toEqual([2]);
  expect(viewer.currentPageNumber).toBe(2);
  expect(binding.findController.selected).toEqual({
    pageIdx: -1,
    matchIdx: -1,
  });
  expect(result.occurrences.map(({ locator }) => locator)).toEqual([
    {
      kind: "PdfTextMatch",
      pageNumber: 1,
      matchIndexOnPage: 0,
      startUtf16: 0,
      endUtf16: 6,
    },
    {
      kind: "PdfTextMatch",
      pageNumber: 1,
      matchIndexOnPage: 1,
      startUtf16: 12,
      endUtf16: 18,
    },
  ]);

  const matchesBeforeActivation = binding.findController.pageMatches;
  const matchCallsBeforeActivation = matchCalls;
  await runtime.activate(
    result.occurrences[1]!.locator,
    new AbortController().signal,
  );

  expect(revealPage).toHaveBeenCalledWith({
    pageNumber: 1,
    signal: expect.any(AbortSignal),
  });
  expect(binding.findController.selected).toEqual({
    pageIdx: 0,
    matchIdx: 1,
  });
  expect(findTypes).toEqual(["nexus-query", "highlightallchange"]);
  expect(matchCalls).toBe(matchCallsBeforeActivation);
  expect(binding.findController.pageMatches).toBe(
    matchesBeforeActivation,
  );

  const wholeWordResult = await runtime.search({
    generation: 2,
    query: "need",
    scope: { kind: "EntirePdf" },
    matchCase: true,
    wholeWord: true,
    signal: new AbortController().signal,
  });
  expect(wholeWordResult).toEqual({
    kind: "NoMatches",
    generation: 2,
  });
  expect(viewer.currentPageNumber).toBe(2);
  expect(binding.findController.selected).toEqual({
    pageIdx: -1,
    matchIdx: -1,
  });

  const caseSensitiveResult = await runtime.search({
    generation: 3,
    query: "NEEDLE",
    scope: { kind: "EntirePdf" },
    matchCase: true,
    wholeWord: false,
    signal: new AbortController().signal,
  });
  expect(caseSensitiveResult).toEqual({
    kind: "NoMatches",
    generation: 3,
  });

  const pageResult = await runtime.search({
    generation: 4,
    query: "no",
    scope: { kind: "Page", pageNumber: 2 },
    matchCase: true,
    wholeWord: true,
    signal: new AbortController().signal,
  });
  expect(pageResult).toMatchObject({
    kind: "Ready",
    generation: 4,
    occurrences: [
      {
        locator: {
          pageNumber: 2,
          matchIndexOnPage: 0,
        },
      },
    ],
  });
  binding.dispose();
});
