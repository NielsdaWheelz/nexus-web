// pdf.js destinations are resolved once, then bound to the source view without moving it.
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ReaderTarget } from "../model";

type PdfTarget = Extract<ReaderTarget, { kind: "pdf" }>;
export type PdfSourceView = { readonly zoom: number | null; readonly left: number; readonly top: number };
export type PreparedPdfDestination = (source: PdfSourceView) => PdfTarget;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const nullable = (value: unknown): value is number | null => value === null || finite(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The raw pdf boundary owns named destinations, indirect page references and null defaults. */
export async function preparePdfDestination(pdf: PDFDocumentProxy, raw: unknown): Promise<PreparedPdfDestination | null> {
  const dest: unknown = typeof raw === "string" ? await pdf.getDestination(raw) : raw;
  if (!Array.isArray(dest) || !record(dest[1]) || typeof dest[1].name !== "string") return null;
  const first: unknown = dest[0];
  let page: number;
  if (typeof first === "number" && Number.isSafeInteger(first)) page = first + 1;
  else if (record(first) && typeof first.num === "number" && Number.isSafeInteger(first.num) && typeof first.gen === "number" && Number.isSafeInteger(first.gen))
    page = await pdf.getPageIndex({ num: first.num, gen: first.gen }) + 1;
  else return null;
  if (page < 1 || page > pdf.numPages) return null;
  const pageProxy = await pdf.getPage(page);
  const [, bottom, , top] = pageProxy.view;
  const height = (top - bottom) * pageProxy.userUnit;
  switch (dest[1].name) {
    case "XYZ": {
      const [x, y, zoom] = dest.slice(2);
      if (dest.length !== 5 || !nullable(x) || !nullable(y) || !nullable(zoom) || (zoom !== null && zoom < 0)) return null;
      return (source) => ({ kind: "pdf", page, view: { kind: "xyz", left: x ?? 0, top: y ?? height, zoom: zoom || source.zoom } });
    }
    case "Fit": case "FitB":
      return dest.length === 2 ? () => ({ kind: "pdf", page, view: { kind: "fit_page" } }) : null;
    case "FitH": case "FitBH": {
      const y: unknown = dest[2];
      if (dest.length !== 3 || !nullable(y)) return null;
      return (source) => ({ kind: "pdf", page, view: { kind: "fit_width", left: y === null ? source.left : 0, top: y === null ? source.top : y < 0 ? height : y } });
    }
    case "FitV": case "FitBV": {
      const x: unknown = dest[2];
      if (dest.length !== 3 || !nullable(x)) return null;
      return () => ({ kind: "pdf", page, view: { kind: "fit_height", left: x ?? 0 } });
    }
    case "FitR": {
      const [x1, y1, x2, y2] = dest.slice(2);
      if (dest.length !== 6 || !finite(x1) || !finite(y1) || !finite(x2) || !finite(y2) || x1 >= x2 || y1 >= y2) return null;
      return () => ({ kind: "pdf", page, view: { kind: "fit_rect", left: x1, bottom: y1, right: x2, top: y2 } });
    }
    default: return null;
  }
}
