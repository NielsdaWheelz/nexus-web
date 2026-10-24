// Find over a pdf: pdf.js matches (its ligature, hyphenation and whitespace
// normalization) and paints the text layer; the reader owns scope, the active
// match and movement (pdf.js find never scrolls). The narrow scope is the page
// at the reading position when the first query starts.
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
import type { PdfFindDestination, ReaderDestination } from "../location";
import { textSha256 } from "@/lib/find/textSha256";
import type { loadPdfJs } from "./pdfjs";

/** A pdf.js match: 1-based page and its index among that page's matches. */
interface PdfHit {
  readonly page: number;
  readonly index: number;
  readonly destination: ReaderDestination;
}

export function createPdfFind(
  lib: Awaited<ReturnType<typeof loadPdfJs>>["viewer"],
  eventBus: EventBus,
  reader: Pick<Reader, "inspect" | "getState" | "navigation">,
  identity: string,
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
  function paint(active: { readonly page: number; readonly index: number } | null, any: boolean) {
    if (!options || !any) return dispatch("findbarclose");
    if (!controller.highlightMatches) find("highlightallchange", true);
    const previous = controller.choice.pageIdx;
    controller.choice = active
      ? { pageIdx: active.page - 1, matchIdx: active.index }
      : { pageIdx: -1, matchIdx: -1 };
    for (const pageIndex of new Set([previous, controller.choice.pageIdx]))
      if (pageIndex >= 0) dispatch("updatetextlayermatches", { pageIndex });
  }
  let anchorPage: number | null = null;
  let arrival: { readonly release: () => void } | null = null;
  const clearArrival = () => {
    if (!arrival) return;
    arrival.release();
    arrival = null;
    paint(null, false);
  };

  /** Local search and URL replay use the same pdf.js normalization and matcher. */
  async function matches(next: FindOptions, page: number | null, signal: AbortSignal): Promise<{
    readonly starts: readonly (readonly number[] | undefined)[];
    readonly lengths: readonly (readonly number[] | undefined)[];
  }> {
    Object.assign(controller, { scope: page, sawText: false, choice: { pageIdx: -1, matchIdx: -1 } });
    options = next;
    await new Promise<void>((resolve) => {
      const finish = () => {
        eventBus.off("updatefindmatchescount", counted);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const counted = (event: { source?: unknown }) => { if (event.source === controller) finish(); };
      eventBus.on("updatefindmatchescount", counted);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish(); else find("nexus-query", false);
    });
    if (signal.aborted) throw new DOMException("PDF find was superseded.", "AbortError");
    return { starts: controller.pageMatches ?? [], lengths: controller.pageMatchesLength ?? [] };
  }

  async function pageText(page: number, signal: AbortSignal) {
    const content = await (await pdf!.getPage(page)).getTextContent({ disableNormalization: true });
    if (signal.aborted) throw new DOMException("PDF find was superseded.", "AbortError");
    // pdf.js original match offsets address this EOL-free UTF-16 join.
    return content.items.map((item) => "str" in item ? item.str : "").join("");
  }

  const source: FindSource<PdfHit> = {
    key: "",
    label: "Find in PDF",
    narrowLabel: "This page",
    prepare() {
      const primary = reader.getState().viewport?.primary;
      anchorPage = primary?.kind === "pdf" ? primary.page : null;
      return anchorPage === null ? null : `Page ${anchorPage}`;
    },
    async search(next, narrow, signal) {
      clearArrival();
      if (narrow && anchorPage === null)
        return {
          kind: "Failed",
          message:
            "Selected page is unavailable. Clear the search to capture a new page, or turn off the scope option.",
        };
      const frozen = { ...next };
      const { starts, lengths } = await matches(frozen, narrow && anchorPage !== null ? anchorPage - 1 : null, signal);
      const count = starts.reduce((sum, page) => sum + (page?.length ?? 0), 0);
      if (count > FIND_LIMIT) return { kind: "TooMany" };
      if (!controller.sawText && !narrow)
        return {
          kind: "Failed",
          message:
            "Searchable text could not be extracted from this PDF. Retry does not perform OCR.",
        };
      const rows: FindRow<PdfHit>[] = [];
      for (const [pageIndex, pageMatches] of starts.entries()) {
        if (!pageMatches?.length || !pdf) continue;
        const text = await pageText(pageIndex + 1, signal);
        const digest = await textSha256(text);
        if (signal.aborted) throw new DOMException("PDF find was superseded.", "AbortError");
        for (const [index, start] of pageMatches.entries()) {
          const end = start + lengths[pageIndex]![index]!;
          const at: PdfHit = { page: pageIndex + 1, index, destination: {
            source_identity: identity,
            target: { kind: "pdf_find", page: pageIndex + 1, query: frozen.query, match_case: frozen.matchCase, whole_word: frozen.wholeWord, start, end, text_sha256: digest },
          } };
          rows.push({
            at,
            context: [`Page ${at.page}`],
            snippet: snippet(text, start, end),
          });
        }
      }
      const initial = rows.findIndex((row) => row.at.page >= (anchorPage ?? 1));
      return {
        kind: "Rows",
        rows,
        initial: Math.max(0, initial),
        partial: null,
      };
    },
    async reveal(hit, signal) {
      if (signal.aborted) return { kind: "Cancelled" };
      clearArrival();
      paint(hit, true);
      const outcome = await reader.inspect({ target: { kind: "pdfMatch", page: hit.page, index: hit.index }, signal });
      if (outcome.kind === "Cancelled") return { kind: "Cancelled" };
      if (outcome.kind !== "Unavailable") return { kind: "Shown" };
      return {
        kind: "Failed",
        message: outcome.reason === "CaptureUnavailable"
          ? "Your reading position could not be captured."
          : "PDF find is unavailable. Try again.",
      };
    },
    href: (hit) => reader.navigation?.href(hit.destination) ?? null,
    paint: (rows, active) => { if (!arrival) paint(rows[active]?.at ?? null, rows.length > 0); },
  };

  return {
    controller,
    /** Verify the original extraction and exact matcher result before moving. */
    async replay(target: PdfFindDestination, signal: AbortSignal, inspectionSignal: AbortSignal | null): Promise<{ readonly page: number; readonly index: number } | null> {
      clearArrival();
      const lifetime = inspectionSignal ?? signal;
      if (signal.aborted || lifetime.aborted || !pdf || target.page > pdf.numPages) return null;
      const abort = () => { if (arrival === owner) clearArrival(); };
      const owner = { release: () => lifetime.removeEventListener("abort", abort) };
      arrival = owner;
      lifetime.addEventListener("abort", abort, { once: true });
      let shown = false;
      try {
        const { starts, lengths } = await matches({ query: target.query, matchCase: target.match_case, wholeWord: target.whole_word }, target.page - 1, signal);
        const text = await pageText(target.page, signal);
        const digest = await textSha256(text);
        if (signal.aborted || lifetime.aborted || arrival !== owner) return null;
        const index = starts[target.page - 1]?.findIndex((start, at) => start === target.start && start + lengths[target.page - 1]![at]! === target.end) ?? -1;
        if (digest !== target.text_sha256 || index < 0 || target.end > text.length) return null;
        const hit = { page: target.page, index };
        paint(hit, true);
        shown = true;
        return hit;
      } finally {
        if (!shown && arrival === owner) clearArrival();
      }
    },
    /** The find over one opened pdf; its key names the document. */
    attach(next: PDFViewer, document: PDFDocumentProxy, key: string) {
      pdf = document;
      links.setViewer(next);
      links.setDocument(document, null);
      // PDFViewer owns controller attachment after its first rendered page.
      // Attaching here too resets an early arrival's matches when rendering ends.
      return { ...source, key };
    },
  };
}
