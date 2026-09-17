import { apiFetch, decodeApiPayload } from "@/lib/api/client";
import {
  expectArray,
  expectCanonicalUuid,
  expectExactRecord,
  expectFiniteNumber,
  expectNonnegativeInteger,
  expectNullableNonnegativeInteger,
  expectNullableString,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

interface MediaEvidenceTextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

interface MediaEvidenceTextHighlightBase {
  evidenceSpanId: string;
  fragmentId: string;
  startOffset: number;
  endOffset: number;
  textQuote: MediaEvidenceTextQuote;
}

interface MediaEvidenceWebHighlight extends MediaEvidenceTextHighlightBase {
  kind: "web_text";
}

interface MediaEvidenceEpubHighlight extends MediaEvidenceTextHighlightBase {
  kind: "epub_text";
}

interface MediaEvidencePdfQuad {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
  x4: number;
  y4: number;
}

interface MediaEvidencePdfGeometry {
  coordinateSpace: "pdf_points";
  pageWidth: number;
  pageHeight: number;
  pageRotationDegrees: number;
  pageBox: string | null;
  projection: string | null;
  quads: MediaEvidencePdfQuad[];
}

interface MediaEvidencePdfHighlight {
  kind: "pdf_text";
  evidenceSpanId: string;
  pageNumber: number;
  pageLabel: string | null;
  textQuote: MediaEvidenceTextQuote;
  geometry: MediaEvidencePdfGeometry | null;
}

interface MediaEvidenceTranscriptHighlight {
  kind: "transcript_time_text";
  evidenceSpanId: string;
  tStartMs: number | null;
  tEndMs: number | null;
  textQuote: MediaEvidenceTextQuote;
}

type MediaEvidenceHighlight =
  | MediaEvidenceWebHighlight
  | MediaEvidenceEpubHighlight
  | MediaEvidencePdfHighlight
  | MediaEvidenceTranscriptHighlight;

type MediaEvidenceResolverState<Highlight> =
  | { status: "resolved"; highlight: Highlight }
  | { status: "unresolved"; highlight: null };

type MediaEvidenceResolver =
  | ({ params: Record<string, string>; kind: "web" } & MediaEvidenceResolverState<MediaEvidenceWebHighlight>)
  | ({ params: Record<string, string>; kind: "epub" } & MediaEvidenceResolverState<MediaEvidenceEpubHighlight>)
  | ({ params: Record<string, string>; kind: "transcript" } & MediaEvidenceResolverState<MediaEvidenceTranscriptHighlight>)
  | ({ params: Record<string, string>; kind: "pdf" } & (
      | {
          status: "resolved";
          highlight: MediaEvidencePdfHighlight & {
            geometry: MediaEvidencePdfGeometry;
          };
        }
      | {
          status: "no_geometry";
          highlight: MediaEvidencePdfHighlight & { geometry: null };
        }
      | { status: "unresolved"; highlight: null }
    ));

export interface MediaEvidenceResolution {
  evidenceSpanId: string;
  mediaId: string;
  spanText: string;
  resolver: MediaEvidenceResolver;
}

export interface MediaEvidenceResolutionResponse {
  data: MediaEvidenceResolution;
}

function decodeTextQuote(raw: unknown): MediaEvidenceTextQuote {
  const quote = expectExactRecord(
    raw,
    ["exact", "prefix", "suffix"],
    "media evidence text_quote",
  );
  return {
    exact: expectString(quote.exact, "media evidence text_quote.exact"),
    prefix: expectString(quote.prefix, "media evidence text_quote.prefix"),
    suffix: expectString(quote.suffix, "media evidence text_quote.suffix"),
  };
}

function decodePdfQuad(raw: unknown, index: number): MediaEvidencePdfQuad {
  const name = `media evidence geometry.quads[${index}]`;
  const quad = expectExactRecord(
    raw,
    ["x1", "y1", "x2", "y2", "x3", "y3", "x4", "y4"],
    name,
  );
  return {
    x1: expectFiniteNumber(quad.x1, `${name}.x1`),
    y1: expectFiniteNumber(quad.y1, `${name}.y1`),
    x2: expectFiniteNumber(quad.x2, `${name}.x2`),
    y2: expectFiniteNumber(quad.y2, `${name}.y2`),
    x3: expectFiniteNumber(quad.x3, `${name}.x3`),
    y3: expectFiniteNumber(quad.y3, `${name}.y3`),
    x4: expectFiniteNumber(quad.x4, `${name}.x4`),
    y4: expectFiniteNumber(quad.y4, `${name}.y4`),
  };
}

function decodePdfGeometry(raw: unknown): MediaEvidencePdfGeometry | null {
  if (raw === null) return null;
  const geometry = expectExactRecord(
    raw,
    [
      "coordinate_space",
      "page_width",
      "page_height",
      "page_rotation_degrees",
      "page_box",
      "projection",
      "quads",
    ],
    "media evidence geometry",
  );
  const pageWidth = expectFiniteNumber(
    geometry.page_width,
    "media evidence geometry.page_width",
  );
  const pageHeight = expectFiniteNumber(
    geometry.page_height,
    "media evidence geometry.page_height",
  );
  if (pageWidth <= 0 || pageHeight <= 0) {
    throw new TypeError("media evidence geometry page dimensions must be positive");
  }
  return {
    coordinateSpace: expectOneOf(
      geometry.coordinate_space,
      ["pdf_points"] as const,
      "media evidence geometry.coordinate_space",
    ),
    pageWidth,
    pageHeight,
    pageRotationDegrees: expectNonnegativeInteger(
      geometry.page_rotation_degrees,
      "media evidence geometry.page_rotation_degrees",
    ),
    pageBox: expectNullableString(
      geometry.page_box,
      "media evidence geometry.page_box",
    ),
    projection: expectNullableString(
      geometry.projection,
      "media evidence geometry.projection",
    ),
    quads: expectArray(geometry.quads, decodePdfQuad, "media evidence geometry.quads"),
  };
}

function decodeHighlight(raw: unknown): MediaEvidenceHighlight | null {
  if (raw === null) return null;
  const record = expectRecord(raw, "media evidence highlight");
  const kind = expectString(record.kind, "media evidence highlight.kind");
  if (kind === "web_text" || kind === "epub_text") {
    const highlight = expectExactRecord(
      raw,
      [
        "kind",
        "evidence_span_id",
        "fragment_id",
        "start_offset",
        "end_offset",
        "text_quote",
      ],
      "media evidence text highlight",
    );
    const startOffset = expectNonnegativeInteger(
      highlight.start_offset,
      "media evidence text highlight.start_offset",
    );
    const endOffset = expectNonnegativeInteger(
      highlight.end_offset,
      "media evidence text highlight.end_offset",
    );
    if (endOffset <= startOffset) {
      throw new TypeError(
        "Media evidence text highlight offsets must form a positive range",
      );
    }
    return {
      kind,
      evidenceSpanId: expectCanonicalUuid(
        highlight.evidence_span_id,
        "media evidence text highlight.evidence_span_id",
      ),
      fragmentId: expectCanonicalUuid(
        highlight.fragment_id,
        "media evidence text highlight.fragment_id",
      ),
      startOffset,
      endOffset,
      textQuote: decodeTextQuote(highlight.text_quote),
    };
  }
  if (kind === "pdf_text") {
    const highlight = expectExactRecord(
      raw,
      [
        "kind",
        "evidence_span_id",
        "page_number",
        "page_label",
        "text_quote",
        "geometry",
      ],
      "media evidence PDF highlight",
    );
    const pageNumber = expectNonnegativeInteger(
      highlight.page_number,
      "media evidence PDF highlight.page_number",
    );
    if (pageNumber < 1) {
      throw new TypeError("media evidence PDF highlight.page_number must be positive");
    }
    return {
      kind,
      evidenceSpanId: expectCanonicalUuid(
        highlight.evidence_span_id,
        "media evidence PDF highlight.evidence_span_id",
      ),
      pageNumber,
      pageLabel: expectNullableString(
        highlight.page_label,
        "media evidence PDF highlight.page_label",
      ),
      textQuote: decodeTextQuote(highlight.text_quote),
      geometry: decodePdfGeometry(highlight.geometry),
    };
  }
  if (kind === "transcript_time_text") {
    const highlight = expectExactRecord(
      raw,
      [
        "kind",
        "evidence_span_id",
        "t_start_ms",
        "t_end_ms",
        "text_quote",
      ],
      "media evidence transcript highlight",
    );
    const tStartMs = expectNullableNonnegativeInteger(
      highlight.t_start_ms,
      "media evidence transcript highlight.t_start_ms",
    );
    const tEndMs = expectNullableNonnegativeInteger(
      highlight.t_end_ms,
      "media evidence transcript highlight.t_end_ms",
    );
    if (tStartMs !== null && tEndMs !== null && tEndMs <= tStartMs) {
      throw new TypeError(
        "Media evidence transcript highlight times must form a positive range",
      );
    }
    return {
      kind,
      evidenceSpanId: expectCanonicalUuid(
        highlight.evidence_span_id,
        "media evidence transcript highlight.evidence_span_id",
      ),
      tStartMs,
      tEndMs,
      textQuote: decodeTextQuote(highlight.text_quote),
    };
  }
  throw new TypeError("media evidence highlight.kind is invalid");
}

function decodeStringRecord(raw: unknown, name: string): Record<string, string> {
  const record = expectRecord(raw, name);
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      expectString(value, `${name}.${key}`),
    ]),
  );
}

function decodeResolver(raw: unknown): MediaEvidenceResolver {
  const resolver = expectExactRecord(
    raw,
    ["kind", "route", "params", "status", "selector", "highlight"],
    "media evidence resolver",
  );
  const kind = expectOneOf(
    resolver.kind,
    ["web", "epub", "pdf", "transcript"] as const,
    "media evidence resolver.kind",
  );
  const status = expectOneOf(
    resolver.status,
    ["resolved", "unresolved", "no_geometry"] as const,
    "media evidence resolver.status",
  );
  const highlight = decodeHighlight(resolver.highlight);
  if (status === "unresolved" && highlight !== null) {
    throw new TypeError(
      "Unresolved media evidence must not contain a highlight",
    );
  }
  if (status !== "unresolved" && highlight === null) {
    throw new TypeError(
      "Resolved media evidence must contain its typed highlight",
    );
  }
  const params = decodeStringRecord(
    resolver.params,
    "media evidence resolver.params",
  );
  if (kind === "web") {
    if (status === "no_geometry") {
      throw new TypeError("Media evidence no_geometry is only valid for PDF");
    }
    if (status === "unresolved") {
      if (highlight !== null) {
        throw new TypeError(
          "Unresolved media evidence must not contain a highlight",
        );
      }
      return { params, kind, status, highlight };
    }
    if (highlight?.kind !== "web_text") {
      throw new TypeError("Web evidence requires a web_text highlight");
    }
    return { params, kind, status, highlight };
  }
  if (kind === "epub") {
    if (status === "no_geometry") {
      throw new TypeError("Media evidence no_geometry is only valid for PDF");
    }
    if (status === "unresolved") {
      if (highlight !== null) {
        throw new TypeError(
          "Unresolved media evidence must not contain a highlight",
        );
      }
      return { params, kind, status, highlight };
    }
    if (highlight?.kind !== "epub_text") {
      throw new TypeError("EPUB evidence requires an epub_text highlight");
    }
    return { params, kind, status, highlight };
  }
  if (kind === "pdf") {
    if (status === "unresolved") {
      if (highlight !== null) {
        throw new TypeError(
          "Unresolved media evidence must not contain a highlight",
        );
      }
      return { params, kind, status, highlight };
    }
    if (highlight?.kind !== "pdf_text") {
      throw new TypeError("PDF evidence requires a pdf_text highlight");
    }
    if (status === "no_geometry") {
      if (highlight.geometry !== null) {
        throw new TypeError(
          "Media evidence no_geometry requires a PDF highlight without geometry",
        );
      }
      return {
        params,
        kind,
        status,
        highlight: { ...highlight, geometry: null },
      };
    }
    const geometry = highlight.geometry;
    if (geometry === null) {
      throw new TypeError(
        "Resolved PDF evidence must contain highlight geometry",
      );
    }
    if (geometry.quads.length === 0) {
      throw new TypeError(
        "Resolved PDF evidence must contain highlight geometry quads",
      );
    }
    return {
      params,
      kind,
      status,
      highlight: { ...highlight, geometry },
    };
  }
  if (status === "no_geometry") {
    throw new TypeError("Media evidence no_geometry is only valid for PDF");
  }
  if (status === "unresolved") {
    if (highlight !== null) {
      throw new TypeError(
        "Unresolved media evidence must not contain a highlight",
      );
    }
    return { params, kind, status, highlight };
  }
  if (highlight?.kind !== "transcript_time_text") {
    throw new TypeError(
      "Transcript evidence requires a transcript_time_text highlight",
    );
  }
  return { params, kind, status, highlight };
}

function decodeMediaEvidenceResolutionResponse(
  raw: unknown,
): MediaEvidenceResolutionResponse {
  const envelope = expectExactRecord(raw, ["data"], "media evidence response");
  const data = expectExactRecord(
    envelope.data,
    ["evidence_span_id", "media_id", "citation_label", "span_text", "resolver"],
    "media evidence response.data",
  );
  const response: MediaEvidenceResolutionResponse = {
    data: {
      evidenceSpanId: expectCanonicalUuid(
        data.evidence_span_id,
        "media evidence response.data.evidence_span_id",
      ),
      mediaId: expectCanonicalUuid(
        data.media_id,
        "media evidence response.data.media_id",
      ),
      spanText: expectString(
        data.span_text,
        "media evidence response.data.span_text",
      ),
      resolver: decodeResolver(data.resolver),
    },
  };
  const highlight = response.data.resolver.highlight;
  if (
    highlight !== null &&
    highlight.evidenceSpanId !== response.data.evidenceSpanId
  ) {
    throw new TypeError(
      "Media evidence highlight identity must match its response",
    );
  }
  if (
    highlight !== null &&
    highlight.textQuote.exact !== response.data.spanText
  ) {
    throw new TypeError(
      "Media evidence highlight text must match its response span",
    );
  }
  return response;
}

export async function fetchMediaEvidenceResolution(
  mediaId: string,
  evidenceId: string,
  signal: AbortSignal,
): Promise<MediaEvidenceResolutionResponse> {
  const raw = await apiFetch<unknown>(
    `/api/media/${encodeURIComponent(mediaId)}/evidence/${encodeURIComponent(evidenceId)}`,
    { signal },
  );
  return decodeApiPayload(
    raw,
    (body) => {
      const response = decodeMediaEvidenceResolutionResponse(body);
      if (
        response.data.mediaId !== mediaId ||
        response.data.evidenceSpanId !== evidenceId
      ) {
        throw new TypeError(
          "Media evidence response identity must match its request",
        );
      }
      return response;
    },
    "Media evidence",
  );
}
