import type { PdfHighlightOut } from "@/components/PdfReader";

export interface PdfStableOrderKey {
  page_number: number;
  sort_top: number;
  sort_left: number;
  created_at: string;
  id: string;
}

function normalizeIsoMillis(value?: string): number {
  const parsed = Date.parse(value ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function quadSortMetrics(highlight: PdfHighlightOut): { top: number; left: number; bottom: number } {
  const first = highlight.anchor.quads[0];
  if (!first) {
    return { top: 0, left: 0, bottom: 0 };
  }
  return {
    top: Math.min(first.y1, first.y2, first.y3, first.y4),
    left: Math.min(first.x1, first.x2, first.x3, first.x4),
    bottom: Math.max(first.y1, first.y2, first.y3, first.y4),
  };
}

function normalizeSortNumber(value: number): string {
  // 6dp avoids float noise while preserving cursor-sort fidelity.
  return value.toFixed(6).padStart(16, "0");
}

function normalizePageNumber(value: number): string {
  return String(value).padStart(8, "0");
}

export function toPdfStableOrderKey(highlight: PdfHighlightOut): PdfStableOrderKey {
  const metrics = quadSortMetrics(highlight);
  return {
    page_number: highlight.anchor.page_number,
    sort_top: metrics.top,
    sort_left: metrics.left,
    created_at: highlight.created_at,
    id: highlight.id,
  };
}

export function encodePdfStableOrderKey(key: PdfStableOrderKey): string {
  return [
    normalizePageNumber(key.page_number),
    normalizeSortNumber(key.sort_top),
    normalizeSortNumber(key.sort_left),
    key.created_at,
    key.id,
  ].join(":");
}

export function comparePdfStableOrderKeys(a: PdfStableOrderKey, b: PdfStableOrderKey): number {
  if (a.page_number !== b.page_number) {
    return a.page_number - b.page_number;
  }
  if (a.sort_top !== b.sort_top) {
    return a.sort_top - b.sort_top;
  }
  if (a.sort_left !== b.sort_left) {
    return a.sort_left - b.sort_left;
  }
  const createdDelta = normalizeIsoMillis(a.created_at) - normalizeIsoMillis(b.created_at);
  if (createdDelta !== 0) {
    return createdDelta;
  }
  return a.id.localeCompare(b.id);
}

export function sortPdfHighlightsByStableKey(highlights: PdfHighlightOut[]): PdfHighlightOut[] {
  return [...highlights].sort((a, b) =>
    comparePdfStableOrderKeys(toPdfStableOrderKey(a), toPdfStableOrderKey(b))
  );
}
