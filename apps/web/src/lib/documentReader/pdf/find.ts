// Find over a pdf: pdf.js matches (its ligature, hyphenation and whitespace
// normalization) and paints the text layer; the reader owns scope, the active
// match and movement (pdf.js find never scrolls). The narrow scope is the page
// at the reading position when find opens.
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { EventBus, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import {
  FIND_LIMIT,
  snippet,
  type FindOptions,
  type FindRow,
  type FindSource,
} from "@/lib/find/find";
import type { Reader } from "../DocumentReader";
import { nextFrame } from "../scrollport";
import type { loadPdfJs } from "./pdfjs";

/** A pdf.js match: 1-based page and its index among that page's matches. */
export interface PdfHit {
  readonly page: number;
  readonly index: number;
}

export function createPdfFind(
  lib: Awaited<ReturnType<typeof loadPdfJs>>["viewer"],
  eventBus: EventBus,
  reader: Pick<Reader, "inspect" | "getState">,
) {
  class StillLinks extends lib.PDFLinkService {
    override get page() {
      return super.page;
    }
    override set page(_page: number) {}
  }
  class Scoped extends lib.PDFFindController {
    scope: number | null = null;
    sawText = false;
    choice = { pageIdx: -1, matchIdx: -1 };
    override get selected() {
      return this.choice;
    }
    override match(query: string | string[], content: string, page: number) {
      if (this.scope !== null && page !== this.scope) return [];
      this.sawText ||= content.length > 0;
      return super.match(query, content, page);
    }
    override scrollMatchIntoView() {}
  }
  const links = new StillLinks({ eventBus });
  const controller = new Scoped({
    linkService: links,
    eventBus,
    updateMatchesCountOnProgress: false,
  });
  let pdf: PDFDocumentProxy | null = null;
  let viewer: PDFViewer | null = null;
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
  /** Shows every match and selects `active`; pdf.js re-renders the touched text layers. */
  function paint(active: PdfHit | null, any: boolean) {
    if (!options || !any) return dispatch("findbarclose");
    if (!controller.highlightMatches) find("highlightallchange", true);
    const previous = controller.choice.pageIdx;
    controller.choice = active
      ? { pageIdx: active.page - 1, matchIdx: active.index }
      : { pageIdx: -1, matchIdx: -1 };
    for (const pageIndex of new Set([previous, controller.choice.pageIdx]))
      if (pageIndex >= 0) dispatch("updatetextlayermatches", { pageIndex });
  }
  let anchorPage = 1;

  const source: FindSource<PdfHit> = {
    key: "",
    label: "Find in PDF",
    prepare() {
      const primary = reader.getState().viewport?.primary;
      anchorPage = primary?.kind === "pdf" ? primary.page : 1;
      return `This page (${anchorPage})`;
    },
    async search(next, narrow, signal) {
      Object.assign(controller, {
        scope: narrow ? anchorPage - 1 : null,
        sawText: false,
        choice: { pageIdx: -1, matchIdx: -1 },
      });
      options = next;
      // With progress counting off, pdf.js reports once, after every page.
      await new Promise<void>((resolve) => {
        const counted = (event: { source?: unknown }) => {
          if (event.source !== controller) return;
          eventBus.off("updatefindmatchescount", counted);
          resolve();
        };
        eventBus.on("updatefindmatchescount", counted);
        signal.addEventListener("abort", () => {
          eventBus.off("updatefindmatchescount", counted);
          resolve();
        });
        find("nexus-query", false);
      });
      if (signal.aborted)
        throw new DOMException("PDF find was superseded.", "AbortError");
      const starts = controller.pageMatches ?? [];
      const lengths = controller.pageMatchesLength ?? [];
      const count = starts.reduce((sum, page) => sum + (page?.length ?? 0), 0);
      if (count > FIND_LIMIT) return { kind: "TooMany" };
      if (!controller.sawText && !narrow)
        return {
          kind: "Failed",
          message:
            "Searchable text could not be extracted from this PDF. Retry does not perform OCR.",
        };
      const rows: FindRow<PdfHit>[] = [];
      for (const [pageIndex, matches] of starts.entries()) {
        if (!matches?.length || !pdf) continue;
        const content = await (
          await pdf.getPage(pageIndex + 1)
        ).getTextContent({
          includeMarkedContent: true,
          disableNormalization: true,
        });
        if (signal.aborted)
          throw new DOMException("PDF find was superseded.", "AbortError");
        // Match offsets index the EOL-free join of the page's text items.
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join("");
        for (const [index, start] of (matches as number[]).entries()) {
          const at = { page: pageIndex + 1, index };
          const end = start + lengths[pageIndex]![index]!;
          rows.push({
            at,
            context: [`Page ${at.page}`],
            snippet: snippet(text, start, end),
          });
        }
      }
      const initial = rows.findIndex((row) => row.at.page >= anchorPage);
      return {
        kind: "Rows",
        rows,
        initial: Math.max(0, initial),
        partial: null,
      };
    },
    /** To the page, then (once its text layer paints the match) to the match. */
    async reveal(hit, signal) {
      paint(hit, true);
      const point = (y: number) => ({
        kind: "point" as const,
        point: { kind: "pdf" as const, page: hit.page, y },
      });
      let outcome = await reader.inspect(point(0));
      const page = viewer?.getPageView(hit.page - 1)?.div as HTMLElement;
      for (let frame = 0; frame < 60 && !signal.aborted; frame += 1) {
        const match = page?.querySelector(".textLayer .highlight.selected");
        if (match) {
          const box = page.getBoundingClientRect();
          const top = match.getBoundingClientRect().top - box.top;
          outcome = await reader.inspect(
            point(Math.max(0, top / box.height - 0.05)),
          );
          break;
        }
        await nextFrame(signal);
      }
      if (outcome.kind !== "Unavailable") return null;
      return outcome.reason === "CaptureUnavailable"
        ? "Your reading position could not be captured."
        : "PDF Find is unavailable. Try again.";
    },
    paint: (rows, active) => paint(rows[active]?.at ?? null, rows.length > 0),
  };

  return {
    controller,
    /** The find over one opened pdf; its key names the document. */
    attach(next: PDFViewer, document: PDFDocumentProxy, key: string) {
      viewer = next;
      pdf = document;
      links.setViewer(next);
      links.setDocument(document, null);
      controller.setDocument(document);
      return { ...source, key };
    },
  };
}
