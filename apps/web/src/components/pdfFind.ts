"use client";

import type {
  PdfDocumentLike,
  PdfEventBusLike,
  PdfJsViewerLike,
  PdfViewerLike,
} from "@/components/pdfReaderRuntime";
import {
  FIND_LIMIT,
  snippet,
  type FindOptions,
  type FindRow,
  type FindSource,
} from "@/lib/find/find";
import type { ReaderNavigationOutcome } from "@/lib/reader/useReaderNavigation";

/** One pdf.js match: 1-based page and its index in pdf.js's match list for that page. */
export interface PdfHit {
  readonly page: number;
  readonly index: number;
}

let viewers = 0;

/**
 * pdf.js owns PDF matching (its ligature, hyphenation and whitespace
 * normalization) and the text-layer paint. Nexus owns scope, selection and
 * movement: pdf.js find never moves the reader. One per PDF viewer.
 */
export function createPdfFind(
  viewerModule: PdfJsViewerLike,
  eventBus: PdfEventBusLike,
) {
  class StillLinkService extends viewerModule.PDFLinkService {
    override get page(): number {
      return super.page;
    }
    override set page(_page: number) {}
  }
  class ScopedFindController extends viewerModule.PDFFindController {
    scope: number | null = null;
    sawText = false;
    choice = { pageIdx: -1, matchIdx: -1 };
    override get selected() {
      return this.choice;
    }
    override match(
      query: string | string[],
      content: string,
      pageIndex: number,
    ) {
      if (this.scope !== null && pageIndex !== this.scope) return [];
      this.sawText ||= content.length > 0;
      return super.match(query, content, pageIndex);
    }
    override scrollMatchIntoView() {}
  }
  const viewer = ++viewers;
  const linkService = new StillLinkService({ eventBus });
  const controller = new ScopedFindController({
    linkService,
    eventBus,
    updateMatchesCountOnProgress: false,
  });
  let document: PdfDocumentLike | null = null;
  let options: FindOptions | null = null;
  const dispatch = (type: string, details: object = {}) =>
    eventBus.dispatch(type, { source: controller, ...details });
  const find = (type: string, highlightAll: boolean) =>
    dispatch("find", {
      type,
      query: options!.query,
      caseSensitive: options!.matchCase,
      entireWord: options!.wholeWord,
      matchDiacritics: true,
      highlightAll,
      findPrevious: false,
    });
  /** Selects `active` (pdf.js re-renders the touched text layers) and shows every match while results exist. */
  const paint = (active: PdfHit | null, any: boolean) => {
    if (!options || !any) return dispatch("findbarclose");
    if (!controller.highlightMatches || !controller.state?.highlightAll)
      find("highlightallchange", true);
    const previous = controller.choice.pageIdx;
    controller.choice = active
      ? { pageIdx: active.page - 1, matchIdx: active.index }
      : { pageIdx: -1, matchIdx: -1 };
    for (const pageIndex of new Set([previous, controller.choice.pageIdx])) {
      if (pageIndex >= 0) dispatch("updatetextlayermatches", { pageIndex });
    }
  };

  return {
    controller,
    /** Names this viewer's loaded document; a new viewer or document is a new find snapshot. */
    get identity() {
      return document ? `${viewer}:${document.fingerprints[0]}` : null;
    },
    setViewer: (pdfViewer: PdfViewerLike) => linkService.setViewer(pdfViewer),
    setDocument(next: PdfDocumentLike | null) {
      document = next;
      linkService.setDocument(next, null);
      controller.setDocument(next);
    },
    /** A FindSource over the loaded document; the PDF reader reveals pdf.js's selected match on `inspect`. */
    source(input: {
      readonly key: string;
      readonly currentPage: () => number;
      readonly inspect: (
        page: number,
        signal: AbortSignal,
      ) => Promise<ReaderNavigationOutcome>;
    }): FindSource<PdfHit> {
      let anchorPage = 1;
      return {
        key: input.key,
        label: "Find in PDF",
        prepare() {
          anchorPage = input.currentPage();
          return `This page (${anchorPage})`;
        },
        async search(next, narrow, signal) {
          Object.assign(controller, {
            scope: narrow ? anchorPage - 1 : null,
            sawText: false,
            choice: { pageIdx: -1, matchIdx: -1 },
          });
          options = next;
          // With updateMatchesCountOnProgress off, pdf.js reports the count once, after it has matched every page.
          await new Promise<void>((resolve) => {
            const counted = (event: unknown) => {
              if ((event as { source?: unknown }).source !== controller) return;
              eventBus.off("updatefindmatchescount", counted);
              resolve();
            };
            eventBus.on("updatefindmatchescount", counted);
            signal.addEventListener("abort", () =>
              eventBus.off("updatefindmatchescount", counted),
            );
            find("nexus-query", false);
          });
          const starts = controller.pageMatches ?? [];
          const lengths = controller.pageMatchesLength ?? [];
          if (
            starts.reduce((sum, matches) => sum + (matches?.length ?? 0), 0) >
            FIND_LIMIT
          )
            return { kind: "TooMany" };
          if (!controller.sawText && !narrow) {
            return {
              kind: "Failed",
              message:
                "Searchable text could not be extracted from this PDF. Retry does not perform OCR.",
            };
          }
          const rows: FindRow<PdfHit>[] = [];
          for (const [pageIndex, matches] of starts.entries()) {
            if (!matches?.length || !document) continue;
            const page = await document.getPage(pageIndex + 1);
            const content = await page.getTextContent({
              includeMarkedContent: true,
              disableNormalization: true,
            });
            if (signal.aborted)
              throw new DOMException("PDF find was superseded.", "AbortError");
            // pdf.js match offsets index the EOL-free join of the page's text items.
            const text = content.items
              .map((item) => ("str" in item ? item.str : ""))
              .join("");
            for (const [index, start] of matches.entries()) {
              const at = { page: pageIndex + 1, index };
              rows.push({
                at,
                context: [`Page ${at.page}`],
                snippet: snippet(
                  text,
                  start,
                  start + lengths[pageIndex]![index]!,
                ),
              });
            }
          }
          return {
            kind: "Rows",
            rows,
            initial: Math.max(
              0,
              rows.findIndex((row) => row.at.page >= anchorPage),
            ),
            partial: null,
          };
        },
        async reveal(hit, signal) {
          paint(hit, true);
          const outcome = await input.inspect(hit.page, signal);
          if (outcome.kind !== "Unavailable") return null;
          return outcome.reason === "CaptureUnavailable"
            ? "Your reading position could not be captured."
            : "PDF Find is unavailable. Try again.";
        },
        paint: (rows, active) =>
          paint(rows[active]?.at ?? null, rows.length > 0),
      };
    },
  };
}

export type PdfFind = ReturnType<typeof createPdfFind>;
