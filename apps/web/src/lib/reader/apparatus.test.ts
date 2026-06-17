import { describe, expect, it } from "vitest";
import {
  buildReaderApparatusRows,
  isReaderApparatusResponse,
  readerApparatusRowPresentation,
  type ReaderApparatusItem,
  type ReaderApparatusResponse,
} from "./apparatus";

function apparatusItem(
  id: string,
  item: Omit<ReaderApparatusItem, "id" | "resource_ref">,
): ReaderApparatusItem {
  return {
    id,
    resource_ref: `reader_apparatus_item:${id}`,
    ...item,
  };
}

const response = {
  media_id: "media-1",
  media_kind: "web_article",
  status: "ready",
  extractor_version: "reader_apparatus_v1",
  source_fingerprint: "sha256:test",
  capabilities: {
    has_inline_markers: true,
    has_sidecar_items: true,
    supports_hover_preview: true,
    supports_jump_to_marker: true,
    supports_jump_to_target: true,
    has_probable_items: false,
  },
  items: [
    apparatusItem("11111111-1111-4111-8111-111111111111", {
      stable_key: "note-1",
      kind: "footnote",
      label: "1",
      body_text: "The source-authored note.",
      body_html_sanitized: null,
      locator: {
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 20,
        end_offset: 44,
        media_kind: "web_article",
        text_quote_selector: { exact: "The source-authored note." },
      },
      locator_status: "exact",
      confidence: "exact",
      extraction_method: "dpub_aria",
      source_ref: {},
      sort_key: "000000.target",
    }),
    apparatusItem("22222222-2222-4222-8222-222222222222", {
      stable_key: "marker-1",
      kind: "footnote_ref",
      label: "1",
      body_text: null,
      body_html_sanitized: null,
      locator: {
        type: "web_text_offsets",
        media_id: "media-1",
        fragment_id: "fragment-1",
        start_offset: 5,
        end_offset: 6,
        media_kind: "web_article",
        text_quote_selector: { exact: "1" },
      },
      locator_status: "exact",
      confidence: "exact",
      extraction_method: "dpub_aria",
      source_ref: {},
      sort_key: "000000.marker",
    }),
  ],
  edges: [
    {
      stable_key: "marker-1->note-1",
      from_stable_key: "marker-1",
      to_stable_key: "note-1",
      relation: "points_to_note",
      confidence: "exact",
      extraction_method: "dpub_aria",
      source_ref: {},
      sort_key: "000000.edge",
    },
  ],
  diagnostics: {},
} satisfies ReaderApparatusResponse;

describe("reader apparatus response contract", () => {
  it("accepts the strict backend shape and builds marker rows", () => {
    expect(isReaderApparatusResponse(response)).toBe(true);
    expect(buildReaderApparatusRows(response)).toEqual([
      expect.objectContaining({
        id: "marker-1",
        marker: expect.objectContaining({ kind: "footnote_ref" }),
        targets: [
          expect.objectContaining({ body_text: "The source-authored note." }),
        ],
        edges: [expect.objectContaining({ relation: "points_to_note" })],
        target: expect.objectContaining({
          body_text: "The source-authored note.",
        }),
        edge: expect.objectContaining({ relation: "points_to_note" }),
      }),
    ]);
  });

  it("keeps every target for a multi-reference academic citation marker", () => {
    const secondTarget = {
      ...response.items[0],
      stable_key: "note-2",
      label: "2",
      body_text: "A second cited reference.",
      sort_key: "000001.target",
    };
    const multiReferenceResponse: ReaderApparatusResponse = {
      ...response,
      items: [
        response.items[0],
        secondTarget,
        {
          ...response.items[1],
          kind: "bibliography_ref",
          label: "[1, 2]",
        },
      ],
      edges: [
        {
          ...response.edges[0],
          stable_key: "marker-1->note-2",
          relation: "cites_bibliography_entry",
          to_stable_key: "note-2",
          sort_key: "000000.edge.002",
        },
        {
          ...response.edges[0],
          relation: "cites_bibliography_entry",
          sort_key: "000000.edge.001",
        },
      ],
    };

    expect(buildReaderApparatusRows(multiReferenceResponse)).toEqual([
      expect.objectContaining({
        id: "marker-1",
        marker: expect.objectContaining({ kind: "bibliography_ref" }),
        targets: [
          expect.objectContaining({ stable_key: "note-1" }),
          expect.objectContaining({ stable_key: "note-2" }),
        ],
        edges: [
          expect.objectContaining({ to_stable_key: "note-1" }),
          expect.objectContaining({ to_stable_key: "note-2" }),
        ],
        target: expect.objectContaining({ stable_key: "note-1" }),
        edge: expect.objectContaining({ to_stable_key: "note-1" }),
      }),
    ]);
  });

  it("builds linked sidenote, linked margin-note, and target-only margin-note rows", () => {
    const sidenoteTarget: ReaderApparatusItem = {
      ...response.items[0],
      stable_key: "sidenote-1",
      kind: "sidenote",
      label: "1",
      body_text: "A numbered sidenote.",
      sort_key: "000010.target",
    };
    const sidenoteMarker: ReaderApparatusItem = {
      ...response.items[1],
      stable_key: "sidenote-marker-1",
      kind: "sidenote_ref",
      label: "1",
      sort_key: "000010.marker",
    };
    const marginTarget: ReaderApparatusItem = {
      ...response.items[0],
      stable_key: "margin-1",
      kind: "margin_note",
      label: "Margin note 1",
      body_text: "A linked margin note.",
      sort_key: "000011.target",
    };
    const marginMarker: ReaderApparatusItem = {
      ...response.items[1],
      stable_key: "margin-marker-1",
      kind: "margin_note_ref",
      label: "+",
      sort_key: "000011.marker",
    };
    const standaloneMargin: ReaderApparatusItem = {
      ...response.items[0],
      stable_key: "margin-standalone-1",
      kind: "margin_note",
      label: "Margin note 2",
      body_text: "A standalone margin note.",
      sort_key: "000012.target",
    };
    const topologyResponse: ReaderApparatusResponse = {
      ...response,
      items: [
        sidenoteTarget,
        sidenoteMarker,
        marginTarget,
        marginMarker,
        standaloneMargin,
      ],
      edges: [
        {
          ...response.edges[0],
          stable_key: "sidenote-marker-1->sidenote-1",
          from_stable_key: "sidenote-marker-1",
          to_stable_key: "sidenote-1",
          relation: "points_to_sidenote",
          extraction_method: "tufte_sidenote",
          sort_key: "000010.edge",
        },
        {
          ...response.edges[0],
          stable_key: "margin-marker-1->margin-1",
          from_stable_key: "margin-marker-1",
          to_stable_key: "margin-1",
          relation: "points_to_margin_note",
          extraction_method: "tufte_margin_note",
          sort_key: "000011.edge",
        },
      ],
    };

    expect(isReaderApparatusResponse(topologyResponse)).toBe(true);
    const rows = buildReaderApparatusRows(topologyResponse);

    expect(rows.map((row) => row.id)).toEqual([
      "sidenote-marker-1",
      "margin-marker-1",
      "margin-standalone-1",
    ]);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        marker: expect.objectContaining({ kind: "sidenote_ref" }),
        target: expect.objectContaining({ kind: "sidenote" }),
        edges: [expect.objectContaining({ relation: "points_to_sidenote" })],
      }),
    );
    expect(rows[1]).toEqual(
      expect.objectContaining({
        marker: expect.objectContaining({ kind: "margin_note_ref" }),
        target: expect.objectContaining({ kind: "margin_note" }),
        edges: [expect.objectContaining({ relation: "points_to_margin_note" })],
      }),
    );
    expect(rows[2]).toEqual(
      expect.objectContaining({
        id: "margin-standalone-1",
        marker: standaloneMargin,
        targets: [standaloneMargin],
        target: standaloneMargin,
        edges: [],
        edge: null,
      }),
    );
    expect(
      readerApparatusRowPresentation(rows[2], topologyResponse.capabilities),
    ).toMatchObject({
      markerOnly: false,
      resolvedTargets: true,
      canPreview: false,
      canActivateMarker: false,
      canActivateTarget: true,
    });
    expect(
      readerApparatusRowPresentation(rows[2], topologyResponse.capabilities)
        .targetStatusText,
    ).not.toBe("Citation marker detected; target not resolved.");
  });

  it("surfaces every unlinked target kind as a target-only row", () => {
    const targetKinds = [
      "footnote",
      "endnote",
      "bibliography_entry",
      "sidenote",
      "margin_note",
      "reference_section",
    ] as const;
    const targetOnlyItems = targetKinds.map((kind, index) => ({
      ...response.items[0],
      stable_key: `target-only-${kind}`,
      kind,
      label: `${index + 1}`,
      body_text: `${kind} body`,
      sort_key: `0000${index}.target`,
    }));
    const targetOnlyResponse: ReaderApparatusResponse = {
      ...response,
      capabilities: {
        ...response.capabilities,
        has_inline_markers: false,
        supports_hover_preview: false,
        supports_jump_to_marker: false,
      },
      items: targetOnlyItems,
      edges: [],
    };

    expect(isReaderApparatusResponse(targetOnlyResponse)).toBe(true);
    const rows = buildReaderApparatusRows(targetOnlyResponse);

    expect(rows.map((row) => row.marker.kind)).toEqual([...targetKinds]);
    expect(rows).toHaveLength(targetKinds.length);
    for (const row of rows) {
      expect(row.marker).toBe(row.target);
      expect(row.targets).toEqual([row.marker]);
      expect(row.edges).toEqual([]);
      expect(row.edge).toBeNull();
      expect(
        readerApparatusRowPresentation(row, targetOnlyResponse.capabilities),
      ).toMatchObject({
        markerOnly: false,
        resolvedTargets: true,
        canActivateMarker: false,
        canActivateTarget: true,
      });
    }
  });

  it("keeps partial PDF bibliography markers unresolved while allowing exact marker activation", () => {
    const pdfMarkerResponse: ReaderApparatusResponse = {
      ...response,
      media_kind: "pdf",
      status: "partial",
      capabilities: {
        has_inline_markers: true,
        has_sidecar_items: true,
        supports_hover_preview: false,
        supports_jump_to_marker: true,
        supports_jump_to_target: false,
        has_probable_items: false,
      },
      items: [
        {
          ...response.items[1],
          stable_key: "pdf-marker-1",
          kind: "bibliography_ref",
          label: "[13]",
          locator: {
            type: "pdf_page_geometry",
            media_id: "media-1",
            page_number: 2,
            quads: [
              {
                x1: 10,
                y1: 20,
                x2: 20,
                y2: 20,
                x3: 20,
                y3: 30,
                x4: 10,
                y4: 30,
              },
            ],
            exact: "[13]",
            text_quote_selector: { exact: "[13]" },
          },
          extraction_method: "pdf_native_link",
          sort_key: "0002.0001.marker",
        },
      ],
      edges: [],
      diagnostics: {
        pdf_native_link: {
          status: "target_materialization_pending",
          marker_count: 1,
          edge_count: 0,
        },
      },
    };

    expect(isReaderApparatusResponse(pdfMarkerResponse)).toBe(true);
    const [row] = buildReaderApparatusRows(pdfMarkerResponse);
    expect(row).toEqual(
      expect.objectContaining({
        id: "pdf-marker-1",
        targets: [],
        edges: [],
        target: null,
        edge: null,
      }),
    );
    expect(
      readerApparatusRowPresentation(row, pdfMarkerResponse.capabilities),
    ).toEqual({
      markerOnly: true,
      resolvedTargets: false,
      canPreview: false,
      canActivateMarker: true,
      canActivateTarget: false,
      targetStatusText: "Citation marker detected; target not resolved.",
    });
  });

  it("activates exact PDF native-link graph rows when marker and target geometry exist", () => {
    const pdfGraphResponse: ReaderApparatusResponse = {
      ...response,
      media_kind: "pdf",
      status: "ready",
      capabilities: {
        has_inline_markers: true,
        has_sidecar_items: true,
        supports_hover_preview: true,
        supports_jump_to_marker: true,
        supports_jump_to_target: true,
        has_probable_items: false,
      },
      items: [
        {
          ...response.items[1],
          stable_key: "pdf-marker-1",
          kind: "bibliography_ref",
          label: "[13]",
          locator: {
            type: "pdf_page_geometry",
            media_id: "media-1",
            page_number: 2,
            quads: [
              {
                x1: 10,
                y1: 20,
                x2: 20,
                y2: 20,
                x3: 20,
                y3: 30,
                x4: 10,
                y4: 30,
              },
            ],
            exact: "[13]",
            text_quote_selector: { exact: "[13]" },
          },
          extraction_method: "pdf_native_link",
          sort_key: "0002.0001.marker",
        },
        {
          ...response.items[0],
          stable_key: "pdf-target-13",
          kind: "bibliography_entry",
          label: "[13]",
          body_text: "[13] Long short-term memory. Neural computation.",
          locator: {
            type: "pdf_page_geometry",
            media_id: "media-1",
            page_number: 11,
            quads: [
              {
                x1: 100,
                y1: 200,
                x2: 500,
                y2: 200,
                x3: 500,
                y3: 235,
                x4: 100,
                y4: 235,
              },
            ],
            exact: "[13] Long short-term memory. Neural computation.",
            text_quote_selector: {
              exact: "[13] Long short-term memory. Neural computation.",
            },
          },
          extraction_method: "pdf_native_link_target",
          sort_key: "0011.000200.000.0013.target",
        },
      ],
      edges: [
        {
          stable_key: "pdf-marker-1->pdf-target-13",
          from_stable_key: "pdf-marker-1",
          to_stable_key: "pdf-target-13",
          relation: "cites_bibliography_entry",
          confidence: "exact",
          extraction_method: "pdf_native_link_target",
          source_ref: {},
          sort_key: "0002.0001.edge",
        },
      ],
      diagnostics: {
        pdf_native_link: {
          status: "targets_materialized",
          marker_count: 1,
          target_count: 1,
          edge_count: 1,
          unresolved_marker_count: 0,
        },
      },
    };

    expect(isReaderApparatusResponse(pdfGraphResponse)).toBe(true);
    const [row] = buildReaderApparatusRows(pdfGraphResponse);
    expect(
      readerApparatusRowPresentation(row, pdfGraphResponse.capabilities),
    ).toEqual({
      markerOnly: false,
      resolvedTargets: true,
      canPreview: true,
      canActivateMarker: true,
      canActivateTarget: true,
      targetStatusText: "Reference target has no preview text.",
    });
  });

  it("rejects unknown fields and locator/status contradictions", () => {
    expect(isReaderApparatusResponse({ ...response, unexpected: true })).toBe(
      false,
    );
    expect(
      isReaderApparatusResponse({
        ...response,
        items: [
          {
            ...response.items[1],
            locator: null,
            locator_status: "exact",
          },
        ],
      }),
    ).toBe(false);
  });

  it("rejects row-bearing payloads that contradict state or sidecar capabilities", () => {
    expect(isReaderApparatusResponse({ ...response, status: "empty" })).toBe(
      false,
    );
    expect(
      isReaderApparatusResponse({
        ...response,
        capabilities: { ...response.capabilities, has_sidecar_items: false },
      }),
    ).toBe(false);
    expect(
      isReaderApparatusResponse({
        ...response,
        items: [],
        edges: [],
      }),
    ).toBe(false);
    expect(
      isReaderApparatusResponse({
        ...response,
        capabilities: { ...response.capabilities, supports_hover_preview: false },
      }),
    ).toBe(false);
  });

  it("rejects duplicate item keys and dangling edges before row construction can collapse them", () => {
    expect(
      isReaderApparatusResponse({
        ...response,
        items: [response.items[0], response.items[0]],
      }),
    ).toBe(false);
    expect(
      isReaderApparatusResponse({
        ...response,
        edges: [
          {
            ...response.edges[0],
            to_stable_key: "missing-target",
          },
        ],
      }),
    ).toBe(false);
  });
});
