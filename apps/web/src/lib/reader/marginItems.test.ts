import { describe, expect, it } from "vitest";
import type {
  ReaderEvidence,
  ReaderEvidenceItem,
  ReaderEvidencePassageGroup,
} from "./documentMap";
import {
  MARGIN_MAX_ITEMS,
  anchoredRowForEvidenceItem,
  buildMarginItems,
  capProjectedMarginRows,
  stackAnchoredRows,
} from "./marginItems";
import type { EvidenceFilterState } from "./useEvidenceFilters";

const ALL_ON: EvidenceFilterState = {
  highlight: true,
  citation: true,
  link: true,
  synapse: true,
};
const absent = { kind: "Absent" } as const;

function item(
  kind: ReaderEvidenceItem["kind"],
  id: string,
): ReaderEvidenceItem {
  const base = {
    id: `${kind.toLowerCase()}:${id}`,
    label: `${kind} ${id}`,
    excerpt: absent,
    associations: [],
  };
  switch (kind) {
    case "Highlight":
      return {
        ...base,
        kind,
        highlight_id: id,
        quote: `quote ${id}`,
        prefix: "",
        suffix: "",
        color: "yellow",
        created_at: "2026-07-20T00:00:00Z",
        updated_at: "2026-07-20T00:00:00Z",
        author_user_id: "user-1",
        is_owner: true,
      };
    case "SourceReference":
      return {
        ...base,
        kind,
        stable_key: id,
        apparatus_kind: "footnote_ref",
        confidence: "exact",
        targets: [],
      };
    case "GeneratedCitation":
      return { ...base, kind, edge_id: id, role: "context" };
    case "Link":
      return {
        ...base,
        kind,
        edge_id: id,
        role: "context",
        origin: "user",
        object: {
          ref: `media:${id}`,
          kind: "Media",
          label: "Linked media",
          excerpt: absent,
          activation: {
            resourceRef: `media:${id}`,
            kind: "route",
            href: `/media/${id}`,
            unresolvedReason: null,
          },
        },
      };
    case "Synapse":
      return {
        ...base,
        kind,
        edge_id: id,
        role: "context",
        rationale: "These passages resonate.",
        object: {
          ref: `media:${id}`,
          kind: "Media",
          label: "Resonant media",
          excerpt: absent,
          activation: {
            resourceRef: `media:${id}`,
            kind: "route",
            href: `/media/${id}`,
            unresolvedReason: null,
          },
        },
      };
  }
}

function evidence(items: ReaderEvidenceItem[]): ReaderEvidence {
  return {
    counts: {
      highlights: 1,
      citations: 1,
      links: 1,
      synapses: 1,
      passages: 1,
      document: 0,
    },
    passage_groups: [
      {
        locus_ref: "highlight:locus",
        resolution: {
          kind: "Resolved",
          anchor: {
            locator: {
              type: "web_text_offsets",
              media_id: "media-1",
              fragment_id: "fragment-1",
              start_offset: 4,
              end_offset: 12,
            },
            passage_anchor_id: null,
          },
          order_key: "document:0001",
        },
        target_excerpt: { kind: "Present", value: "quote locus" },
        items,
        also_references: [],
      },
    ],
    document_items: [],
  };
}

describe("buildMarginItems", () => {
  it("projects each semantic fact exactly once and respects combined filters", () => {
    const facts = [
      item("Highlight", "h1"),
      item("SourceReference", "c1"),
      item("GeneratedCitation", "c2"),
      item("Link", "l1"),
      item("Synapse", "s1"),
    ];
    expect(
      buildMarginItems(evidence(facts), ALL_ON).map((row) => row.kind),
    ).toEqual(["highlight", "citation", "citation", "link", "synapse"]);
    expect(
      buildMarginItems(evidence(facts), {
        ...ALL_ON,
        citation: false,
        synapse: false,
      }).map((row) => row.kind),
    ).toEqual(["highlight", "link"]);
  });

  it("excludes document-scoped and unavailable facts from the aligned margin", () => {
    const source = evidence([item("Highlight", "h1")]);
    source.document_items = [item("Link", "document")];
    source.passage_groups[0]!.resolution = {
      kind: "Unavailable",
      reason: "Stale",
    };
    expect(buildMarginItems(source, ALL_ON)).toEqual([]);
  });

  it("derives one stance mark from an outgoing user highlight attachment", () => {
    const sourceHighlight = item("Highlight", "h1");
    sourceHighlight.associations = [
      {
        relationship: "DirectlyAttached",
        object: {
          ref: "media:media-1",
          kind: "Media",
          label: "This document",
          excerpt: absent,
          activation: {
            resourceRef: "media:media-1",
            kind: "route",
            href: "/media/media-1",
            unresolvedReason: null,
          },
        },
        edge_id: "edge-stance",
        role: "contradicts",
        origin: "user",
        direction: "Outgoing",
      },
    ];

    const rows = buildMarginItems(evidence([sourceHighlight]), ALL_ON);
    expect(rows.filter((row) => row.kind === "stance")).toEqual([
      expect.objectContaining({
        id: "margin:stance:edge-stance",
        itemId: "highlight:h1",
        edgeId: "edge-stance",
        stance: "contradicts",
      }),
    ]);
  });

  it("controls stance presentation with the Link filter", () => {
    const sourceHighlight = item("Highlight", "h1");
    sourceHighlight.associations = [
      {
        relationship: "DirectlyAttached",
        object: {
          ref: "media:media-1",
          kind: "Media",
          label: "This document",
          excerpt: absent,
          activation: {
            resourceRef: "media:media-1",
            kind: "route",
            href: "/media/media-1",
            unresolvedReason: null,
          },
        },
        edge_id: "edge-stance",
        role: "supports",
        origin: "user",
        direction: "Outgoing",
      },
    ];
    expect(
      buildMarginItems(evidence([sourceHighlight]), {
        ...ALL_ON,
        link: false,
      }).some((row) => row.kind === "stance"),
    ).toBe(false);
  });

  it("caps only the rows already projected into the viewport", () => {
    const rows = Array.from(
      { length: MARGIN_MAX_ITEMS + 3 },
      (_, index) => index,
    );
    expect(capProjectedMarginRows(rows)).toEqual({
      visible: rows.slice(0, MARGIN_MAX_ITEMS),
      hidden: 3,
    });
  });
});

describe("anchoredRowForEvidenceItem", () => {
  function pdfGroup(
    quads: unknown[],
    items: ReaderEvidenceItem[],
  ): ReaderEvidencePassageGroup {
    return {
      locus_ref: "link:locus",
      resolution: {
        kind: "Resolved",
        anchor: {
          locator: {
            type: "pdf_page_geometry",
            media_id: "m1",
            page_number: 3,
            quads,
            exact: "",
          },
          passage_anchor_id: null,
        },
        order_key: "document:0001",
      },
      target_excerpt: absent,
      items,
      also_references: [],
    };
  }

  it("keeps a page-only PDF passage-anchor locator (no quads) instead of dropping it", () => {
    // A Link resolved through a passage_anchor on PDF media carries only
    // `page_number` until a fresh selection supplies real quads (the
    // passage-anchor resolver never recomputes geometry). This must not be
    // dropped from margin/Evidence projection just because it is coarse.
    const link = item("Link", "l1");
    const group = pdfGroup([], [link]);
    const anchor = anchoredRowForEvidenceItem(group, link);
    expect(anchor).not.toBeNull();
    expect(anchor?.page_number).toBe(3);
    expect(anchor?.quads).toEqual([]);
  });
});

describe("stackAnchoredRows", () => {
  it("pushes overlapping rows below the previous row", () => {
    expect(
      stackAnchoredRows(
        [
          { id: "a", desiredTop: 0 },
          { id: "b", desiredTop: 10 },
        ],
        { rowHeights: new Map(), rowHeight: 20, gap: 4, containerHeight: 100 },
      ).alignedRows,
    ).toEqual([
      { id: "a", top: 0 },
      { id: "b", top: 24 },
    ]);
  });

  it("returns only in-bounds rows and counts clipped actions as overflow", () => {
    expect(
      stackAnchoredRows(
        [
          { id: "a", desiredTop: 0 },
          { id: "b", desiredTop: 10 },
          { id: "c", desiredTop: 20 },
        ],
        { rowHeights: new Map(), rowHeight: 20, gap: 4, containerHeight: 45 },
      ),
    ).toEqual({
      alignedRows: [
        { id: "a", top: 0 },
        { id: "b", top: 24 },
      ],
      overflowCount: 1,
    });
  });
});
