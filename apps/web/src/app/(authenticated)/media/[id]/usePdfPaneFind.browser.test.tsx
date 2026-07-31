import { describe, expect, it, vi } from "vitest";
import type {
  PdfFindOrigin,
  PdfFindRuntime,
  PdfRuntimeFindRequest,
  PdfRuntimeFindResult,
} from "@/components/pdfPaneFind";
import { pdfFindSourceAccessRefreshAbort } from "@/components/pdfPaneFind";
import { createMediaFindPreviewLease } from "./mediaFindPreviewLease";
import { createPdfFindAdapter } from "./usePdfPaneFind";

function pdfOrigin(
  pageNumber: number,
  pageTopDeltaPx: number,
): PdfFindOrigin {
  return {
    pageNumber,
    zoom: 1.25,
    pageTopDeltaPx,
    scrollLeft: 18,
  };
}

function readyResult(generation: number): PdfRuntimeFindResult {
  return {
    kind: "Ready",
    generation,
    occurrences: [
      {
        locator: {
          kind: "PdfTextMatch",
          pageNumber: 3,
          matchIndexOnPage: 0,
          startUtf16: 7,
          endUtf16: 13,
        },
        snippet: [
          { text: "before ", emphasized: false },
          { text: "needle", emphasized: true },
          { text: " after", emphasized: false },
        ],
      },
    ],
  };
}

function runtimeFixture({
  captureOrigin = () => ({
    kind: "Captured" as const,
    value: pdfOrigin(3, 24),
  }),
  search = async (request: PdfRuntimeFindRequest) =>
    readyResult(request.generation),
}: {
  readonly captureOrigin?: PdfFindRuntime["captureOrigin"];
  readonly search?: PdfFindRuntime["search"];
} = {}) {
  const runtime = {
    source: {
      mediaId: "media-1",
      fingerprints: ["original", null, "incremental"],
      numPages: 12,
    },
    search: vi.fn(search),
    activate: vi.fn<PdfFindRuntime["activate"]>(async () => {}),
    captureOrigin: vi.fn(captureOrigin),
    restoreOrigin: vi.fn<PdfFindRuntime["restoreOrigin"]>(async () => {}),
    clearPresentation: vi.fn(),
  } satisfies PdfFindRuntime;
  return runtime;
}

const focusReaderViewport = vi.fn();

async function prepare(
  adapter: ReturnType<typeof createPdfFindAdapter>,
) {
  const signal = new AbortController().signal;
  const session = await adapter.prepare({
    sessionId: 1,
    sourceKey: adapter.sourceKey,
    signal,
  });
  return { session, signal };
}

describe("PDF Pane Find adapter", () => {
  it("uses full source identity, compact result keys, exact scopes, and one-shot Return", async () => {
    const runtime = runtimeFixture();
    const previewLease = createMediaFindPreviewLease();
    const focusBeforeLeaseRelease = vi.fn(() => {
      expect(previewLease.isActive()).toBe(true);
    });
    const adapter = createPdfFindAdapter({
      mediaId: "media-1",
      runtime,
      getCurrentRuntime: () => runtime,
      previewLease,
      focusReaderViewport: focusBeforeLeaseRelease,
    });
    const { session, signal } = await prepare(adapter);

    expect(JSON.parse(adapter.sourceKey)).toEqual({
      kind: "Pdf",
      mediaId: "media-1",
      fingerprints: ["original", null, "incremental"],
      numPages: 12,
    });
    expect(session.scopes).toEqual([
      {
        kind: "EntireResource",
        id: "EntirePdf",
        label: "Entire PDF",
      },
      {
        kind: "Narrow",
        id: "Page:3",
        label: "This page (3)",
      },
    ]);

    const response = await adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal,
      query: "needle",
      scopeId: "EntirePdf",
      matchCase: true,
      wholeWord: true,
    });
    if (response.kind !== "Ready") {
      throw new Error("Expected PDF Find results.");
    }
    expect(previewLease.isActive()).toBe(true);
    expect(runtime.search).toHaveBeenCalledWith({
      generation: 1,
      query: "needle",
      scope: { kind: "EntirePdf" },
      matchCase: true,
      wholeWord: true,
      signal,
    });
    expect(response.rows[0]).toMatchObject({
      context: ["Page 3"],
      snippet: [
        { text: "before ", emphasized: false },
        { text: "needle", emphasized: true },
        { text: " after", emphasized: false },
      ],
    });
    expect(JSON.parse(response.rows[0]!.key)).toEqual({
      source: { kind: "Pdf", mediaId: "media-1" },
      locator: {
        kind: "PdfTextMatch",
        pageNumber: 3,
        matchIndexOnPage: 0,
        startUtf16: 7,
        endUtf16: 13,
      },
    });

    await expect(
      adapter.preview({
        sessionId: 1,
        queryId: 1,
        sourceKey: adapter.sourceKey,
        signal,
        key: response.rows[0]!.key,
      }),
    ).resolves.toMatchObject({ kind: "Previewed" });
    await adapter.returnToReadingPosition({
      sessionId: 1,
      sourceKey: adapter.sourceKey,
      signal,
    });

    expect(runtime.activate).toHaveBeenCalledWith(
      {
        kind: "PdfTextMatch",
        pageNumber: 3,
        matchIndexOnPage: 0,
        startUtf16: 7,
        endUtf16: 13,
      },
      signal,
    );
    expect(runtime.restoreOrigin).toHaveBeenCalledWith(
      pdfOrigin(3, 24),
      signal,
    );
    expect(focusBeforeLeaseRelease).toHaveBeenCalledTimes(1);
    expect(previewLease.isActive()).toBe(false);
    expect(previewLease.consumeNextCaptureSuppression(false)).toBe(true);
  });

  it("finishes Return against a republished runtime after source access refresh", async () => {
    const initialRuntime = runtimeFixture();
    const refreshedRuntime = runtimeFixture();
    let currentRuntime: PdfFindRuntime = initialRuntime;
    initialRuntime.restoreOrigin.mockImplementation(async () => {
      currentRuntime = refreshedRuntime;
      throw pdfFindSourceAccessRefreshAbort();
    });
    const previewLease = createMediaFindPreviewLease();
    const adapter = createPdfFindAdapter({
      mediaId: "media-1",
      runtime: initialRuntime,
      getCurrentRuntime: () => currentRuntime,
      previewLease,
      focusReaderViewport,
    });
    const { signal } = await prepare(adapter);
    const response = await adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal,
      query: "needle",
      scopeId: "EntirePdf",
      matchCase: false,
      wholeWord: false,
    });
    if (response.kind !== "Ready") {
      throw new Error("Expected PDF Find results.");
    }
    await adapter.preview({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal,
      key: response.rows[0]!.key,
    });
    const initialClearCount = initialRuntime.clearPresentation.mock.calls.length;

    await adapter.returnToReadingPosition({
      sessionId: 1,
      sourceKey: adapter.sourceKey,
      signal,
    });

    expect(initialRuntime.restoreOrigin).toHaveBeenCalledWith(
      pdfOrigin(3, 24),
      signal,
    );
    expect(refreshedRuntime.restoreOrigin).toHaveBeenCalledWith(
      pdfOrigin(3, 24),
      signal,
    );
    expect(initialRuntime.clearPresentation).toHaveBeenCalledTimes(
      initialClearCount,
    );
    expect(refreshedRuntime.clearPresentation).toHaveBeenCalledTimes(1);
    expect(previewLease.isActive()).toBe(false);
    expect(previewLease.consumeNextCaptureSuppression(false)).toBe(true);
  });

  it("maps empty page text to NoMatches and whole-document text failure to retryable copy", async () => {
    const runtime = runtimeFixture({
      search: async (request) => ({
        kind: "TextUnavailable",
        generation: request.generation,
      }),
    });
    const adapter = createPdfFindAdapter({
      mediaId: "media-1",
      runtime,
      getCurrentRuntime: () => runtime,
      previewLease: createMediaFindPreviewLease(),
      focusReaderViewport,
    });
    const { signal } = await prepare(adapter);

    await expect(
      adapter.find({
        sessionId: 1,
        queryId: 1,
        sourceKey: adapter.sourceKey,
        signal,
        query: "needle",
        scopeId: "Page:3",
        matchCase: false,
        wholeWord: false,
      }),
    ).resolves.toEqual({
      kind: "NoMatches",
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      completeness: "Complete",
    });

    const entire = await adapter.find({
      sessionId: 1,
      queryId: 2,
      sourceKey: adapter.sourceKey,
      signal,
      query: "needle",
      scopeId: "EntirePdf",
      matchCase: false,
      wholeWord: false,
    });
    if (entire.kind !== "Failed") {
      throw new Error("Expected whole-PDF text failure.");
    }
    expect(adapter.errorMessage(entire.error)).toBe(
      "Searchable text could not be extracted from this PDF. Retry does not perform OCR.",
    );
  });

  it("recaptures a provisional origin after genuine input before first activation", async () => {
    const firstOrigin = pdfOrigin(3, 24);
    const liveOrigin = pdfOrigin(6, 80);
    const captureOrigin = vi
      .fn<PdfFindRuntime["captureOrigin"]>()
      .mockReturnValueOnce({ kind: "Captured", value: firstOrigin })
      .mockReturnValueOnce({ kind: "Captured", value: firstOrigin })
      .mockReturnValueOnce({ kind: "Captured", value: liveOrigin });
    const runtime = runtimeFixture({ captureOrigin });
    const previewLease = createMediaFindPreviewLease();
    const adapter = createPdfFindAdapter({
      mediaId: "media-1",
      runtime,
      getCurrentRuntime: () => runtime,
      previewLease,
      focusReaderViewport,
    });
    const { signal } = await prepare(adapter);
    const response = await adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal,
      query: "needle",
      scopeId: "EntirePdf",
      matchCase: false,
      wholeWord: false,
    });
    if (response.kind !== "Ready") {
      throw new Error("Expected PDF Find results.");
    }

    previewLease.releaseForGenuineInput();
    await adapter.preview({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal,
      key: response.rows[0]!.key,
    });
    await adapter.returnToReadingPosition({
      sessionId: 1,
      sourceKey: adapter.sourceKey,
      signal,
    });

    expect(runtime.restoreOrigin).toHaveBeenCalledWith(liveOrigin, signal);
  });

  it("keeps a superseding first preview from a late aborted preview rollback", async () => {
    let rejectFirstPreview!: (error: unknown) => void;
    const runtime = runtimeFixture({
      search: async (request) => ({
        kind: "Ready",
        generation: request.generation,
        occurrences: [
          {
            locator: {
              kind: "PdfTextMatch",
              pageNumber: 3,
              matchIndexOnPage: 0,
              startUtf16: 7,
              endUtf16: 13,
            },
            snippet: [{ text: "first", emphasized: true }],
          },
          {
            locator: {
              kind: "PdfTextMatch",
              pageNumber: 3,
              matchIndexOnPage: 1,
              startUtf16: 20,
              endUtf16: 26,
            },
            snippet: [{ text: "second", emphasized: true }],
          },
        ],
      }),
    });
    runtime.activate.mockImplementation((locator) =>
      locator.matchIndexOnPage === 0
        ? new Promise((_resolve, reject) => {
            rejectFirstPreview = reject;
          })
        : Promise.resolve(),
    );
    const previewLease = createMediaFindPreviewLease();
    const adapter = createPdfFindAdapter({
      mediaId: "media-1",
      runtime,
      getCurrentRuntime: () => runtime,
      previewLease,
      focusReaderViewport,
    });
    const { signal } = await prepare(adapter);
    const response = await adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal,
      query: "needle",
      scopeId: "EntirePdf",
      matchCase: false,
      wholeWord: false,
    });
    if (response.kind !== "Ready") {
      throw new Error("Expected PDF Find results.");
    }

    const firstAbort = new AbortController();
    const firstPreview = adapter.preview({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal: firstAbort.signal,
      key: response.rows[0]!.key,
    });
    firstAbort.abort();
    await expect(
      adapter.preview({
        sessionId: 1,
        queryId: 1,
        sourceKey: adapter.sourceKey,
        signal,
        key: response.rows[1]!.key,
      }),
    ).resolves.toMatchObject({
      kind: "Previewed",
      key: response.rows[1]!.key,
    });
    rejectFirstPreview(
      new DOMException("First preview was superseded.", "AbortError"),
    );
    await expect(firstPreview).rejects.toMatchObject({ name: "AbortError" });

    expect(runtime.restoreOrigin).not.toHaveBeenCalled();
    expect(runtime.clearPresentation).toHaveBeenCalledTimes(1);
    expect(previewLease.isActive()).toBe(true);

    await adapter.returnToReadingPosition({
      sessionId: 1,
      sourceKey: adapter.sourceKey,
      signal,
    });
    expect(runtime.restoreOrigin).toHaveBeenCalledWith(
      pdfOrigin(3, 24),
      signal,
    );
    expect(previewLease.isActive()).toBe(false);
  });

  it("retires an aborted provisional preview when its replacement query settles neutrally", async () => {
    let rejectFirstPreview!: (error: unknown) => void;
    const runtime = runtimeFixture({
      search: vi
        .fn<PdfFindRuntime["search"]>()
        .mockImplementationOnce(async (request) =>
          readyResult(request.generation),
        )
        .mockImplementationOnce(async (request) => ({
          kind: "NoMatches",
          generation: request.generation,
        })),
    });
    runtime.activate.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirstPreview = reject;
        }),
    );
    const previewLease = createMediaFindPreviewLease();
    const adapter = createPdfFindAdapter({
      mediaId: "media-1",
      runtime,
      getCurrentRuntime: () => runtime,
      previewLease,
      focusReaderViewport,
    });
    const { signal } = await prepare(adapter);
    const first = await adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal,
      query: "needle",
      scopeId: "EntirePdf",
      matchCase: false,
      wholeWord: false,
    });
    if (first.kind !== "Ready") {
      throw new Error("Expected PDF Find results.");
    }

    const previewAbort = new AbortController();
    const preview = adapter.preview({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal: previewAbort.signal,
      key: first.rows[0]!.key,
    });
    previewAbort.abort();
    await adapter.clearPresentation({
      sessionId: 1,
      sourceKey: adapter.sourceKey,
      signal,
    });
    expect(previewLease.isActive()).toBe(true);

    await expect(
      adapter.find({
        sessionId: 1,
        queryId: 2,
        sourceKey: adapter.sourceKey,
        signal,
        query: "absent",
        scopeId: "EntirePdf",
        matchCase: false,
        wholeWord: false,
      }),
    ).resolves.toMatchObject({ kind: "NoMatches", queryId: 2 });
    expect(previewLease.isActive()).toBe(false);

    rejectFirstPreview(
      new DOMException("First preview was superseded.", "AbortError"),
    );
    await expect(preview).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.restoreOrigin).not.toHaveBeenCalled();
    expect(previewLease.isActive()).toBe(false);

    await adapter.returnToReadingPosition({
      sessionId: 1,
      sourceKey: adapter.sourceKey,
      signal,
    });
    expect(runtime.restoreOrigin).not.toHaveBeenCalled();
  });

  it("restores the pre-query fence when Close aborts a query after genuine input", async () => {
    let settleSecondQuery!: (result: PdfRuntimeFindResult) => void;
    const runtime = runtimeFixture({
      search: vi
        .fn<PdfFindRuntime["search"]>()
        .mockImplementationOnce(async (request) =>
          readyResult(request.generation),
        )
        .mockImplementationOnce(
          (request) =>
            new Promise((resolve) => {
              settleSecondQuery = () =>
                resolve({
                  kind: "RuntimeUnavailable",
                  generation: request.generation,
                });
            }),
        ),
    });
    const previewLease = createMediaFindPreviewLease();
    const adapter = createPdfFindAdapter({
      mediaId: "media-1",
      runtime,
      getCurrentRuntime: () => runtime,
      previewLease,
      focusReaderViewport,
    });
    const { signal } = await prepare(adapter);
    const first = await adapter.find({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal,
      query: "needle",
      scopeId: "EntirePdf",
      matchCase: false,
      wholeWord: false,
    });
    if (first.kind !== "Ready") {
      throw new Error("Expected PDF Find results.");
    }
    await adapter.preview({
      sessionId: 1,
      queryId: 1,
      sourceKey: adapter.sourceKey,
      signal,
      key: first.rows[0]!.key,
    });
    previewLease.releaseForGenuineInput();
    expect(previewLease.isActive()).toBe(false);

    const queryAbort = new AbortController();
    const second = adapter.find({
      sessionId: 1,
      queryId: 2,
      sourceKey: adapter.sourceKey,
      signal: queryAbort.signal,
      query: "other",
      scopeId: "EntirePdf",
      matchCase: false,
      wholeWord: false,
    });
    expect(previewLease.isActive()).toBe(true);
    queryAbort.abort();
    await adapter.clearPresentation({
      sessionId: 1,
      sourceKey: adapter.sourceKey,
      signal,
    });
    expect(previewLease.isActive()).toBe(false);
    settleSecondQuery({
      kind: "RuntimeUnavailable",
      generation: 2,
    });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });

    await adapter.returnToReadingPosition({
      sessionId: 1,
      sourceKey: adapter.sourceKey,
      signal,
    });
    expect(runtime.restoreOrigin).toHaveBeenCalledWith(
      pdfOrigin(3, 24),
      signal,
    );
    expect(previewLease.isActive()).toBe(false);
  });
});
