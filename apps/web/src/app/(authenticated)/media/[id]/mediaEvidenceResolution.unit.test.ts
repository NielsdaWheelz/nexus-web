import { describe, expect, it } from "vitest";
import { decodeMediaEvidenceResolutionResponse } from "./mediaEvidenceResolution";

const MEDIA_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const EVIDENCE_ID = "bbbbbbbb-1111-4111-8111-111111111111";

const TRANSCRIPT_RESPONSE = {
  data: {
    evidence_span_id: EVIDENCE_ID,
    media_id: MEDIA_ID,
    citation_label: "00:01",
    span_text: "Exact evidence",
    resolver: {
      kind: "transcript",
      route: `/media/${MEDIA_ID}`,
      params: { t_start_ms: "1000", t_end_ms: "2000" },
      status: "resolved",
      selector: { kind: "transcript_time_text", t_start_ms: 1000 },
      highlight: {
        kind: "transcript_time_text",
        evidence_span_id: EVIDENCE_ID,
        t_start_ms: 1000,
        t_end_ms: 2000,
        text_quote: {
          exact: "Exact evidence",
          prefix: "",
          suffix: "",
        },
      },
    },
  },
};

describe("media evidence resolution wire", () => {
  it("decodes EPUB evidence through its exact fragment address", () => {
    const fragmentId = "cccccccc-1111-4111-8111-111111111111";
    const response = {
      data: {
        ...TRANSCRIPT_RESPONSE.data,
        resolver: {
          kind: "epub",
          route: `/media/${MEDIA_ID}`,
          params: { fragment: fragmentId },
          status: "resolved",
          selector: { kind: "epub_text", fragment_id: fragmentId },
          highlight: {
            kind: "epub_text",
            evidence_span_id: EVIDENCE_ID,
            fragment_id: fragmentId,
            start_offset: 7,
            end_offset: 21,
            text_quote: { exact: "Exact evidence", prefix: "Before ", suffix: " after" },
          },
        },
      },
    };
    expect(
      () => decodeMediaEvidenceResolutionResponse(response),
      "EPUB evidence must decode its exact fragment address",
    ).not.toThrow();
    expect(decodeMediaEvidenceResolutionResponse(response).data.resolver.highlight).toEqual({
      kind: "epub_text",
      evidenceSpanId: EVIDENCE_ID,
      fragmentId,
      startOffset: 7,
      endOffset: 21,
      textQuote: { exact: "Exact evidence", prefix: "Before ", suffix: " after" },
    });
    expect(() => decodeMediaEvidenceResolutionResponse({
      data: {
        ...response.data,
        resolver: {
          ...response.data.resolver,
          highlight: { ...response.data.resolver.highlight, section_id: "old-section" },
        },
      },
    })).toThrow("media evidence text highlight must contain exactly");
  });

  it("decodes the complete exact envelope into domain names", () => {
    expect(decodeMediaEvidenceResolutionResponse(TRANSCRIPT_RESPONSE)).toEqual({
      data: {
        evidenceSpanId: EVIDENCE_ID,
        mediaId: MEDIA_ID,
        citationLabel: "00:01",
        spanText: "Exact evidence",
        resolver: {
          kind: "transcript",
          route: `/media/${MEDIA_ID}`,
          params: { t_start_ms: "1000", t_end_ms: "2000" },
          status: "resolved",
          selector: { kind: "transcript_time_text", t_start_ms: 1000 },
          highlight: {
            kind: "transcript_time_text",
            evidenceSpanId: EVIDENCE_ID,
            tStartMs: 1000,
            tEndMs: 2000,
            textQuote: {
              exact: "Exact evidence",
              prefix: "",
              suffix: "",
            },
          },
        },
      },
    });
  });

  it("rejects incomplete, extra, and malformed nested contracts", () => {
    expect(() =>
      decodeMediaEvidenceResolutionResponse({
        ...TRANSCRIPT_RESPONSE,
        extra: true,
      }),
    ).toThrow("media evidence response must contain exactly");
    expect(() =>
      decodeMediaEvidenceResolutionResponse({
        data: {
          ...TRANSCRIPT_RESPONSE.data,
          resolver: {
            ...TRANSCRIPT_RESPONSE.data.resolver,
            route: undefined,
          },
        },
      }),
    ).toThrow("media evidence resolver.route must be a string");
    expect(() =>
      decodeMediaEvidenceResolutionResponse({
        data: {
          ...TRANSCRIPT_RESPONSE.data,
          resolver: {
            ...TRANSCRIPT_RESPONSE.data.resolver,
            highlight: {
              ...TRANSCRIPT_RESPONSE.data.resolver.highlight,
              t_start_ms: -1,
            },
          },
        },
      }),
    ).toThrow("must be nonnegative or null");
    expect(() =>
      decodeMediaEvidenceResolutionResponse({
        data: {
          ...TRANSCRIPT_RESPONSE.data,
          resolver: {
            ...TRANSCRIPT_RESPONSE.data.resolver,
            highlight: {
              ...TRANSCRIPT_RESPONSE.data.resolver.highlight,
              evidence_span_id: MEDIA_ID,
            },
          },
        },
      }),
    ).toThrow("highlight identity must match its response");
  });

  it("rejects contradictory resolver kind, state, and span identity", () => {
    expect(() =>
      decodeMediaEvidenceResolutionResponse({
        data: {
          ...TRANSCRIPT_RESPONSE.data,
          resolver: {
            ...TRANSCRIPT_RESPONSE.data.resolver,
            kind: "web",
          },
        },
      }),
    ).toThrow("Web evidence requires a web_text highlight");
    expect(() =>
      decodeMediaEvidenceResolutionResponse({
        data: {
          ...TRANSCRIPT_RESPONSE.data,
          resolver: {
            ...TRANSCRIPT_RESPONSE.data.resolver,
            status: "unresolved",
          },
        },
      }),
    ).toThrow("Unresolved media evidence must not contain a highlight");
    expect(() =>
      decodeMediaEvidenceResolutionResponse({
        data: {
          ...TRANSCRIPT_RESPONSE.data,
          resolver: {
            ...TRANSCRIPT_RESPONSE.data.resolver,
            highlight: null,
          },
        },
      }),
    ).toThrow("Resolved media evidence must contain its typed highlight");
    expect(() =>
      decodeMediaEvidenceResolutionResponse({
        data: {
          ...TRANSCRIPT_RESPONSE.data,
          span_text: "Different evidence",
        },
      }),
    ).toThrow("highlight text must match its response span");
  });

  it("strictly decodes PDF geometry", () => {
    const pdfResponse = {
      data: {
        ...TRANSCRIPT_RESPONSE.data,
        resolver: {
          kind: "pdf",
          route: `/media/${MEDIA_ID}`,
          params: { page: "2" },
          status: "resolved",
          selector: { kind: "pdf_text", page_number: 2 },
          highlight: {
            kind: "pdf_text",
            evidence_span_id: EVIDENCE_ID,
            page_number: 2,
            page_label: null,
            text_quote: {
              exact: "Exact evidence",
              prefix: "",
              suffix: "",
            },
            geometry: {
              coordinate_space: "pdf_points",
              page_width: 612,
              page_height: 792,
              page_rotation_degrees: 0,
              page_box: null,
              projection: null,
              quads: [
                {
                  x1: 1,
                  y1: 2,
                  x2: 3,
                  y2: 4,
                  x3: 5,
                  y3: 6,
                  x4: 7,
                  y4: 8,
                },
              ],
            },
          },
        },
      },
    };
    const decoded = decodeMediaEvidenceResolutionResponse(pdfResponse);
    expect(decoded.data.resolver.highlight).toMatchObject({
      kind: "pdf_text",
      pageNumber: 2,
      geometry: {
        coordinateSpace: "pdf_points",
        pageWidth: 612,
        pageHeight: 792,
      },
    });
    expect(() =>
      decodeMediaEvidenceResolutionResponse({
        data: {
          ...pdfResponse.data,
          resolver: {
            ...pdfResponse.data.resolver,
            highlight: {
              ...pdfResponse.data.resolver.highlight,
              geometry: {
                ...pdfResponse.data.resolver.highlight.geometry,
                page_width: 0,
              },
            },
          },
        },
      }),
    ).toThrow("page dimensions must be positive");
    expect(() =>
      decodeMediaEvidenceResolutionResponse({
        data: {
          ...pdfResponse.data,
          resolver: {
            ...pdfResponse.data.resolver,
            highlight: {
              ...pdfResponse.data.resolver.highlight,
              geometry: null,
            },
          },
        },
      }),
    ).toThrow("Resolved PDF evidence must contain highlight geometry");
  });
});
