import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PDF_FIND_STALL_TIMEOUT_MS,
  createPdfFindRuntime,
  type PdfFindRuntimeBinding,
} from "@/components/pdfPaneFind";
import type {
  PdfDocumentLike,
  PdfEventBusLike,
  PdfFindControllerLike,
  PdfFindMatchLike,
  PdfFindStateLike,
  PdfJsViewerLike,
  PdfLinkServiceLike,
  PdfViewerLike,
} from "@/components/pdfReaderRuntime";

interface FindState extends PdfFindStateLike {
  readonly query: string;
  readonly caseSensitive: boolean;
}

interface HarnessOptions {
  readonly pages: readonly string[];
  readonly omitFinalCount?: boolean;
  readonly throwOnFindDispatch?: boolean;
}

interface RevealRequest {
  readonly pageNumber: number;
  readonly signal: AbortSignal;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class TestEventBus implements PdfEventBusLike {
  private readonly listeners = new Map<
    string,
    Set<(event: unknown) => void>
  >();
  throwOnFindDispatch = false;
  readonly findEventTypes: string[] = [];

  on(eventName: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
  }

  off(eventName: string, listener: (event: unknown) => void): void {
    this.listeners.get(eventName)?.delete(listener);
  }

  dispatch(eventName: string, event: object): void {
    if (eventName === "find" && this.throwOnFindDispatch) {
      throw new Error("find dispatch failed");
    }
    if (
      eventName === "find" &&
      "type" in event &&
      typeof event.type === "string"
    ) {
      this.findEventTypes.push(event.type);
    }
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(event);
    }
  }

  listenerCount(eventName: string): number {
    return this.listeners.get(eventName)?.size ?? 0;
  }
}

class TestPdfViewer implements PdfViewerLike {
  currentPageNumber = 1;
  currentScaleValue: string | number = 1;
  pagesCount = 0;

  setDocument(document: PdfDocumentLike | null): void {
    this.pagesCount = document?.numPages ?? 0;
  }
}

function createHarness({
  pages,
  omitFinalCount = false,
  throwOnFindDispatch = false,
}: HarnessOptions) {
  const eventBus = new TestEventBus();
  eventBus.throwOnFindDispatch = throwOnFindDispatch;
  let getTextContentCalls = 0;
  let matchCalls = 0;
  let shouldOmitFinalCount = omitFinalCount;

  class TestPdfLinkService implements PdfLinkServiceLike {
    private document: PdfDocumentLike | null = null;
    private viewer: PdfViewerLike | null = null;

    constructor(_params?: { readonly eventBus?: PdfEventBusLike }) {}

    setDocument(document: PdfDocumentLike | null): void {
      this.document = document;
    }

    setViewer(viewer: PdfViewerLike): void {
      this.viewer = viewer;
    }

    get page(): number {
      return this.document && this.viewer
        ? this.viewer.currentPageNumber
        : 1;
    }

    set page(value: number) {
      if (this.document && this.viewer) {
        this.viewer.currentPageNumber = value;
      }
    }

    get pagesCount(): number {
      return this.document?.numPages ?? 0;
    }
  }

  class TestPdfFindController implements PdfFindControllerLike {
    private readonly linkService: PdfLinkServiceLike;
    private readonly eventBus: PdfEventBusLike;
    private document: PdfDocumentLike | null = null;
    private currentState: FindState | null = null;
    private matchesByPage: readonly (readonly number[] | undefined)[] = [];
    private lengthsByPage: readonly (readonly number[] | undefined)[] = [];
    private currentSelection = { pageIdx: -1, matchIdx: -1 };
    private highlights = false;

    constructor({
      linkService,
      eventBus,
    }: {
      readonly linkService: PdfLinkServiceLike;
      readonly eventBus: PdfEventBusLike;
      readonly updateMatchesCountOnProgress?: boolean;
    }) {
      this.linkService = linkService;
      this.eventBus = eventBus;
      eventBus.on("find", (event) => {
        this.handleFind(event);
      });
      eventBus.on("findbarclose", () => {
        this.highlights = false;
      });
    }

    get highlightMatches(): boolean {
      return this.highlights;
    }

    get pageMatches(): readonly (readonly number[] | undefined)[] {
      return this.matchesByPage;
    }

    get pageMatchesLength(): readonly (readonly number[] | undefined)[] {
      return this.lengthsByPage;
    }

    get selected() {
      return this.currentSelection;
    }

    get state(): FindState | null {
      return this.currentState;
    }

    setDocument(document: PdfDocumentLike | null): void {
      this.document = document;
      this.matchesByPage = [];
      this.lengthsByPage = [];
    }

    match(
      query: string | string[],
      pageContent: string,
      _pageIndex: number,
    ): readonly PdfFindMatchLike[] | undefined {
      matchCalls += 1;
      if (typeof query !== "string") {
        throw new Error("Test PDF Find accepts one literal query.");
      }
      const needle = this.currentState?.caseSensitive
        ? query
        : query.toLocaleLowerCase();
      const haystack = this.currentState?.caseSensitive
        ? pageContent
        : pageContent.toLocaleLowerCase();
      const matches: PdfFindMatchLike[] = [];
      let index = haystack.indexOf(needle);
      while (index >= 0) {
        matches.push({ index, length: needle.length });
        index = haystack.indexOf(needle, index + needle.length);
      }
      return matches;
    }

    scrollMatchIntoView({
      element,
    }: {
      readonly element: HTMLElement;
      readonly pageIndex: number;
      readonly matchIndex: number;
    }): void {
      element.scrollIntoView();
    }

    private handleFind(event: unknown): void {
      if (
        !this.document ||
        event === null ||
        typeof event !== "object" ||
        !("type" in event)
      ) {
        return;
      }
      if (event.type === "highlightallchange") {
        this.highlights = true;
        this.eventBus.dispatch("updatetextlayermatches", {
          source: this,
          pageIndex: -1,
        });
        return;
      }
      if (
        event.type !== "nexus-query" ||
        !("query" in event) ||
        typeof event.query !== "string"
      ) {
        return;
      }

      this.currentState = {
        query: event.query,
        caseSensitive:
          "caseSensitive" in event && event.caseSensitive === true,
        highlightAll: false,
      };
      this.highlights = true;
      const previousTotal = this.matchesByPage.reduce(
        (total, matches) => total + (matches?.length ?? 0),
        0,
      );
      this.eventBus.dispatch("updatefindmatchescount", {
        source: this,
        matchesCount: { current: 0, total: previousTotal },
      });

      const nextMatches: number[][] = [];
      const nextLengths: number[][] = [];
      let firstMatchPage = -1;
      for (
        let pageIndex = 0;
        pageIndex < pages.length;
        pageIndex += 1
      ) {
        const matches = this.match(
          event.query,
          pages[pageIndex]!,
          pageIndex,
        );
        nextMatches[pageIndex] = matches?.map(({ index }) => index) ?? [];
        nextLengths[pageIndex] =
          matches?.map(({ length }) => length) ?? [];
        if (
          firstMatchPage < 0 &&
          nextMatches[pageIndex]!.length > 0
        ) {
          firstMatchPage = pageIndex;
        }
      }
      this.matchesByPage = nextMatches;
      this.lengthsByPage = nextLengths;
      if (firstMatchPage >= 0) {
        this.currentSelection = {
          pageIdx: firstMatchPage,
          matchIdx: 0,
        };
        this.linkService.page = firstMatchPage + 1;
      }
      if (!shouldOmitFinalCount) {
        this.eventBus.dispatch("updatefindmatchescount", {
          source: this,
          matchesCount: {
            current: 0,
            total: nextMatches.reduce(
              (total, matches) => total + matches.length,
              0,
            ),
          },
        });
      }
    }
  }

  class UnusedPdfViewer extends TestPdfViewer {
    constructor(_params: {
      readonly container: HTMLDivElement;
      readonly viewer: HTMLDivElement;
      readonly eventBus: PdfEventBusLike;
      readonly linkService: PdfLinkServiceLike;
      readonly findController?: PdfFindControllerLike;
    }) {
      super();
    }
  }

  const viewerModule: PdfJsViewerLike = {
    EventBus: TestEventBus,
    PDFLinkService: TestPdfLinkService,
    PDFFindController: TestPdfFindController,
    PDFViewer: UnusedPdfViewer,
  };
  const document: PdfDocumentLike = {
    fingerprints: ["fingerprint", null],
    numPages: pages.length,
    async getPage(pageNumber) {
      const text = pages[pageNumber - 1];
      if (text === undefined) {
        throw new Error("Page is outside the test PDF.");
      }
      return {
        async getTextContent() {
          getTextContentCalls += 1;
          return {
            items: [{ str: text, hasEOL: false }],
          };
        },
        getViewport() {
          return { width: 600, height: 800 };
        },
      };
    },
  };
  const viewer = new TestPdfViewer();
  viewer.currentPageNumber = Math.min(2, pages.length);
  viewer.setDocument(document);
  let binding: PdfFindRuntimeBinding | null = null;
  let reveal: (request: RevealRequest) => Promise<void> = async () => {};
  let restore: (
    _origin: {
      readonly pageNumber: number;
      readonly zoom: number;
      readonly pageTopDeltaPx: number;
      readonly scrollLeft: number;
    },
    _signal: AbortSignal,
  ) => Promise<void> = async () => {};
  binding = createPdfFindRuntime({
    mediaId: "media-1",
    viewerModule,
    eventBus,
    revealPage: (request) => reveal(request),
    captureOrigin: () => ({
      kind: "Captured",
      value: {
        pageNumber: viewer.currentPageNumber,
        zoom: 1,
        pageTopDeltaPx: 0,
        scrollLeft: 0,
      },
    }),
    restoreOrigin: (origin, signal) => restore(origin, signal),
  });
  binding.setViewer(viewer);
  const runtime = binding.setDocument(document);

  return {
    binding,
    eventBus,
    runtime,
    viewer,
    getTextContentCalls: () => getTextContentCalls,
    matchCalls: () => matchCalls,
    setReveal(nextReveal: (request: RevealRequest) => Promise<void>) {
      reveal = nextReveal;
    },
    setRestore(
      nextRestore: typeof restore,
    ) {
      restore = nextRestore;
    },
    rebindDocument() {
      return binding.setDocument(document);
    },
    setOmitFinalCount(value: boolean) {
      shouldOmitFinalCount = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PDF Find runtime", () => {
  it("ignores an early mixed count, settles after full page coverage, and suppresses PDF.js navigation", async () => {
    const harness = createHarness({
      pages: ["needle on the first page", "second page"],
    });
    const result = await harness.runtime.search({
      generation: 1,
      query: "needle",
      scope: { kind: "EntirePdf" },
      matchCase: false,
      wholeWord: false,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      kind: "Ready",
      generation: 1,
      occurrences: [
        {
          locator: {
            kind: "PdfTextMatch",
            pageNumber: 1,
            matchIndexOnPage: 0,
            startUtf16: 0,
            endUtf16: 6,
          },
        },
      ],
    });
    expect(harness.viewer.currentPageNumber).toBe(2);
    expect(
      harness.eventBus.listenerCount("updatefindcontrolstate"),
    ).toBe(0);
  });

  it("retires a superseded generation and ignores its early mixed count", async () => {
    const harness = createHarness({
      pages: ["needle", "another needle"],
      omitFinalCount: true,
    });
    const first = harness.runtime
      .search({
        generation: 1,
        query: "missing",
        scope: { kind: "EntirePdf" },
        matchCase: false,
        wholeWord: false,
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => error);

    harness.setOmitFinalCount(false);
    const second = harness.runtime.search({
      generation: 2,
      query: "needle",
      scope: { kind: "EntirePdf" },
      matchCase: false,
      wholeWord: false,
      signal: new AbortController().signal,
    });

    await expect(first).resolves.toMatchObject({
      name: "AbortError",
    });
    const secondResult = await second;
    expect(secondResult.kind).toBe("Ready");
    if (secondResult.kind !== "Ready") {
      throw new Error("Expected the current PDF Find generation to settle.");
    }
    expect(secondResult.generation).toBe(2);
    expect(
      secondResult.occurrences.map(({ locator }) => locator.pageNumber),
    ).toEqual([1, 2]);
  });

  it("maps a find dispatch failure and a fully covered stall to RuntimeUnavailable", async () => {
    const dispatchFailure = createHarness({
      pages: ["text"],
      throwOnFindDispatch: true,
    });
    await expect(
      dispatchFailure.runtime.search({
        generation: 1,
        query: "text",
        scope: { kind: "EntirePdf" },
        matchCase: false,
        wholeWord: false,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "RuntimeUnavailable",
      generation: 1,
    });

    vi.useFakeTimers();
    const stalled = createHarness({
      pages: ["text"],
      omitFinalCount: true,
    });
    const result = stalled.runtime.search({
      generation: 2,
      query: "text",
      scope: { kind: "EntirePdf" },
      matchCase: false,
      wholeWord: false,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(PDF_FIND_STALL_TIMEOUT_MS);
    await expect(result).resolves.toEqual({
      kind: "RuntimeUnavailable",
      generation: 2,
    });
  });

  it("returns TooManyMatches before loading snippet text", async () => {
    const harness = createHarness({
      pages: [Array.from({ length: 2_001 }, () => "x").join(" ")],
    });
    await expect(
      harness.runtime.search({
        generation: 1,
        query: "x",
        scope: { kind: "EntirePdf" },
        matchCase: true,
        wholeWord: false,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "TooManyMatches",
      generation: 1,
      threshold: 2_000,
    });
    expect(harness.getTextContentCalls()).toBe(0);
  });

  it("distinguishes empty scoped text from an ordinary complete miss", async () => {
    const documentEmpty = createHarness({ pages: ["", ""] });
    await expect(
      documentEmpty.runtime.search({
        generation: 1,
        query: "needle",
        scope: { kind: "EntirePdf" },
        matchCase: false,
        wholeWord: false,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "TextUnavailable",
      generation: 1,
    });
    expect(documentEmpty.viewer.currentPageNumber).toBe(2);

    const mixed = createHarness({ pages: ["", "searchable text"] });
    await expect(
      mixed.runtime.search({
        generation: 1,
        query: "needle",
        scope: { kind: "Page", pageNumber: 1 },
        matchCase: false,
        wholeWord: false,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "NoMatches",
      generation: 1,
    });
    await expect(
      mixed.runtime.search({
        generation: 2,
        query: "needle",
        scope: { kind: "Page", pageNumber: 2 },
        matchCase: false,
        wholeWord: false,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      kind: "NoMatches",
      generation: 2,
    });
    expect(mixed.viewer.currentPageNumber).toBe(2);
  });

  it("consumes the selected-match scroll guard before a zoom repaint", async () => {
    const harness = createHarness({ pages: ["needle"] });
    const result = await harness.runtime.search({
      generation: 1,
      query: "needle",
      scope: { kind: "EntirePdf" },
      matchCase: true,
      wholeWord: false,
      signal: new AbortController().signal,
    });
    if (result.kind !== "Ready") {
      throw new Error("Expected a ready PDF Find result.");
    }

    const element = document.createElement("span");
    element.scrollIntoView = vi.fn();
    const matchesBefore = harness.binding.findController.pageMatches;
    const matchCallsBefore = harness.matchCalls();
    harness.setReveal(async () => {
      harness.binding.findController.scrollMatchIntoView({
        element,
        pageIndex: 0,
        matchIndex: 0,
      });
    });
    await harness.runtime.activate(
      result.occurrences[0]!.locator,
      new AbortController().signal,
    );
    harness.binding.findController.scrollMatchIntoView({
      element,
      pageIndex: 0,
      matchIndex: 0,
    });

    expect(element.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(harness.eventBus.findEventTypes.at(-1)).toBe(
      "highlightallchange",
    );
    expect(harness.matchCalls()).toBe(matchCallsBefore);
    expect(harness.binding.findController.pageMatches).toBe(matchesBefore);
  });

  it("does not let an aborted stale activation roll back the current selection or scroll", async () => {
    const harness = createHarness({
      pages: ["first target", "second target"],
    });
    const result = await harness.runtime.search({
      generation: 1,
      query: "target",
      scope: { kind: "EntirePdf" },
      matchCase: true,
      wholeWord: false,
      signal: new AbortController().signal,
    });
    if (result.kind !== "Ready") {
      throw new Error("Expected ready PDF Find occurrences.");
    }

    const firstReveal = deferred();
    const secondReveal = deferred();
    const revealSignals: AbortSignal[] = [];
    harness.setReveal(async ({ signal }) => {
      revealSignals.push(signal);
      return revealSignals.length === 1
        ? firstReveal.promise
        : secondReveal.promise;
    });

    const firstActivation = harness.runtime
      .activate(
        result.occurrences[0]!.locator,
        new AbortController().signal,
      )
      .catch((error: unknown) => error);
    const secondActivation = harness.runtime.activate(
      result.occurrences[1]!.locator,
      new AbortController().signal,
    );

    expect(revealSignals[0]?.aborted).toBe(true);
    firstReveal.reject(new DOMException("aborted", "AbortError"));
    await expect(firstActivation).resolves.toMatchObject({
      name: "AbortError",
    });
    expect(harness.binding.findController.selected).toEqual({
      pageIdx: 1,
      matchIdx: 0,
    });

    const staleElement = document.createElement("span");
    staleElement.scrollIntoView = vi.fn();
    harness.binding.findController.scrollMatchIntoView({
      element: staleElement,
      pageIndex: 0,
      matchIndex: 0,
    });
    const currentElement = document.createElement("span");
    currentElement.scrollIntoView = vi.fn();
    harness.binding.findController.scrollMatchIntoView({
      element: currentElement,
      pageIndex: 1,
      matchIndex: 0,
    });
    secondReveal.resolve();
    await secondActivation;

    expect(staleElement.scrollIntoView).not.toHaveBeenCalled();
    expect(currentElement.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(harness.binding.findController.selected).toEqual({
      pageIdx: 1,
      matchIdx: 0,
    });
  });

  it("aborts a deferred activation when the same PDF document is rebound", async () => {
    const harness = createHarness({
      pages: ["first target", "second replacement"],
    });
    const initialResult = await harness.runtime.search({
      generation: 1,
      query: "target",
      scope: { kind: "EntirePdf" },
      matchCase: true,
      wholeWord: false,
      signal: new AbortController().signal,
    });
    if (initialResult.kind !== "Ready") {
      throw new Error("Expected an initial PDF Find occurrence.");
    }

    const staleReveal = deferred();
    const staleRevealSignals: AbortSignal[] = [];
    harness.setReveal(({ signal }) => {
      staleRevealSignals.push(signal);
      return staleReveal.promise;
    });
    const staleActivation = harness.runtime
      .activate(
        initialResult.occurrences[0]!.locator,
        new AbortController().signal,
      )
      .catch((error: unknown) => error);

    const replacementRuntime = harness.rebindDocument();
    expect(staleRevealSignals).toHaveLength(1);
    expect(staleRevealSignals[0]!.aborted).toBe(true);
    const replacementResult = await replacementRuntime.search({
      generation: 2,
      query: "replacement",
      scope: { kind: "EntirePdf" },
      matchCase: true,
      wholeWord: false,
      signal: new AbortController().signal,
    });
    if (replacementResult.kind !== "Ready") {
      throw new Error("Expected a replacement PDF Find occurrence.");
    }
    harness.setReveal(async () => undefined);
    await replacementRuntime.activate(
      replacementResult.occurrences[0]!.locator,
      new AbortController().signal,
    );

    staleReveal.resolve();
    await expect(staleActivation).resolves.toMatchObject({
      name: "AbortError",
    });
    expect(harness.binding.findController.selected).toEqual({
      pageIdx: 1,
      matchIdx: 0,
    });
  });

  it("aborts a deferred origin restore when the same PDF document is rebound", async () => {
    const harness = createHarness({ pages: ["one", "two"] });
    const staleRestore = deferred();
    const staleRestoreSignals: AbortSignal[] = [];
    harness.setRestore(async (origin, signal) => {
      staleRestoreSignals.push(signal);
      await staleRestore.promise;
      if (!signal.aborted) {
        harness.viewer.currentPageNumber = origin.pageNumber;
      }
    });
    const restore = harness.runtime
      .restoreOrigin(
        {
          pageNumber: 1,
          zoom: 1,
          pageTopDeltaPx: 0,
          scrollLeft: 0,
        },
        new AbortController().signal,
      )
      .catch((error: unknown) => error);

    harness.rebindDocument();
    harness.viewer.currentPageNumber = 2;
    expect(staleRestoreSignals).toHaveLength(1);
    expect(staleRestoreSignals[0]!.aborted).toBe(true);
    staleRestore.resolve();

    await expect(restore).resolves.toMatchObject({
      name: "AbortError",
    });
    expect(harness.viewer.currentPageNumber).toBe(2);
  });
});
