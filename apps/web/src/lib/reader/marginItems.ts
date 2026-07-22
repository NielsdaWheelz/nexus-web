import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import { parseRawPdfQuads } from "@/lib/highlights/pdfTypes";
import {
  highlightNoteAssociations,
  semanticKindForEvidenceItem,
  userStanceAssociations,
  type ReaderEvidence,
  type ReaderEvidenceItem,
  type ReaderEvidencePassageGroup,
  type ReaderEvidenceSemanticKind,
} from "@/lib/reader/documentMap";
import {
  evidenceItemPassesFilters,
  type EvidenceFilterState,
} from "@/lib/reader/useEvidenceFilters";

// Applied after viewport projection in MarginRail. This bounds the live gutter
// without allowing early-document facts to crowd later visible passages out.
export const MARGIN_MAX_ITEMS = 24 as const;

export type MarginItemKind = ReaderEvidenceSemanticKind | "stance";

export interface MarginItem {
  id: string;
  itemId: string;
  kind: MarginItemKind;
  anchor: AnchoredReaderRow;
  label: string;
  excerpt?: string;
  edgeId?: string;
  stance?: "supports" | "contradicts";
}

export function capProjectedMarginRows<T>(rows: readonly T[]): {
  visible: T[];
  hidden: number;
} {
  return {
    visible: rows.slice(0, MARGIN_MAX_ITEMS),
    hidden: Math.max(0, rows.length - MARGIN_MAX_ITEMS),
  };
}

export function stackAnchoredRows(
  positioned: { id: string; desiredTop: number }[],
  opts: {
    rowHeights: Map<string, number>;
    rowHeight: number;
    gap: number;
    containerHeight: number;
  },
): { alignedRows: { id: string; top: number }[]; overflowCount: number } {
  const { rowHeights, rowHeight, gap, containerHeight } = opts;
  const sorted = [...positioned].sort(
    (left, right) => left.desiredTop - right.desiredTop,
  );

  let previousBottom = -gap;
  const alignedRows: { id: string; top: number }[] = [];
  for (const row of sorted) {
    const top = Math.max(0, row.desiredTop, previousBottom + gap);
    alignedRows.push({ id: row.id, top });
    previousBottom = top + (rowHeights.get(row.id) ?? rowHeight);
  }

  const visibleRows: { id: string; top: number }[] = [];
  let overflowCount = 0;
  for (const row of alignedRows) {
    if (row.top + (rowHeights.get(row.id) ?? rowHeight) <= containerHeight) {
      visibleRows.push(row);
    } else {
      overflowCount += 1;
    }
  }
  return { alignedRows: visibleRows, overflowCount };
}

export function buildMarginItems(
  evidence: ReaderEvidence,
  filters: EvidenceFilterState,
): MarginItem[] {
  const items: MarginItem[] = [];
  for (const group of evidence.passage_groups) {
    if (group.resolution.kind !== "Resolved") continue;
    for (const item of group.items) {
      const anchor = anchoredRowForEvidenceItem(group, item);
      if (!anchor) continue;
      if (evidenceItemPassesFilters(item, filters)) {
        items.push({
          id: `margin:${item.id}`,
          itemId: item.id,
          kind: semanticKindForEvidenceItem(item),
          anchor,
          label: item.label,
          excerpt: marginExcerpt(item),
          edgeId: item.kind === "Synapse" ? item.edge_id : undefined,
        });
      }
      if (item.kind === "Highlight" && filters.link) {
        for (const association of userStanceAssociations(item)) {
          items.push({
            id: `margin:stance:${association.edge_id}`,
            itemId: item.id,
            kind: "stance",
            anchor: { ...anchor, id: `stance:${association.edge_id}` },
            label: association.role === "supports" ? "Conceded" : "Doubted",
            edgeId: association.edge_id,
            stance: association.role,
          });
        }
      }
    }
  }
  return items;
}

export function anchoredRowForEvidenceItem(
  group: ReaderEvidencePassageGroup,
  item: ReaderEvidenceItem,
): AnchoredReaderRow | null {
  if (group.resolution.kind !== "Resolved") return null;
  const locator = group.resolution.anchor.locator;
  const base = {
    id: item.id,
    exact: item.kind === "Highlight" ? item.quote : item.label,
    color: item.kind === "Highlight" ? item.color : ("blue" as const),
    stable_order_key: group.resolution.order_key,
  };
  if (
    locator.type === "web_text_offsets" ||
    locator.type === "epub_fragment_offsets"
  ) {
    return {
      ...base,
      anchor: {
        fragment_id: locator.fragment_id,
        start_offset: locator.start_offset,
        end_offset: locator.end_offset,
      },
    };
  }
  if (locator.type === "pdf_page_geometry") {
    if (typeof locator.page_number !== "number") return null;
    // A fact resolved through a passage_anchor is legitimately page-only: the
    // passage-anchor resolver recomputes quote identity, never geometry, so its
    // locator carries no quads until a fresh selection supplies them. Page-only
    // projection beats dropping the row from the margin/Evidence entirely.
    const quads = parseRawPdfQuads(locator.quads);
    return {
      ...base,
      page_number: locator.page_number,
      quads,
    };
  }
  return null;
}

function marginExcerpt(item: ReaderEvidenceItem): string | undefined {
  if (item.kind === "Highlight") {
    const note = highlightNoteAssociations(item).find(
      (association) => association.object.excerpt.kind === "Present",
    );
    return note?.object.excerpt.kind === "Present"
      ? note.object.excerpt.value
      : item.quote;
  }
  if (item.kind === "SourceReference") {
    const body = item.targets.find(
      (target) => target.body.kind === "Present",
    )?.body;
    if (body?.kind === "Present") return body.value;
  }
  if (item.kind === "Synapse") return item.rationale;
  if (item.excerpt.kind === "Present") return item.excerpt.value;
  return undefined;
}
