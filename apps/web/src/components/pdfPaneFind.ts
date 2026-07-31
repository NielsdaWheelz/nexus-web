"use client";

import type { EmphasisSegment } from "@/lib/ui/emphasis";
import { canonicalTextFindSnippet } from "@/lib/reader/canonicalTextFind";
import type {
  PdfDocumentLike,
  PdfEventBusLike,
  PdfFindControllerLike,
  PdfFindMatchLike,
  PdfFindSelectionLike,
  PdfJsViewerLike,
  PdfLinkServiceLike,
  PdfTextItemLike,
  PdfViewerLike,
} from "@/components/pdfReaderRuntime";

export const PDF_FIND_MATCH_THRESHOLD = 2_000;
export const PDF_FIND_STALL_TIMEOUT_MS = 30_000;

export type PdfFindError =
  | { readonly kind: "OriginUnavailable" }
  | { readonly kind: "TextUnavailable"; readonly scope: "EntirePdf" }
  | { readonly kind: "RuntimeUnavailable" };

export interface PdfFindSource {
  readonly mediaId: string;
  readonly fingerprints: readonly (string | null)[];
  readonly numPages: number;
}

export type PdfFindScope =
  | { readonly kind: "EntirePdf" }
  | { readonly kind: "Page"; readonly pageNumber: number };

export interface PdfFindLocator {
  readonly kind: "PdfTextMatch";
  readonly pageNumber: number;
  readonly matchIndexOnPage: number;
  readonly startUtf16: number;
  readonly endUtf16: number;
}

export interface PdfFindOrigin {
  readonly pageNumber: number;
  readonly zoom: number;
  readonly pageTopDeltaPx: number;
  readonly scrollLeft: number;
}

export type PdfFindOriginCapture =
  | { readonly kind: "Captured"; readonly value: PdfFindOrigin }
  | { readonly kind: "Unavailable" };

export interface PdfRuntimeFindRequest {
  readonly generation: number;
  readonly query: string;
  readonly scope: PdfFindScope;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly signal: AbortSignal;
}

export interface PdfRuntimeFindOccurrence {
  readonly locator: PdfFindLocator;
  readonly snippet: readonly EmphasisSegment[];
}

export type PdfRuntimeFindResult =
  | {
      readonly kind: "Ready";
      readonly generation: number;
      readonly occurrences: readonly PdfRuntimeFindOccurrence[];
    }
  | { readonly kind: "NoMatches"; readonly generation: number }
  | {
      readonly kind: "TooManyMatches";
      readonly generation: number;
      readonly threshold: 2_000;
    }
  | { readonly kind: "TextUnavailable"; readonly generation: number }
  | { readonly kind: "RuntimeUnavailable"; readonly generation: number };

export interface PdfFindRuntime {
  readonly source: PdfFindSource;
  search(request: PdfRuntimeFindRequest): Promise<PdfRuntimeFindResult>;
  activate(locator: PdfFindLocator, signal: AbortSignal): Promise<void>;
  captureOrigin(): PdfFindOriginCapture;
  restoreOrigin(origin: PdfFindOrigin, signal: AbortSignal): Promise<void>;
  clearPresentation(): void;
}

export interface CreatePdfFindRuntimeOptions {
  readonly mediaId: string;
  readonly viewerModule: PdfJsViewerLike;
  readonly eventBus: PdfEventBusLike;
  readonly revealPage: (request: {
    readonly pageNumber: number;
    readonly signal: AbortSignal;
  }) => Promise<void>;
  readonly revealMatch: (element: HTMLElement) => void;
  readonly captureOrigin: () => PdfFindOriginCapture;
  readonly restoreOrigin: (
    origin: PdfFindOrigin,
    signal: AbortSignal,
  ) => Promise<void>;
}

export interface PdfFindRuntimeBinding {
  readonly findController: PdfFindControllerLike;
  readonly findLinkService: PdfLinkServiceLike;
  setViewer(viewer: PdfViewerLike): void;
  setDocument(document: PdfDocumentLike): PdfFindRuntime;
  setDocument(document: null): null;
  dispose(): void;
}

interface PdfFindEventState {
  readonly type: "nexus-query" | "highlightallchange";
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly entireWord: boolean;
  readonly matchDiacritics: true;
  readonly highlightAll: boolean;
  readonly findPrevious: false;
}

type SearchSettlement =
  | { readonly kind: "Complete" }
  | { readonly kind: "RuntimeUnavailable" };

interface ActiveSearch {
  readonly generation: number;
  readonly scope: PdfFindScope;
  readonly signal: AbortSignal;
  readonly coverage: Set<number>;
  readonly settlement: Promise<SearchSettlement>;
  readonly abort: Promise<never>;
  readonly resolve: (settlement: SearchSettlement) => void;
  readonly reject: (error: unknown) => void;
  readonly rejectAbort: (error: unknown) => void;
  readonly onAbort: () => void;
  textPresent: boolean;
  settled: boolean;
  stallTimer: ReturnType<typeof setTimeout> | null;
}

interface PageMatches {
  readonly starts: readonly number[];
  readonly lengths: readonly number[];
}

interface DocumentLifetime {
  readonly abortController: AbortController;
}

function abortError(): DOMException {
  return new DOMException("PDF Find was aborted.", "AbortError");
}

async function runDocumentCommand<T>({
  lifetime,
  callerSignal,
  isCurrent,
  command,
}: {
  readonly lifetime: DocumentLifetime;
  readonly callerSignal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly command: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  if (
    callerSignal.aborted ||
    lifetime.abortController.signal.aborted ||
    !isCurrent()
  ) {
    throw abortError();
  }

  const commandAbortController = new AbortController();
  const abortCommand = () => {
    commandAbortController.abort();
  };
  callerSignal.addEventListener("abort", abortCommand, { once: true });
  lifetime.abortController.signal.addEventListener("abort", abortCommand, {
    once: true,
  });
  if (
    callerSignal.aborted ||
    lifetime.abortController.signal.aborted ||
    !isCurrent()
  ) {
    abortCommand();
  }

  try {
    const result = await command(commandAbortController.signal);
    if (commandAbortController.signal.aborted || !isCurrent()) {
      throw abortError();
    }
    return result;
  } catch (error) {
    if (commandAbortController.signal.aborted || !isCurrent()) {
      throw abortError();
    }
    throw error;
  } finally {
    callerSignal.removeEventListener("abort", abortCommand);
    lifetime.abortController.signal.removeEventListener(
      "abort",
      abortCommand,
    );
  }
}

function assertCurrentScope(scope: PdfFindScope, numPages: number): void {
  switch (scope.kind) {
    case "EntirePdf":
      return;
    case "Page":
      if (
        !Number.isSafeInteger(scope.pageNumber) ||
        scope.pageNumber < 1 ||
        scope.pageNumber > numPages
      ) {
        throw new Error("PDF Find page scope is outside the loaded document.");
      }
      return;
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unknown PDF Find scope: ${String(exhaustive)}`);
    }
  }
}

function pageIsInScope(scope: PdfFindScope, pageIndex: number): boolean {
  switch (scope.kind) {
    case "EntirePdf":
      return true;
    case "Page":
      return pageIndex === scope.pageNumber - 1;
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unknown PDF Find scope: ${String(exhaustive)}`);
    }
  }
}

function finalPageMatches(
  controller: PdfFindControllerLike,
  numPages: number,
): { readonly pages: readonly PageMatches[]; readonly total: number } {
  const startsByPage = controller.pageMatches;
  const lengthsByPage = controller.pageMatchesLength;
  if (!startsByPage || !lengthsByPage) {
    throw new Error("PDF.js Find did not publish final match arrays.");
  }

  const pages: PageMatches[] = [];
  let total = 0;
  for (let pageIndex = 0; pageIndex < numPages; pageIndex += 1) {
    const starts = startsByPage[pageIndex];
    const lengths = lengthsByPage[pageIndex];
    if (!Array.isArray(starts) || !Array.isArray(lengths)) {
      throw new Error("PDF.js Find final page coverage is incomplete.");
    }
    if (starts.length !== lengths.length) {
      throw new Error("PDF.js Find offset and length counts disagree.");
    }
    for (let index = 0; index < starts.length; index += 1) {
      if (
        !Number.isSafeInteger(starts[index]) ||
        starts[index]! < 0 ||
        !Number.isSafeInteger(lengths[index]) ||
        lengths[index]! <= 0
      ) {
        throw new Error("PDF.js Find published an invalid match range.");
      }
    }
    total += starts.length;
    if (!Number.isSafeInteger(total)) {
      throw new Error("PDF.js Find published an invalid total match count.");
    }
    pages.push({ starts, lengths });
  }
  return { pages, total };
}

function createControllerClasses(viewerModule: PdfJsViewerLike) {
  const PdfLinkService = viewerModule.PDFLinkService;
  const PdfFindController = viewerModule.PDFFindController;

  class NexusPdfFindLinkService extends PdfLinkService {
    override get page(): number {
      return super.page;
    }

    override set page(_value: number) {
      // PDF.js Find may select internally; Nexus alone moves the reader.
    }
  }

  class NexusPdfFindController extends PdfFindController {
    private readonly nexusEventBus: PdfEventBusLike;
    private readonly nexusLinkService: PdfLinkServiceLike;
    private readonly revealPage: CreatePdfFindRuntimeOptions["revealPage"];
    private readonly revealMatch: CreatePdfFindRuntimeOptions["revealMatch"];
    private readonly matchesCountListener: (event: unknown) => void;
    private activeSearch: ActiveSearch | null = null;
    private nexusSelection: PdfFindSelectionLike = {
      pageIdx: -1,
      matchIdx: -1,
    };
    private pendingScroll: PdfFindSelectionLike | null = null;
    private queryState: PdfFindEventState | null = null;
    private activationGeneration = 0;
    private activationAbortController: AbortController | null = null;
    private disposed = false;

    constructor({
      linkService,
      eventBus,
      revealPage,
      revealMatch,
    }: {
      readonly linkService: PdfLinkServiceLike;
      readonly eventBus: PdfEventBusLike;
      readonly revealPage: CreatePdfFindRuntimeOptions["revealPage"];
      readonly revealMatch: CreatePdfFindRuntimeOptions["revealMatch"];
    }) {
      super({
        linkService,
        eventBus,
        updateMatchesCountOnProgress: false,
      });
      this.nexusEventBus = eventBus;
      this.nexusLinkService = linkService;
      this.revealPage = revealPage;
      this.revealMatch = revealMatch;
      this.matchesCountListener = (event) => {
        this.handleMatchesCount(event);
      };
      eventBus.on("updatefindmatchescount", this.matchesCountListener);
    }

    override get selected(): PdfFindSelectionLike {
      return this.nexusSelection;
    }

    override match(
      query: string | string[],
      pageContent: string,
      pageIndex: number,
    ): readonly PdfFindMatchLike[] | undefined {
      const active = this.activeSearch;
      if (!active || active.settled) {
        return super.match(query, pageContent, pageIndex);
      }
      if (
        !Number.isSafeInteger(pageIndex) ||
        pageIndex < 0 ||
        pageIndex >= this.nexusLinkService.pagesCount
      ) {
        this.rejectDefect(
          active,
          new Error("PDF.js Find matched an invalid page index."),
        );
        return [];
      }
      if (active.coverage.has(pageIndex)) {
        this.rejectDefect(
          active,
          new Error("PDF.js Find matched one page twice in a generation."),
        );
        return [];
      }

      let matches: readonly PdfFindMatchLike[] | undefined;
      try {
        matches = pageIsInScope(active.scope, pageIndex)
          ? super.match(query, pageContent, pageIndex)
          : [];
      } catch (error) {
        this.rejectDefect(active, error);
        return [];
      }
      if (
        pageIsInScope(active.scope, pageIndex) &&
        pageContent.length > 0
      ) {
        active.textPresent = true;
      }
      active.coverage.add(pageIndex);
      this.resetStallTimer(active);
      return matches;
    }

    override scrollMatchIntoView({
      element,
      pageIndex,
      matchIndex,
    }: {
      readonly element: HTMLElement;
      readonly pageIndex: number;
      readonly matchIndex: number;
    }): void {
      const pending = this.pendingScroll;
      if (
        !pending ||
        pending.pageIdx !== pageIndex ||
        pending.matchIdx !== matchIndex
      ) {
        return;
      }
      this.pendingScroll = null;
      this.revealMatch(element);
    }

    beginSearch(
      request: PdfRuntimeFindRequest,
      queryState: PdfFindEventState,
    ): ActiveSearch {
      this.cancelSearch();
      this.cancelActivation();
      this.nexusSelection = { pageIdx: -1, matchIdx: -1 };
      this.pendingScroll = null;
      this.queryState = queryState;

      let resolve!: (settlement: SearchSettlement) => void;
      let reject!: (error: unknown) => void;
      let rejectAbort!: (error: unknown) => void;
      const settlement = new Promise<SearchSettlement>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const abort = new Promise<never>((_resolve, rej) => {
        rejectAbort = rej;
      });
      void abort.catch(() => undefined);
      const active: ActiveSearch = {
        generation: request.generation,
        scope: request.scope,
        signal: request.signal,
        coverage: new Set<number>(),
        settlement,
        abort,
        resolve,
        reject,
        rejectAbort,
        onAbort: () => {
          if (this.activeSearch !== active) {
            return;
          }
          const error = abortError();
          this.clearStallTimer(active);
          if (!active.settled) {
            active.settled = true;
            active.reject(error);
          }
          active.rejectAbort(error);
          this.activeSearch = null;
        },
        textPresent: false,
        settled: false,
        stallTimer: null,
      };
      this.activeSearch = active;
      request.signal.addEventListener("abort", active.onAbort, { once: true });
      this.resetStallTimer(active);
      return active;
    }

    finishSearch(active: ActiveSearch): void {
      this.clearStallTimer(active);
      active.signal.removeEventListener("abort", active.onAbort);
      if (this.activeSearch === active) {
        this.activeSearch = null;
      }
    }

    cancelSearch(): void {
      const active = this.activeSearch;
      if (!active) {
        return;
      }
      this.activeSearch = null;
      this.clearStallTimer(active);
      active.signal.removeEventListener("abort", active.onAbort);
      const error = abortError();
      if (!active.settled) {
        active.settled = true;
        active.reject(error);
      }
      active.rejectAbort(error);
    }

    isCurrent(active: ActiveSearch): boolean {
      return this.activeSearch === active && !active.signal.aborted;
    }

    resetSelection(): void {
      this.cancelActivation();
      const previousPage = this.nexusSelection.pageIdx;
      this.nexusSelection = { pageIdx: -1, matchIdx: -1 };
      this.pendingScroll = null;
      if (previousPage >= 0) {
        this.nexusEventBus.dispatch("updatetextlayermatches", {
          source: this,
          pageIndex: previousPage,
        });
      }
    }

    async activate(
      locator: PdfFindLocator,
      signal: AbortSignal,
    ): Promise<void> {
      if (signal.aborted) {
        throw abortError();
      }
      const pages = finalPageMatches(
        this,
        this.nexusLinkService.pagesCount,
      ).pages;
      const pageIndex = locator.pageNumber - 1;
      const page = pages[pageIndex];
      if (
        locator.kind !== "PdfTextMatch" ||
        !page ||
        !Number.isSafeInteger(locator.matchIndexOnPage) ||
        locator.matchIndexOnPage < 0 ||
        locator.matchIndexOnPage >= page.starts.length
      ) {
        throw new Error("PDF Find activation locator is stale or invalid.");
      }
      const startUtf16 = page.starts[locator.matchIndexOnPage]!;
      const endUtf16 =
        startUtf16 + page.lengths[locator.matchIndexOnPage]!;
      if (
        locator.startUtf16 !== startUtf16 ||
        locator.endUtf16 !== endUtf16
      ) {
        throw new Error("PDF Find activation locator no longer matches PDF.js.");
      }

      this.activationAbortController?.abort();
      this.activationGeneration += 1;
      const activationGeneration = this.activationGeneration;
      const activationAbortController = new AbortController();
      this.activationAbortController = activationAbortController;
      const handleAbort = () => {
        activationAbortController.abort();
      };
      signal.addEventListener("abort", handleAbort, { once: true });
      if (signal.aborted) {
        handleAbort();
      }

      const previous = this.nexusSelection;
      const next = {
        pageIdx: pageIndex,
        matchIdx: locator.matchIndexOnPage,
      };
      this.nexusSelection = next;
      this.pendingScroll = next;
      try {
        await this.revealPage({
          pageNumber: locator.pageNumber,
          signal: activationAbortController.signal,
        });
        if (
          activationAbortController.signal.aborted ||
          this.activationGeneration !== activationGeneration
        ) {
          throw abortError();
        }
        if (previous.pageIdx >= 0 && previous.pageIdx !== pageIndex) {
          this.nexusEventBus.dispatch("updatetextlayermatches", {
            source: this,
            pageIndex: previous.pageIdx,
          });
        }
        this.nexusEventBus.dispatch("updatetextlayermatches", {
          source: this,
          pageIndex,
        });
        if (this.queryState?.highlightAll === false) {
          this.queryState = {
            ...this.queryState,
            type: "highlightallchange",
            highlightAll: true,
          };
          this.nexusEventBus.dispatch("find", {
            source: this,
            ...this.queryState,
          });
          await Promise.resolve();
        }
        this.pendingScroll = null;
      } catch (error) {
        if (this.activationGeneration !== activationGeneration) {
          throw abortError();
        }
        this.nexusSelection = previous;
        this.pendingScroll = null;
        this.nexusEventBus.dispatch("updatetextlayermatches", {
          source: this,
          pageIndex,
        });
        throw error;
      } finally {
        signal.removeEventListener("abort", handleAbort);
        if (this.activationGeneration === activationGeneration) {
          this.activationAbortController = null;
        }
      }
    }

    dispose(): void {
      if (this.disposed) {
        return;
      }
      this.disposed = true;
      this.cancelSearch();
      this.nexusEventBus.off(
        "updatefindmatchescount",
        this.matchesCountListener,
      );
      this.resetSelection();
      this.queryState = null;
    }

    private cancelActivation(): void {
      this.activationGeneration += 1;
      this.activationAbortController?.abort();
      this.activationAbortController = null;
      this.pendingScroll = null;
    }

    private handleMatchesCount(event: unknown): void {
      if (
        event === null ||
        typeof event !== "object" ||
        !("source" in event) ||
        event.source !== this
      ) {
        return;
      }
      const active = this.activeSearch;
      if (!active || active.settled) {
        return;
      }
      const numPages = this.nexusLinkService.pagesCount;
      if (
        active.coverage.size !== numPages ||
        Array.from({ length: numPages }, (_value, index) => index).some(
          (pageIndex) => !active.coverage.has(pageIndex),
        )
      ) {
        return;
      }
      const matchesCount =
        "matchesCount" in event ? event.matchesCount : null;
      if (
        matchesCount === null ||
        typeof matchesCount !== "object" ||
        !("total" in matchesCount)
      ) {
        this.rejectDefect(
          active,
          new Error("PDF.js Find published an invalid final count event."),
        );
        return;
      }
      const eventTotal = matchesCount.total;
      if (
        typeof eventTotal !== "number" ||
        !Number.isSafeInteger(eventTotal) ||
        eventTotal < 0
      ) {
        this.rejectDefect(
          active,
          new Error("PDF.js Find published an invalid final count event."),
        );
        return;
      }

      let total: number;
      try {
        total = finalPageMatches(this, numPages).total;
      } catch (error) {
        this.rejectDefect(active, error);
        return;
      }
      if (eventTotal !== total) {
        this.rejectDefect(
          active,
          new Error("PDF.js Find final event and public arrays disagree."),
        );
        return;
      }
      active.settled = true;
      this.clearStallTimer(active);
      active.resolve({ kind: "Complete" });
    }

    private rejectDefect(active: ActiveSearch, error: unknown): void {
      if (this.activeSearch !== active || active.settled) {
        return;
      }
      active.settled = true;
      this.clearStallTimer(active);
      active.reject(error);
    }

    private resetStallTimer(active: ActiveSearch): void {
      this.clearStallTimer(active);
      active.stallTimer = setTimeout(() => {
        if (this.activeSearch !== active || active.settled) {
          return;
        }
        active.settled = true;
        active.stallTimer = null;
        active.resolve({ kind: "RuntimeUnavailable" });
      }, PDF_FIND_STALL_TIMEOUT_MS);
    }

    private clearStallTimer(active: ActiveSearch): void {
      if (active.stallTimer !== null) {
        clearTimeout(active.stallTimer);
        active.stallTimer = null;
      }
    }
  }

  return {
    NexusPdfFindLinkService,
    NexusPdfFindController,
  };
}

async function projectOccurrences({
  active,
  controller,
  document,
  pages,
}: {
  readonly active: ActiveSearch;
  readonly controller: {
    readonly isCurrent: (active: ActiveSearch) => boolean;
  };
  readonly document: PdfDocumentLike;
  readonly pages: readonly PageMatches[];
}): Promise<
  | { readonly kind: "Ready"; readonly occurrences: PdfRuntimeFindOccurrence[] }
  | { readonly kind: "RuntimeUnavailable" }
> {
  const occurrences: PdfRuntimeFindOccurrence[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const matches = pages[pageIndex]!;
    if (matches.starts.length === 0) {
      continue;
    }

    let textContent;
    try {
      textContent = await Promise.race([
        document
          .getPage(pageIndex + 1)
          .then((page) =>
            page.getTextContent({
              includeMarkedContent: true,
              disableNormalization: true,
            }),
          ),
        active.abort,
      ]);
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        throw error;
      }
      return { kind: "RuntimeUnavailable" };
    }
    if (!controller.isCurrent(active)) {
      throw abortError();
    }

    const text = textContent.items
      .filter((item): item is PdfTextItemLike => "str" in item)
      .map((item) => item.str)
      .join("");
    const codePoints = Array.from(text);
    const codepointIndexByUtf16 = new Map<number, number>([[0, 0]]);
    let utf16Index = 0;
    for (let codepointIndex = 0; codepointIndex < codePoints.length; codepointIndex += 1) {
      utf16Index += codePoints[codepointIndex]!.length;
      codepointIndexByUtf16.set(utf16Index, codepointIndex + 1);
    }

    for (
      let matchIndexOnPage = 0;
      matchIndexOnPage < matches.starts.length;
      matchIndexOnPage += 1
    ) {
      const startUtf16 = matches.starts[matchIndexOnPage]!;
      const endUtf16 =
        startUtf16 + matches.lengths[matchIndexOnPage]!;
      const startCp = codepointIndexByUtf16.get(startUtf16);
      const endCp = codepointIndexByUtf16.get(endUtf16);
      if (startCp === undefined || endCp === undefined) {
        throw new Error(
          "PDF.js Find range does not align to rendered text codepoints.",
        );
      }
      occurrences.push({
        locator: {
          kind: "PdfTextMatch",
          pageNumber: pageIndex + 1,
          matchIndexOnPage,
          startUtf16,
          endUtf16,
        },
        snippet: canonicalTextFindSnippet(codePoints, startCp, endCp),
      });
    }
  }
  return { kind: "Ready", occurrences };
}

export function createPdfFindRuntime({
  mediaId,
  viewerModule,
  eventBus,
  revealPage,
  revealMatch,
  captureOrigin,
  restoreOrigin,
}: CreatePdfFindRuntimeOptions): PdfFindRuntimeBinding {
  if (mediaId.length === 0) {
    throw new Error("PDF Find requires a media identity.");
  }
  const {
    NexusPdfFindLinkService,
    NexusPdfFindController,
  } = createControllerClasses(viewerModule);
  const findLinkService = new NexusPdfFindLinkService({ eventBus });
  const findController = new NexusPdfFindController({
    linkService: findLinkService,
    eventBus,
    revealPage,
    revealMatch,
  });

  let documentLifetime: DocumentLifetime | null = null;
  let viewerAttached = false;
  let disposed = false;

  const detachDocument = () => {
    documentLifetime?.abortController.abort();
    documentLifetime = null;
    findController.cancelSearch();
    findController.resetSelection();
    findController.setDocument(null);
    findLinkService.setDocument(null, null);
  };

  const binding: PdfFindRuntimeBinding = {
    findController,
    findLinkService,
    setViewer(viewer) {
      if (disposed) {
        throw new Error("Cannot attach a disposed PDF Find runtime.");
      }
      findLinkService.setViewer(viewer);
      viewerAttached = true;
    },
    setDocument: ((
      nextDocument: PdfDocumentLike | null,
    ): PdfFindRuntime | null => {
      if (disposed) {
        throw new Error("Cannot bind a disposed PDF Find runtime.");
      }
      detachDocument();
      if (nextDocument === null) {
        return null;
      }
      if (!viewerAttached) {
        throw new Error("PDF Find viewer must be attached before its document.");
      }
      if (
        !Number.isSafeInteger(nextDocument.numPages) ||
        nextDocument.numPages <= 0 ||
        typeof nextDocument.fingerprints[0] !== "string" ||
        nextDocument.fingerprints[0].length === 0
      ) {
        throw new Error("Loaded PDF identity is malformed.");
      }

      const lifetime: DocumentLifetime = {
        abortController: new AbortController(),
      };
      findLinkService.setDocument(nextDocument, null);
      findController.setDocument(nextDocument);
      documentLifetime = lifetime;
      const source: PdfFindSource = {
        mediaId,
        fingerprints: [...nextDocument.fingerprints],
        numPages: nextDocument.numPages,
      };

      return {
        source,
        async search(request) {
          if (documentLifetime !== lifetime || request.signal.aborted) {
            throw abortError();
          }
          if (
            !Number.isSafeInteger(request.generation) ||
            Array.from(request.query).length < 1 ||
            Array.from(request.query).length > 256
          ) {
            throw new Error("PDF Find request is malformed.");
          }
          assertCurrentScope(request.scope, source.numPages);
          const queryState: PdfFindEventState = {
            type: "nexus-query",
            query: request.query,
            caseSensitive: request.matchCase,
            entireWord: request.wholeWord,
            matchDiacritics: true,
            highlightAll: false,
            findPrevious: false,
          };
          const active = findController.beginSearch(request, queryState);
          try {
            try {
              eventBus.dispatch("find", {
                source: findController,
                ...queryState,
              });
            } catch {
              findController.finishSearch(active);
              return {
                kind: "RuntimeUnavailable",
                generation: request.generation,
              };
            }

            const settlement = await active.settlement;
            if (!findController.isCurrent(active)) {
              throw abortError();
            }
            if (settlement.kind === "RuntimeUnavailable") {
              return {
                kind: "RuntimeUnavailable",
                generation: request.generation,
              };
            }

            const finalMatches = finalPageMatches(
              findController,
              source.numPages,
            );
            if (finalMatches.total > PDF_FIND_MATCH_THRESHOLD) {
              try {
                eventBus.dispatch("findbarclose", {
                  source: findController,
                });
              } catch {
                return {
                  kind: "RuntimeUnavailable",
                  generation: request.generation,
                };
              }
              findController.resetSelection();
              return {
                kind: "TooManyMatches",
                generation: request.generation,
                threshold: PDF_FIND_MATCH_THRESHOLD,
              };
            }
            if (finalMatches.total === 0) {
              if (
                request.scope.kind === "EntirePdf" &&
                !active.textPresent
              ) {
                return {
                  kind: "TextUnavailable",
                  generation: request.generation,
                };
              }
              return {
                kind: "NoMatches",
                generation: request.generation,
              };
            }

            const projected = await projectOccurrences({
              active,
              controller: findController,
              document: nextDocument,
              pages: finalMatches.pages,
            });
            if (projected.kind === "RuntimeUnavailable") {
              return {
                kind: "RuntimeUnavailable",
                generation: request.generation,
              };
            }
            return {
              kind: "Ready",
              generation: request.generation,
              occurrences: projected.occurrences,
            };
          } finally {
            findController.finishSearch(active);
          }
        },
        activate(locator, signal) {
          return runDocumentCommand({
            lifetime,
            callerSignal: signal,
            isCurrent: () => documentLifetime === lifetime,
            command: (commandSignal) =>
              findController.activate(locator, commandSignal),
          });
        },
        captureOrigin() {
          if (documentLifetime !== lifetime) {
            return { kind: "Unavailable" };
          }
          return captureOrigin();
        },
        restoreOrigin(origin, signal) {
          return runDocumentCommand({
            lifetime,
            callerSignal: signal,
            isCurrent: () => documentLifetime === lifetime,
            command: (commandSignal) =>
              restoreOrigin(origin, commandSignal),
          });
        },
        clearPresentation() {
          if (documentLifetime !== lifetime) {
            return;
          }
          findController.cancelSearch();
          findController.resetSelection();
          eventBus.dispatch("findbarclose", { source: findController });
        },
      };
    }) as PdfFindRuntimeBinding["setDocument"],
    dispose() {
      if (disposed) {
        return;
      }
      detachDocument();
      disposed = true;
      findController.dispose();
    },
  };
  return binding;
}
