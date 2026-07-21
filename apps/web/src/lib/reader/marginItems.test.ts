import { describe, expect, it } from "vitest";
import {
  MARGIN_MAX_ITEMS,
  anchoredRowFromConnection,
  buildMarginItems,
  stackAnchoredRows,
  type MarginSources,
} from "./marginItems";
import type { EvidenceFilterState } from "./useEvidenceFilters";
import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import type { ReaderConnectionRow } from "./documentMap";

const ALL_ON: EvidenceFilterState = { highlight: true, apparatus: true, connection: true };

function highlightWithNote(id: string, orderKey: string, note: string): AnchoredReaderRow {
  return {
    id,
    exact: "text",
    color: "yellow",
    stable_order_key: orderKey,
    anchor: { fragment_id: "frag", start_offset: 0, end_offset: 4 },
    linked_note_blocks: [{ note_block_id: `nb-${id}`, body_text: note }],
  };
}

function connectionRow(
  edgeId: string,
  orderKey: string,
  opts: {
    origin: ReaderConnectionRow["connection"]["origin"];
    kind: ReaderConnectionRow["connection"]["kind"];
    sourceCategory: ReaderConnectionRow["source_category"];
    title?: string;
    excerpt?: string;
    locator?: Record<string, unknown>;
  },
): ReaderConnectionRow {
  return {
    id: `edge:${edgeId}`,
    connection: {
      edge_id: edgeId,
      direction: "incoming",
      kind: opts.kind,
      origin: opts.origin,
      snapshot: null,
      source_order_key: null,
      target_order_key: null,
      ordinal: null,
      source_ref: "media:src",
      target_ref: "media:dst",
      source: {} as ReaderConnectionRow["connection"]["source"],
      target: {} as ReaderConnectionRow["connection"]["target"],
      other: { ref: "media:other" } as ReaderConnectionRow["connection"]["other"],
      citation: null,
      created_at: "2026-07-08T00:00:00Z",
    },
    anchor: {
      ref: "evidence_span:x",
      media_id: "m1",
      locator: opts.locator ?? {
        type: "web_text_offsets",
        media_id: "m1",
        fragment_id: "frag",
        start_offset: 0,
        end_offset: 5,
      },
      page_number: null,
      fragment_id: "frag",
      highlight_id: null,
      evidence_span_id: "x",
      passage_anchor_id: null,
      order_key: orderKey,
    },
    source_category: opts.sourceCategory,
    title: opts.title ?? "Other Work",
    subtitle: null,
    excerpt: opts.excerpt ?? null,
    activation: {} as ReaderConnectionRow["activation"],
    href: "/media/other#p",
  };
}

describe("buildMarginItems", () => {
  it("classifies each kind exactly once (stance→link→synapse→note)", () => {
    const sources: MarginSources = {
      highlights: [highlightWithNote("h1", "document:0001", "a note")],
      connectionRows: [
        connectionRow("e-syn", "document:0002", {
          origin: "synapse",
          kind: "context",
          sourceCategory: "synapse",
          excerpt: "resonant",
        }),
        connectionRow("e-cite", "document:0003", {
          origin: "user",
          kind: "context",
          sourceCategory: "user_link",
          title: "Cited Work",
        }),
        connectionRow("e-stance", "document:0004", {
          origin: "user",
          kind: "supports",
          sourceCategory: "user_link",
        }),
      ],
    };
    const { items } = buildMarginItems(sources, ALL_ON);
    expect(items.map((item) => item.kind)).toEqual(["note", "synapse", "link", "stance"]);
  });

  it("emits exactly one item for a stance edge (no link+stance double)", () => {
    const sources: MarginSources = {
      highlights: [],
      connectionRows: [
        connectionRow("e-stance", "document:0001", {
          origin: "user",
          kind: "contradicts",
          sourceCategory: "user_link",
        }),
      ],
    };
    const { items } = buildMarginItems(sources, ALL_ON);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("stance");
    expect(items[0]?.stance).toBe("contradicts");
  });

  it("hides link+stance+synapse when the connection filter is off", () => {
    const sources: MarginSources = {
      highlights: [highlightWithNote("h1", "document:0001", "kept note")],
      connectionRows: [
        connectionRow("e-syn", "document:0002", {
          origin: "synapse",
          kind: "context",
          sourceCategory: "synapse",
          excerpt: "resonant",
        }),
        connectionRow("e-stance", "document:0003", {
          origin: "user",
          kind: "supports",
          sourceCategory: "user_link",
        }),
      ],
    };
    const { items } = buildMarginItems(sources, {
      highlight: true,
      apparatus: true,
      connection: false,
    });
    expect(items.map((item) => item.kind)).toEqual(["note"]);
  });

  it("sorts by order key and caps at MARGIN_MAX_ITEMS", () => {
    const highlights = Array.from({ length: MARGIN_MAX_ITEMS + 3 }, (_unused, index) =>
      highlightWithNote(`h${index}`, `document:${String(index).padStart(4, "0")}`, `note ${index}`),
    );
    const { items, hiddenByCap } = buildMarginItems({ highlights, connectionRows: [] }, ALL_ON);
    expect(items).toHaveLength(MARGIN_MAX_ITEMS);
    expect(hiddenByCap).toBe(3);
    expect(items[0]?.orderKey).toBe("document:0000");
  });

  it("drops a note-less highlight", () => {
    const bare: AnchoredReaderRow = {
      id: "hb",
      exact: "t",
      color: "blue",
      stable_order_key: "document:0001",
      anchor: { fragment_id: "frag", start_offset: 0, end_offset: 2 },
    };
    const { items } = buildMarginItems({ highlights: [bare], connectionRows: [] }, ALL_ON);
    expect(items).toEqual([]);
  });
});

describe("anchoredRowFromConnection", () => {
  it("keeps a page-only PDF passage-anchor locator (no quads) instead of dropping it", () => {
    // A Link resolved through a passage_anchor on PDF media carries only
    // `page_number` until a fresh selection supplies real quads (the
    // passage-anchor resolver never recomputes geometry). This must not be
    // dropped from margin/Evidence projection just because it is coarse.
    const row = connectionRow("e-pdf", "document:0001", {
      origin: "user",
      kind: "context",
      sourceCategory: "user_link",
      locator: { type: "pdf_page_geometry", media_id: "m1", page_number: 3 },
    });
    const anchor = anchoredRowFromConnection(row);
    expect(anchor).not.toBeNull();
    expect(anchor?.page_number).toBe(3);
    expect(anchor?.quads).toEqual([]);
  });

  it("still drops a pdf_page_geometry locator with no page_number", () => {
    const row = connectionRow("e-pdf", "document:0001", {
      origin: "user",
      kind: "context",
      sourceCategory: "user_link",
      locator: { type: "pdf_page_geometry", media_id: "m1" },
    });
    expect(anchoredRowFromConnection(row)).toBeNull();
  });
});

describe("stackAnchoredRows", () => {
  const opts = {
    rowHeights: new Map<string, number>(),
    rowHeight: 20,
    gap: 4,
    containerHeight: 100,
  };

  it("pushes overlapping rows below the previous bottom + gap", () => {
    const { alignedRows } = stackAnchoredRows(
      [
        { id: "a", desiredTop: 0 },
        { id: "b", desiredTop: 10 },
      ],
      opts,
    );
    expect(alignedRows).toEqual([
      { id: "a", top: 0 },
      { id: "b", top: 24 },
    ]);
  });

  it("stable-sorts by desiredTop and counts rows past the container height", () => {
    const { alignedRows, overflowCount } = stackAnchoredRows(
      [
        { id: "a", desiredTop: 0 },
        { id: "b", desiredTop: 30 },
        { id: "c", desiredTop: 60 },
        { id: "d", desiredTop: 90 },
      ],
      opts,
    );
    expect(alignedRows.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
    // d at top 90 + height 20 = 110 > 100 → overflow.
    expect(overflowCount).toBe(1);
  });
});
