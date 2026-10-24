// Portable, publication-bound destinations. URL ownership stays with the host.
import type { PdfQuad, ReaderTarget } from "./model";
import { parseLocationJson } from "@/lib/reader/locationJson";
import { FIND_QUERY_LIMIT } from "@/lib/find/find";

export interface PdfFindDestination {
  readonly kind: "pdf_find";
  readonly page: number;
  readonly query: string;
  readonly match_case: boolean;
  readonly whole_word: boolean;
  readonly start: number;
  readonly end: number;
  readonly text_sha256: string;
}

export type PdfView =
  | { readonly kind: "page_top"; readonly zoom: number | null }
  | { readonly kind: "xyz"; readonly left: number; readonly top: number; readonly zoom: number | null }
  | { readonly kind: "fit_page" }
  | { readonly kind: "fit_width"; readonly left: number; readonly top: number }
  | { readonly kind: "fit_height"; readonly left: number }
  | { readonly kind: "fit_rect"; readonly left: number; readonly bottom: number; readonly right: number; readonly top: number };

export interface ReaderDestination {
  readonly source_identity: string;
  readonly target:
    | Extract<ReaderTarget, { kind: "range" | "anchor" | "time" | "quads" | "edge" | "pdf" }>
    | PdfFindDestination
    | { readonly kind: "point"; readonly point: { readonly kind: "text"; readonly unit: string; readonly offset: number } }
    | { readonly kind: "evidence_item"; readonly item_id: string };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const zoom = (value: unknown): value is number | null => value === null || finite(value) && value > 0;

function pdfView(value: unknown): PdfView | null {
  if (!record(value)) return null;
  switch (value.kind) {
    case "page_top": return keys(value, ["kind", "zoom"]) && zoom(value.zoom) ? { kind: value.kind, zoom: value.zoom } : null;
    case "xyz": return keys(value, ["kind", "left", "top", "zoom"]) && finite(value.left) && finite(value.top) && zoom(value.zoom)
      ? { kind: value.kind, left: value.left, top: value.top, zoom: value.zoom } : null;
    case "fit_page": return keys(value, ["kind"]) ? { kind: value.kind } : null;
    case "fit_width": return keys(value, ["kind", "left", "top"]) && finite(value.left) && finite(value.top)
      ? { kind: value.kind, left: value.left, top: value.top } : null;
    case "fit_height": return keys(value, ["kind", "left"]) && finite(value.left) ? { kind: value.kind, left: value.left } : null;
    case "fit_rect": return keys(value, ["kind", "left", "bottom", "right", "top"]) && finite(value.left) && finite(value.bottom) && finite(value.right) && finite(value.top) && value.left < value.right && value.bottom < value.top
      ? { kind: value.kind, left: value.left, bottom: value.bottom, right: value.right, top: value.top } : null;
    default: return null;
  }
}

function target(value: unknown): ReaderDestination["target"] | null {
  if (!record(value)) return null;
  switch (value.kind) {
    case "point": {
      const point = value.point;
      return keys(value, ["kind", "point"]) && record(point) && keys(point, ["kind", "unit", "offset"]) && point.kind === "text" && text(point.unit) && integer(point.offset)
        ? { kind: value.kind, point: { kind: "text", unit: point.unit, offset: point.offset } } : null;
    }
    case "range": return keys(value, ["kind", "unit", "start", "end"]) && text(value.unit) && integer(value.start) && integer(value.end) && value.start < value.end
      ? { kind: value.kind, unit: value.unit, start: value.start, end: value.end } : null;
    case "anchor": return keys(value, ["kind", "unit", "id"]) && text(value.unit) && text(value.id) ? { kind: value.kind, unit: value.unit, id: value.id } : null;
    case "time": return keys(value, ["kind", "ms"]) && integer(value.ms) ? { kind: value.kind, ms: value.ms } : null;
    case "edge": return keys(value, ["kind", "edge"]) && (value.edge === "start" || value.edge === "end") ? { kind: value.kind, edge: value.edge } : null;
    case "evidence_item": return keys(value, ["kind", "item_id"]) && text(value.item_id) ? { kind: value.kind, item_id: value.item_id } : null;
    case "pdf": {
      const view = pdfView(value.view);
      return keys(value, ["kind", "page", "view"]) && integer(value.page) && value.page > 0 && view ? { kind: value.kind, page: value.page, view } : null;
    }
    case "pdf_find": return keys(value, ["kind", "page", "query", "match_case", "whole_word", "start", "end", "text_sha256"]) &&
      integer(value.page) && value.page > 0 && typeof value.query === "string" && value.query.length > 0 && Array.from(value.query).length <= FIND_QUERY_LIMIT &&
      typeof value.match_case === "boolean" && typeof value.whole_word === "boolean" && integer(value.start) && integer(value.end) && value.start < value.end &&
      typeof value.text_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.text_sha256)
      ? { kind: value.kind, page: value.page, query: value.query, match_case: value.match_case, whole_word: value.whole_word, start: value.start, end: value.end, text_sha256: value.text_sha256 } : null;
    case "quads": {
      if (!keys(value, ["kind", "page", "quads"]) || !integer(value.page) || value.page < 1 || !Array.isArray(value.quads) || value.quads.length === 0) return null;
      const quads: PdfQuad[] = [];
      for (const quad of value.quads) {
        if (!record(quad) || !keys(quad, ["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"]) || !finite(quad.x1) || !finite(quad.y1) || !finite(quad.x2) || !finite(quad.y2) || !finite(quad.x3) || !finite(quad.y3) || !finite(quad.x4) || !finite(quad.y4)) return null;
        quads.push({ x1: quad.x1, y1: quad.y1, x2: quad.x2, y2: quad.y2, x3: quad.x3, y3: quad.y3, x4: quad.x4, y4: quad.y4 });
      }
      return { kind: value.kind, page: value.page, quads };
    }
    default: return null;
  }
}

/** Untrusted URL JSON enters here once; membership belongs to the loaded publication. */
export function parseReaderDestination(raw: string): ReaderDestination | null {
  const value = parseLocationJson(raw);
  if (!record(value) || !keys(value, ["source_identity", "target"]) || !text(value.source_identity)) return null;
  const parsed = target(value.target);
  return parsed && { source_identity: value.source_identity, target: parsed };
}

/** Reconstruct the owned shape so field order never depends on the caller. */
export function serializeReaderDestination(destination: ReaderDestination): string {
  const canonical = target(destination.target);
  // justify-defect: internal producers construct the same exact destination shape the URL parser accepts.
  if (!canonical) throw new Error("invalid owned reader destination");
  return JSON.stringify({ source_identity: destination.source_identity, target: canonical });
}
