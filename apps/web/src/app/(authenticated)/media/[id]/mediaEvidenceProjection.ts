import type { PdfHighlightQuad } from "@/lib/highlights/pdfTypes";
import type { HighlightInput } from "@/lib/highlights/applySegments";
import type { TranscriptFragment } from "@/lib/media/transcriptView";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import { findCanonicalOffsetFromQuote } from "@/lib/reader/canonicalQuote";
import type { MediaEvidenceResolution } from "./mediaEvidenceResolution";

interface ActiveEvidenceTextContent {
  fragmentId: string;
  canonicalText: string;
}

interface PdfEvidenceHighlightProjection {
  id: string;
  pageNumber: number;
  quads: PdfHighlightQuad[];
  color: "blue";
}

interface MediaEvidenceRouteProjection {
  fragmentId: string | null;
  readerLoc: string | null;
  startMs: number | null;
  pdfPageNumber: number | null;
  transcriptFragment: TranscriptFragment | null;
  transcriptHighlight: {
    id: string;
    exactText: string | null;
    startMs: number | null;
    endMs: number | null;
  } | null;
}

interface MediaEvidenceHighlightProjection {
  text: HighlightInput | null;
  pdf: PdfEvidenceHighlightProjection | null;
  pdfPageNumber: number | null;
}

function parseNonnegativeIntegerParam(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePositiveIntegerParam(raw: string | undefined): number | null {
  const parsed = parseNonnegativeIntegerParam(raw);
  return parsed !== null && parsed >= 1 ? parsed : null;
}

function normalizedEvidenceText(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return normalized || null;
}

function findTranscriptFragment(
  fragments: readonly TranscriptFragment[],
  startMs: number | null,
  spanText: string,
): TranscriptFragment | null {
  if (startMs !== null) {
    const timeMatched = fragments.find((fragment) => {
      if (typeof fragment.t_start_ms !== "number") return false;
      return typeof fragment.t_end_ms === "number"
        ? startMs >= fragment.t_start_ms && startMs <= fragment.t_end_ms
        : fragment.t_start_ms === startMs;
    });
    if (timeMatched) return timeMatched;
  }
  const exact = normalizedEvidenceText(spanText);
  if (exact === null) return null;
  return (
    fragments.find((fragment) =>
      normalizedEvidenceText(fragment.canonical_text)?.includes(exact),
    ) ?? null
  );
}

export function projectMediaEvidenceRoute(
  evidence: MediaEvidenceResolution | null,
  fragments: readonly TranscriptFragment[],
): MediaEvidenceRouteProjection {
  if (evidence === null) {
    return {
      fragmentId: null,
      readerLoc: null,
      startMs: null,
      pdfPageNumber: null,
      transcriptFragment: null,
      transcriptHighlight: null,
    };
  }
  const { resolver } = evidence;
  const startMs =
    parseNonnegativeIntegerParam(resolver.params.t_start_ms) ??
    (resolver.kind === "transcript"
      ? (resolver.highlight?.tStartMs ?? null)
      : null);
  const transcriptFragment =
    resolver.kind === "transcript" && resolver.highlight !== null
      ? findTranscriptFragment(fragments, startMs, evidence.spanText)
      : null;
  return {
    fragmentId: resolver.params.fragment ?? null,
    readerLoc: resolver.params.loc ?? null,
    startMs,
    pdfPageNumber: parsePositiveIntegerParam(resolver.params.page),
    transcriptFragment,
    transcriptHighlight:
      resolver.kind === "transcript" && resolver.highlight !== null
        ? {
            id: `evidence-${evidence.evidenceSpanId}`,
            exactText: evidence.spanText.trim() || null,
            startMs: resolver.highlight.tStartMs,
            endMs: resolver.highlight.tEndMs,
          }
        : null,
  };
}

function projectTextHighlight(
  evidence: MediaEvidenceResolution,
  activeContent: ActiveEvidenceTextContent | null,
): HighlightInput | null {
  if (activeContent === null) return null;
  const highlight = evidence.resolver.highlight;
  if (
    highlight === null ||
    (highlight.kind !== "web_text" && highlight.kind !== "epub_text") ||
    highlight.fragmentId !== activeContent.fragmentId
  ) {
    return null;
  }
  const matchedOffset = findCanonicalOffsetFromQuote(
    activeContent.canonicalText,
    evidence.spanText,
    highlight.textQuote.prefix || null,
    highlight.textQuote.suffix || null,
  );
  return {
    id: `evidence-${evidence.evidenceSpanId}`,
    start_offset: matchedOffset ?? highlight.startOffset,
    end_offset:
      matchedOffset === null
        ? highlight.endOffset
        : matchedOffset + canonicalCpLength(evidence.spanText),
    color: "blue",
    created_at: "1970-01-01T00:00:00.000Z",
  };
}

export function projectMediaEvidenceHighlights(
  evidence: MediaEvidenceResolution | null,
  activeContent: ActiveEvidenceTextContent | null,
): MediaEvidenceHighlightProjection {
  if (evidence === null) {
    return { text: null, pdf: null, pdfPageNumber: null };
  }
  const highlight = evidence.resolver.highlight;
  if (highlight?.kind !== "pdf_text") {
    return {
      text: projectTextHighlight(evidence, activeContent),
      pdf: null,
      pdfPageNumber: null,
    };
  }
  return {
    text: null,
    pdf:
      highlight.geometry === null
        ? null
        : {
            id: `evidence-${evidence.evidenceSpanId}`,
            pageNumber: highlight.pageNumber,
            quads: highlight.geometry.quads,
            color: "blue",
          },
    pdfPageNumber: highlight.pageNumber,
  };
}
