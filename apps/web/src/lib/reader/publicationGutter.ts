import type { ReaderPublicationSourceRange } from "./publicationContract";
import type { CanonicalCursorResult } from "@/lib/highlights/canonicalCursor";
import { projectPdfQuadToViewportRect, viewportPointToPagePoint, readPdfPageViewportTransform } from "@/lib/highlights/coordinateTransforms";
import type { ReaderPublicationEvidenceGutterItem, ReaderPublicationEvidenceGutterWindow } from "./readerPublicationOverlays";

export type ReaderGutterWindow =
  | { readonly kind: "Text"; readonly units: readonly { readonly unit_key: string; readonly fragment_id: string; readonly ranges: readonly (readonly [number, number])[] }[] }
  | Extract<ReaderPublicationEvidenceGutterWindow, { kind: "Pdf" }>;

export interface PublicationGutterTextPart {
  readonly unitKey: string;
  readonly fragmentId: string;
  readonly renderStart: number;
  readonly root: HTMLElement;
  readonly cursor: CanonicalCursorResult;
}

function visible(rect: DOMRect, viewport: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0 && rect.left < viewport.right && rect.right > viewport.left && rect.top < viewport.bottom && rect.bottom > viewport.top;
}

/** The caller reserves maxBytes before this synchronous source projection. */
export function readTextGutterWindow(parts: Iterable<PublicationGutterTextPart>, viewport: DOMRect, maxBytes: number): ReaderGutterWindow | null {
  const units: { unit_key: string; fragment_id: string; ranges: [number, number][] }[] = [];
  let bytes = 64;
  const range = document.createRange();
  for (const part of parts) {
    if (!visible(part.root.getBoundingClientRect(), viewport)) continue;
    // JSON escaping is at most six ASCII bytes per UTF-16 code unit. This also
    // bounds the primitive payload, including the local fragment attestation.
    bytes += 96 + 6 * (part.unitKey.length + part.fragmentId.length);
    if (bytes > maxBytes) return null;
    const ranges: [number, number][] = [];
    const append = (start: number, end: number): boolean => {
      const last = ranges[ranges.length - 1];
      if (last !== undefined && last[1] === start) { last[1] = end; return true; }
      // Two safe-integer offsets, array punctuation and a following comma.
      if (bytes + 36 > maxBytes) return false;
      bytes += 36; ranges.push([start, end]); return true;
    };
    const spans = part.cursor.provenance;
    const visit = (start: number, end: number): boolean => {
      const first = spans[start].spans[0];
      const last = spans[end - 1].spans[0];
      range.setStart(first.node, first.startUtf16); range.setEnd(last.node, last.endUtf16);
      const rects = range.getClientRects();
      let any = false;
      let contained = true;
      for (const rect of rects) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        any ||= visible(rect, viewport);
        contained &&= rect.left >= viewport.left && rect.right <= viewport.right && rect.top >= viewport.top && rect.bottom <= viewport.bottom;
      }
      if (!any) return true;
      if (contained || end - start === 1) return append(part.renderStart + start, part.renderStart + end);
      const middle = start + Math.floor((end - start) / 2);
      return visit(start, middle) && visit(middle, end);
    };
    for (let index = 0; index < spans.length;) {
      const source = spans[index].spans;
      if (source.length === 1) {
        let end = index + 1;
        while (end < spans.length && spans[end].spans.length === 1 && spans[end].spans[0].node === source[0].node && spans[end - 1].spans[0].endUtf16 === spans[end].spans[0].startUtf16) end += 1;
        if (!visit(index, end)) return null;
        index = end;
      } else {
        let any = false;
        for (const span of source) {
          range.setStart(span.node, span.startUtf16); range.setEnd(span.node, span.endUtf16);
          for (const rect of range.getClientRects()) any ||= visible(rect, viewport);
        }
        if (any && !append(part.renderStart + index, part.renderStart + index + 1)) return null;
        index += 1;
      }
    }
    if (ranges.length !== 0 || spans.length === 0) units.push({ unit_key: part.unitKey, fragment_id: part.fragmentId, ranges });
  }
  return { kind: "Text", units };
}

export function readPdfGutterWindow(content: HTMLElement, viewport: DOMRect, maxBytes: number): ReaderGutterWindow | null {
  const pages: { page: number; rect: { left: number; top: number; right: number; bottom: number } }[] = [];
  for (const element of content.querySelectorAll<HTMLElement>(".page[data-page-number]")) {
    const rect = element.getBoundingClientRect();
    if (!visible(rect, viewport)) continue;
    const transform = readPdfPageViewportTransform(element);
    if (transform === null) continue; // PDF.js has not positioned this page yet.
    if (64 + (pages.length + 1) * 256 > maxBytes) return null;
    const left = Math.max(rect.left, viewport.left) - rect.left;
    const right = Math.min(rect.right, viewport.right) - rect.left;
    const top = Math.max(rect.top, viewport.top) - rect.top;
    const bottom = Math.min(rect.bottom, viewport.bottom) - rect.top;
    const corners = [viewportPointToPagePoint(left, top, transform), viewportPointToPagePoint(right, top, transform),
      viewportPointToPagePoint(left, bottom, transform), viewportPointToPagePoint(right, bottom, transform)];
    pages.push({ page: Number(element.dataset.pageNumber), rect: {
      left: Math.max(0, Math.min(...corners.map((point) => point.x))), right: Math.min(transform.pageWidthPoints, Math.max(...corners.map((point) => point.x))),
      top: Math.max(0, Math.min(...corners.map((point) => point.y))), bottom: Math.min(transform.pageHeightPoints, Math.max(...corners.map((point) => point.y))),
    } });
  }
  return { kind: "Pdf", pages };
}

/** Visit original canonical provenance, including the trailing authored EOF line. */
export function visitPublicationTextRangeRects(part: PublicationGutterTextPart, sourceRange: ReaderPublicationSourceRange, take: (rect: DOMRect) => boolean): boolean {
  if (part.fragmentId !== sourceRange.fragment_id) return true;
  const spans = part.cursor.provenance;
  const point = sourceRange.start_cp === sourceRange.end_cp;
  if (point && part.unitKey !== sourceRange.unit_key) return true;
  const range = document.createRange();
  let index = Math.max(0, sourceRange.start_cp - part.renderStart);
  const end = point ? Math.min(spans.length, index + 1) : Math.min(spans.length, sourceRange.end_cp - part.renderStart);
  if (point && index === spans.length && spans.length > 0) index -= 1;
  while (index < end) {
    const source = spans[index].spans;
    if (source.length === 1) {
      let next = index + 1;
      while (next < end && spans[next].spans.length === 1 && spans[next].spans[0].node === source[0].node && spans[next - 1].spans[0].endUtf16 === spans[next].spans[0].startUtf16) next += 1;
      range.setStart(source[0].node, source[0].startUtf16); range.setEnd(spans[next - 1].spans[0].node, spans[next - 1].spans[0].endUtf16);
      for (const rect of range.getClientRects()) if (!take(rect)) return false;
      index = next;
    } else {
      for (const span of source) {
        range.setStart(span.node, span.startUtf16); range.setEnd(span.node, span.endUtf16);
        for (const rect of range.getClientRects()) if (!take(rect)) return false;
      }
      index += 1;
    }
  }
  return !point || part.cursor.length !== 0 || take(part.root.getBoundingClientRect());
}

/** Measure only the current admitted roots; no DOM reference escapes this call. */
export function publicationGutterTop(item: ReaderPublicationEvidenceGutterItem, parts: Iterable<PublicationGutterTextPart>, content: HTMLElement, viewport: DOMRect): number | null {
  let top: number | null = null;
  let mostVisible = 0;
  const take = (rect: DOMRect) => {
    if (!visible(rect, viewport)) return;
    const pixels = Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top);
    if (pixels > mostVisible) { top = Math.max(rect.top, viewport.top); mostVisible = pixels; }
  };
  const location = item.location;
  if (location.kind === "Text") {
    for (const part of parts) visitPublicationTextRangeRects(part, location.range, (rect) => { take(rect); return true; });
  } else {
    const page = content.querySelector<HTMLElement>(`.page[data-page-number="${location.page}"]`);
    if (page === null) return null;
    const rect = page.getBoundingClientRect();
    if (location.kind === "PdfPage") take(rect);
    else {
      const transform = readPdfPageViewportTransform(page);
      if (transform === null) return null;
      for (const quad of location.quads) {
        const projected = projectPdfQuadToViewportRect(quad, transform);
        take(new DOMRect(rect.left + projected.left, rect.top + projected.top, projected.width, projected.height));
      }
    }
  }
  return top;
}
