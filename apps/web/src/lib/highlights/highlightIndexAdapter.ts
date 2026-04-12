import type { PdfHighlightOut } from "@/components/PdfReader";
import type { Highlight } from "@/components/HighlightEditor";
import type { AnchorDescriptor } from "./anchorProviders";

export interface MediaHighlightForIndex extends Highlight {
  fragment_idx: number;
}

export interface PaneHighlightIndexItem {
  id: string;
  exact: string;
  color: Highlight["color"];
  annotation: Highlight["annotation"];
  start_offset?: number;
  end_offset?: number;
  created_at?: string;
  fragment_id?: string;
  fragment_idx?: number;
  stable_order_key?: string;
  linked_conversations?: { conversation_id: string; title: string }[];
}

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

export function toFragmentPaneItems(highlights: Highlight[]): PaneHighlightIndexItem[] {
  return highlights.map((highlight) => ({
    id: highlight.id,
    exact: highlight.exact,
    color: highlight.color,
    annotation: highlight.annotation,
    start_offset: highlight.start_offset,
    end_offset: highlight.end_offset,
    created_at: highlight.created_at,
    fragment_id: highlight.fragment_id,
    linked_conversations: highlight.linked_conversations,
  }));
}

export function toMediaPaneItems(highlights: MediaHighlightForIndex[]): PaneHighlightIndexItem[] {
  return highlights.map((highlight) => ({
    id: highlight.id,
    exact: highlight.exact,
    color: highlight.color,
    annotation: highlight.annotation,
    start_offset: highlight.start_offset,
    end_offset: highlight.end_offset,
    created_at: highlight.created_at,
    fragment_id: highlight.fragment_id,
    fragment_idx: highlight.fragment_idx,
    linked_conversations: highlight.linked_conversations,
  }));
}

export function toPdfPagePaneItems(highlights: PdfHighlightOut[]): PaneHighlightIndexItem[] {
  return highlights.map((highlight) => ({
    id: highlight.id,
    exact: highlight.exact,
    color: highlight.color,
    annotation: highlight.annotation,
    created_at: highlight.created_at,
    linked_conversations: highlight.linked_conversations,
  }));
}

export function toPdfDocumentPaneItems(highlights: PdfHighlightOut[]): PaneHighlightIndexItem[] {
  return sortPdfHighlightsByStableKey(highlights).map((highlight) => {
    const key = toPdfStableOrderKey(highlight);
    const metrics = quadSortMetrics(highlight);
    return {
      id: highlight.id,
      exact: highlight.exact,
      color: highlight.color,
      annotation: highlight.annotation,
      created_at: highlight.created_at,
      fragment_idx: key.page_number,
      start_offset: Math.round(metrics.top * 1000),
      end_offset: Math.round(metrics.bottom * 1000),
      stable_order_key: encodePdfStableOrderKey(key),
      linked_conversations: highlight.linked_conversations,
    };
  });
}

export function toPdfPageAnchorDescriptors(highlights: PdfHighlightOut[]): AnchorDescriptor[] {
  return highlights.map((highlight) => ({
    kind: "pdf" as const,
    id: highlight.id,
    pageNumber: highlight.anchor.page_number,
    quads: highlight.anchor.quads,
  }));
}

export function toHtmlAnchorDescriptors(highlights: PaneHighlightIndexItem[]): AnchorDescriptor[] {
  return highlights.map((highlight) => ({
    kind: "html" as const,
    id: highlight.id,
  }));
}
