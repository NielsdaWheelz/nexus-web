import { compareStableString } from "@/lib/display/format";
import { parseRawPdfQuads } from "@/lib/highlights/pdfTypes";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import type { EvidenceFilterState } from "@/lib/reader/useEvidenceFilters";
import type { ReaderConnectionRow } from "@/lib/reader/documentMap";

// ~24 items at minimum row height fill a 1080p gutter; a client render budget
// (not a style token or a server value), so it lives here rather than in
// globals.css / config.py. Overflow past this feeds the "+N more" foot.
export const MARGIN_MAX_ITEMS = 24 as const;

export type MarginItemKind = "note" | "synapse" | "link" | "stance";

export interface MarginItem {
  id: string;
  kind: MarginItemKind;
  orderKey: string;
  /** Projected to its anchor by useAnchoredReaderProjection (borrowed row shape). */
  anchor: AnchoredReaderRow;
  /** note: the linked note's first-line body. */
  noteText?: string;
  /** synapse: the machine-hand rationale (rendered via MachineText inline). */
  excerpt?: string;
  /** link: the target work's title · section. */
  targetTitle?: string;
  /** link: deep link to the other work, when jumpable. */
  targetHref?: string | null;
  /** stance: the position glyph. */
  stance?: "supports" | "contradicts";
  /** synapse (dismiss) / stance (toggle-off) edge id. */
  edgeId?: string;
}

// ---------------------------------------------------------------------------
// The pure overlap/overflow solver — the geometry core lifted out of
// AnchoredSidecarSurface.alignRows (F3). Each caller computes its own baseline +
// desiredTop (from its own container/scroll geometry), pre-sorts by its order-key
// tiebreak, and delegates the push-below-previous-bottom + overflow-count here.
// The sort by desiredTop is stable, so equal tops keep the caller's order.
// ---------------------------------------------------------------------------

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
  const sorted = [...positioned].sort((left, right) => left.desiredTop - right.desiredTop);

  let previousBottom = -gap;
  const alignedRows: { id: string; top: number }[] = [];
  for (const row of sorted) {
    const top = Math.max(0, row.desiredTop, previousBottom + gap);
    alignedRows.push({ id: row.id, top });
    previousBottom = top + (rowHeights.get(row.id) ?? rowHeight);
  }

  let overflowCount = 0;
  for (const row of alignedRows) {
    if (row.top + (rowHeights.get(row.id) ?? rowHeight) > containerHeight) {
      overflowCount += 1;
    }
  }
  return { alignedRows, overflowCount };
}

// ---------------------------------------------------------------------------
// Connection → anchored row (shared by the margin and the Evidence sidecar so a
// single owner maps a reader-connection locator to an AnchoredReaderRow).
// ---------------------------------------------------------------------------

export function anchoredRowFromConnection(row: ReaderConnectionRow): AnchoredReaderRow | null {
  const locator = row.anchor?.locator;
  if (!locator) return null;
  const exact = row.excerpt ?? row.title;
  if (locator.type === "pdf_page_geometry") {
    if (typeof locator.page_number !== "number") return null;
    // A Link resolving through a passage_anchor locator is legitimately
    // page-only: the passage-anchor resolver recomputes quote identity but
    // never geometry (§ Passage Anchor), so its `locator_hint` carries no
    // `quads` until a fresh selection supplies one. Coarse (page-only)
    // projection beats dropping the row from the margin/Evidence sidecar
    // entirely — `parseRawPdfQuads` degrades to `[]` and downstream
    // projection falls back to its own missing-target handling rather than
    // painting at an incorrect location.
    const quads = parseRawPdfQuads(locator.quads);
    return {
      id: row.id,
      exact,
      color: "blue",
      page_number: locator.page_number,
      quads,
      stable_order_key: row.anchor?.order_key ?? row.id,
    };
  }
  if (
    (locator.type === "web_text_offsets" || locator.type === "epub_fragment_offsets") &&
    typeof locator.fragment_id === "string" &&
    typeof locator.start_offset === "number" &&
    typeof locator.end_offset === "number"
  ) {
    return {
      id: row.id,
      exact,
      color: "blue",
      anchor: {
        fragment_id: locator.fragment_id,
        start_offset: locator.start_offset,
        end_offset: locator.end_offset,
      },
      stable_order_key: row.anchor?.order_key ?? row.id,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// MarginItem assembly (client-side, no new fetch — §4.8).
// ---------------------------------------------------------------------------

export interface MarginSources {
  /** Highlights already held for the Evidence sidecar (anchored reader rows). */
  highlights: AnchoredReaderRow[];
  /** Reader-connection rows already held for the Evidence sidecar. */
  connectionRows: ReaderConnectionRow[];
}

function classifyConnection(row: ReaderConnectionRow): MarginItemKind | null {
  // Single if/else-if chain (F4), stance → link → synapse. A stance edge is
  // also a user_link row, so the stance-first ordering + the kind==="context"
  // guard on link keep one edge from emitting two items.
  const kind = row.connection.kind;
  const origin = row.connection.origin;
  if ((kind === "supports" || kind === "contradicts") && origin === "user") {
    return "stance";
  }
  if (row.source_category === "user_link" && kind === "context") {
    return "link";
  }
  if (row.source_category === "synapse") {
    return "synapse";
  }
  return null;
}

/**
 * Whether a MarginItem kind is currently visible under the shared filter. D-12:
 * `note` maps under Highlights; `link`/`stance`/`synapse` all map under
 * Connections — the same `EvidenceRowKind` mapping the sidecar uses, so a toggle
 * hides the kind in both presenters identically (AC-9).
 */
export function isMarginKindVisible(kind: MarginItemKind, filters: EvidenceFilterState): boolean {
  if (kind === "note") return filters.highlight;
  return filters.connection;
}

export interface MarginItemsResult {
  items: MarginItem[];
  /** Items dropped by the MARGIN_MAX_ITEMS cap — feeds the "+N more" foot (§4.4). */
  hiddenByCap: number;
}

export function buildMarginItems(
  sources: MarginSources,
  filters: EvidenceFilterState,
): MarginItemsResult {
  const items: MarginItem[] = [];

  if (filters.highlight) {
    for (const highlight of sources.highlights) {
      const note = highlight.linked_note_blocks?.find((block) => block.body_text.trim().length > 0);
      if (!note) continue;
      items.push({
        id: `note:${highlight.id}`,
        kind: "note",
        orderKey: highlight.stable_order_key ?? highlight.id,
        anchor: highlight,
        noteText: note.body_text,
      });
    }
  }

  if (filters.connection) {
    for (const row of sources.connectionRows) {
      const kind = classifyConnection(row);
      if (kind === null) continue;
      const anchor = anchoredRowFromConnection(row);
      if (!anchor) continue;
      const orderKey = row.anchor?.order_key ?? row.id;
      if (kind === "stance") {
        items.push({
          id: `stance:${row.connection.edge_id}`,
          kind,
          orderKey,
          anchor,
          stance: row.connection.kind === "supports" ? "supports" : "contradicts",
          edgeId: row.connection.edge_id,
        });
      } else if (kind === "link") {
        items.push({
          id: `link:${row.connection.edge_id}`,
          kind,
          orderKey,
          anchor,
          targetTitle: row.title,
          targetHref: row.href,
        });
      } else {
        items.push({
          id: `synapse:${row.connection.edge_id}`,
          kind,
          orderKey,
          anchor,
          excerpt: row.excerpt ?? row.title,
          edgeId: row.connection.edge_id,
        });
      }
    }
  }

  items.sort((left, right) => compareStableString(left.orderKey, right.orderKey));
  return {
    items: items.slice(0, MARGIN_MAX_ITEMS),
    hiddenByCap: Math.max(0, items.length - MARGIN_MAX_ITEMS),
  };
}
