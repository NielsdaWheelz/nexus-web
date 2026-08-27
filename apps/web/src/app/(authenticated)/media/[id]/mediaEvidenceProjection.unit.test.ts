import { describe, expect, it } from "vitest";
import type { MediaEvidenceResolution } from "./mediaEvidenceResolution";
import {
  projectMediaEvidenceHighlights,
  projectMediaEvidenceRoute,
} from "./mediaEvidenceProjection";

const MEDIA_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const EVIDENCE_ID = "bbbbbbbb-1111-4111-8111-111111111111";
const FRAGMENT_ID = "cccccccc-1111-4111-8111-111111111111";

const RESOLVED_TRANSCRIPT: MediaEvidenceResolution = {
  evidenceSpanId: EVIDENCE_ID,
  mediaId: MEDIA_ID,
  citationLabel: "00:01",
  spanText: "Exact evidence",
  resolver: {
    kind: "transcript",
    route: `/media/${MEDIA_ID}`,
    params: { evidence: EVIDENCE_ID, t_start_ms: "1000" },
    status: "resolved",
    selector: {
      kind: "transcript_time_text",
      t_start_ms: 1000,
      t_end_ms: 2000,
    },
    highlight: {
      kind: "transcript_time_text",
      evidenceSpanId: EVIDENCE_ID,
      tStartMs: 1000,
      tEndMs: 2000,
      textQuote: { exact: "Exact evidence", prefix: "", suffix: "" },
    },
  },
};

describe("media evidence projection", () => {
  it("projects resolved transcript navigation and presentation together", () => {
    const fragment = {
      id: FRAGMENT_ID,
      canonical_text: "A segment containing Exact evidence.",
      t_start_ms: 900,
      t_end_ms: 2100,
    };

    expect(projectMediaEvidenceRoute(RESOLVED_TRANSCRIPT, [fragment])).toEqual({
      fragmentId: null,
      readerLoc: null,
      startMs: 1000,
      pdfPageNumber: null,
      transcriptFragment: fragment,
      transcriptHighlight: {
        id: `evidence-${EVIDENCE_ID}`,
        exactText: "Exact evidence",
        startMs: 1000,
        endMs: 2000,
      },
    });
  });

  it("does not reconstruct a highlight from an unresolved selector", () => {
    const unresolved: MediaEvidenceResolution = {
      ...RESOLVED_TRANSCRIPT,
      resolver: {
        kind: "transcript",
        route: `/media/${MEDIA_ID}`,
        params: { evidence: EVIDENCE_ID, t_start_ms: "1000" },
        status: "unresolved",
        selector: {
          kind: "transcript_time_text",
          t_start_ms: 1000,
          t_end_ms: 2000,
        },
        highlight: null,
      },
    };

    expect(
      projectMediaEvidenceRoute(unresolved, [
        {
          id: FRAGMENT_ID,
          canonical_text: "Exact evidence",
          t_start_ms: 1000,
          t_end_ms: 2000,
        },
      ]),
    ).toMatchObject({
      startMs: 1000,
      transcriptFragment: null,
      transcriptHighlight: null,
    });
    expect(
      projectMediaEvidenceHighlights(unresolved, {
        fragmentId: FRAGMENT_ID,
        canonicalText: "Exact evidence",
      }),
    ).toEqual({ text: null, pdf: null, pdfPageNumber: null });
  });

  it("projects a typed text highlight and reanchors its exact quote", () => {
    const evidence: MediaEvidenceResolution = {
      evidenceSpanId: EVIDENCE_ID,
      mediaId: MEDIA_ID,
      citationLabel: "Citation",
      spanText: "Exact evidence",
      resolver: {
        kind: "web",
        route: `/media/${MEDIA_ID}`,
        params: { evidence: EVIDENCE_ID, fragment: FRAGMENT_ID },
        status: "resolved",
        selector: { kind: "web_text" },
        highlight: {
          kind: "web_text",
          evidenceSpanId: EVIDENCE_ID,
          fragmentId: FRAGMENT_ID,
          startOffset: 100,
          endOffset: 114,
          textQuote: {
            exact: "Exact evidence",
            prefix: "Before ",
            suffix: " after",
          },
        },
      },
    };

    expect(
      projectMediaEvidenceHighlights(evidence, {
        fragmentId: FRAGMENT_ID,
        canonicalText: "Before Exact evidence after.",
      }).text,
    ).toEqual({
      id: `evidence-${EVIDENCE_ID}`,
      start_offset: 7,
      end_offset: 21,
      color: "blue",
      created_at: "1970-01-01T00:00:00.000Z",
    });
  });

  it("projects only decoder-certified PDF geometry", () => {
    const quad = {
      x1: 1,
      y1: 2,
      x2: 3,
      y2: 4,
      x3: 5,
      y3: 6,
      x4: 7,
      y4: 8,
    };
    const evidence: MediaEvidenceResolution = {
      evidenceSpanId: EVIDENCE_ID,
      mediaId: MEDIA_ID,
      citationLabel: "p. 2",
      spanText: "Exact evidence",
      resolver: {
        kind: "pdf",
        route: `/media/${MEDIA_ID}`,
        params: { evidence: EVIDENCE_ID, page: "2" },
        status: "resolved",
        selector: { kind: "pdf_text" },
        highlight: {
          kind: "pdf_text",
          evidenceSpanId: EVIDENCE_ID,
          pageNumber: 2,
          pageLabel: null,
          textQuote: { exact: "Exact evidence", prefix: "", suffix: "" },
          geometry: {
            coordinateSpace: "pdf_points",
            pageWidth: 612,
            pageHeight: 792,
            pageRotationDegrees: 0,
            pageBox: null,
            projection: null,
            quads: [quad],
          },
        },
      },
    };

    expect(projectMediaEvidenceHighlights(evidence, null)).toEqual({
      text: null,
      pdf: {
        id: `evidence-${EVIDENCE_ID}`,
        pageNumber: 2,
        quads: [quad],
        color: "blue",
      },
      pdfPageNumber: 2,
    });
  });
});
