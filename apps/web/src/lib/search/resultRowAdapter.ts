export const ALL_SEARCH_TYPES = [
  "media",
  "fragment",
  "annotation",
  "message",
  "transcript_chunk",
] as const;

export type SearchType = (typeof ALL_SEARCH_TYPES)[number];

export interface SearchSourceMetadata {
  media_id: string;
  media_kind: string;
  title: string;
  authors: string[];
  published_date: string | null;
}

export interface SearchHighlightContext {
  exact: string;
  prefix: string;
  suffix: string;
}

interface SearchBaseResult {
  id: string;
  score: number;
  snippet: string;
}

export interface SearchMediaResult extends SearchBaseResult {
  type: "media";
  source: SearchSourceMetadata;
}

export interface SearchFragmentResult extends SearchBaseResult {
  type: "fragment";
  fragment_idx: number;
  source: SearchSourceMetadata;
}

export interface SearchAnnotationResult extends SearchBaseResult {
  type: "annotation";
  highlight_id: string;
  fragment_id: string;
  fragment_idx: number;
  annotation_body: string;
  highlight: SearchHighlightContext;
  source: SearchSourceMetadata;
}

export interface SearchMessageResult extends SearchBaseResult {
  type: "message";
  conversation_id: string;
  seq: number;
}

export interface SearchTranscriptChunkResult extends SearchBaseResult {
  type: "transcript_chunk";
  t_start_ms: number;
  t_end_ms: number;
  source: SearchSourceMetadata;
}

export type SearchApiResult =
  | SearchMediaResult
  | SearchFragmentResult
  | SearchAnnotationResult
  | SearchMessageResult
  | SearchTranscriptChunkResult;

/** Result types that carry source metadata. */
export type SearchResultWithSource =
  | SearchMediaResult
  | SearchFragmentResult
  | SearchAnnotationResult
  | SearchTranscriptChunkResult;

export interface SearchResponseShape {
  results: SearchApiResult[];
  page: {
    has_more: boolean;
    next_cursor: string | null;
  };
}

export interface SnippetSegment {
  text: string;
  emphasized: boolean;
}

export interface SearchResultRowViewModel {
  key: string;
  href: string;
  type: SearchType;
  typeLabel: string;
  primaryText: string;
  snippetSegments: SnippetSegment[];
  sourceMeta: string | null;
  annotationBody: string | null;
  highlightSnippet: {
    prefix: string;
    exact: string;
    suffix: string;
  } | null;
  scoreLabel: string;
}

// ---------------------------------------------------------------------------
// Runtime validation & normalization – Layer 1
//
// Contract is strict: result rows must use canonical nested source metadata.
// Legacy flat shapes are intentionally rejected after cutover.
// ---------------------------------------------------------------------------

/** Runtime check that a source object has the required shape. */
function isValidSource(value: unknown): value is SearchSourceMetadata {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.media_id === "string" &&
    typeof s.media_kind === "string" &&
    typeof s.title === "string" &&
    Array.isArray(s.authors)
  );
}

/**
 * Resolve nested source metadata from canonical `source` field.
 */
function resolveSource(r: Record<string, unknown>): SearchSourceMetadata | null {
  if (isValidSource(r.source)) {
    return r.source as SearchSourceMetadata;
  }
  return null;
}

/** Runtime check that a highlight object has the required shape. */
function isValidHighlight(value: unknown): value is SearchHighlightContext {
  if (typeof value !== "object" || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h.exact === "string" &&
    typeof h.prefix === "string" &&
    typeof h.suffix === "string"
  );
}

/**
 * Normalize a raw API result object into the canonical SearchApiResult type.
 *
 * Returns null for any result that violates the canonical nested contract.
 */
export function normalizeSearchResult(
  result: unknown,
): SearchApiResult | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;

  // Common required fields
  if (typeof r.id !== "string") return null;
  if (typeof r.score !== "number") return null;
  if (typeof r.snippet !== "string") return null;

  const base = { id: r.id, score: r.score, snippet: r.snippet };

  switch (r.type) {
    case "media": {
      const source = resolveSource(r);
      if (!source) return null;
      return { ...base, type: "media", source };
    }
    case "fragment": {
      const source = resolveSource(r);
      if (!source) return null;
      if (typeof r.fragment_idx !== "number") return null;
      const fragment_idx = r.fragment_idx;
      return { ...base, type: "fragment", fragment_idx, source };
    }
    case "annotation": {
      const source = resolveSource(r);
      if (!source) return null;
      if (typeof r.fragment_idx !== "number") return null;
      const fragment_idx = r.fragment_idx;
      if (
        typeof r.highlight_id !== "string" ||
        typeof r.fragment_id !== "string" ||
        typeof r.annotation_body !== "string" ||
        !isValidHighlight(r.highlight)
      )
        return null;
      return {
        ...base,
        type: "annotation",
        highlight_id: r.highlight_id,
        fragment_id: r.fragment_id,
        fragment_idx,
        annotation_body: r.annotation_body,
        highlight: r.highlight,
        source,
      };
    }
    case "message": {
      if (
        typeof r.conversation_id !== "string" ||
        typeof r.seq !== "number"
      )
        return null;
      return {
        ...base,
        type: "message",
        conversation_id: r.conversation_id,
        seq: r.seq,
      };
    }
    case "transcript_chunk": {
      const source = resolveSource(r);
      if (!source) return null;
      if (
        typeof r.t_start_ms !== "number" ||
        typeof r.t_end_ms !== "number"
      ) {
        return null;
      }
      return {
        ...base,
        type: "transcript_chunk",
        t_start_ms: r.t_start_ms,
        t_end_ms: r.t_end_ms,
        source,
      };
    }
    default:
      return null;
  }
}

/**
 * Runtime validation for a single search result.
 *
 * Returns true if the result matches the canonical nested SearchApiResult shape.
 */
export function isValidSearchResult(
  result: unknown,
): result is SearchApiResult {
  return normalizeSearchResult(result) !== null;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

interface BuildSearchQueryParamsInput {
  query: string;
  selectedTypes: Set<SearchType>;
  limit: number;
  cursor?: string | null;
}

function sanitizeSnippet(snippet: string | null | undefined): string {
  if (!snippet) return "";
  return snippet.replace(/<\/?b>/gi, "");
}

function parseSnippetSegments(snippet: string): SnippetSegment[] {
  if (!snippet) return [];

  const segments: SnippetSegment[] = [];
  const parts = snippet.split(/(<\/?b>)/gi);
  let emphasized = false;

  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === "<b>") {
      emphasized = true;
      continue;
    }
    if (normalized === "</b>") {
      emphasized = false;
      continue;
    }
    if (!part) {
      continue;
    }
    segments.push({ text: part, emphasized });
  }

  return segments;
}

function formatMediaKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

function buildSourceMeta(result: SearchApiResult): string | null {
  if (result.type === "message") {
    return `message #${result.seq}`;
  }

  // After eliminating "message", TS narrows to SearchResultWithSource —
  // all remaining variants carry `source: SearchSourceMetadata`.
  const { source } = result;

  const parts: string[] = [];
  if (source.title) {
    parts.push(source.title);
  }
  if (source.authors.length > 0) {
    parts.push(source.authors.join(", "));
  }
  if (source.published_date) {
    parts.push(source.published_date);
  }
  if (source.media_kind) {
    parts.push(formatMediaKind(source.media_kind));
  }

  return parts.length > 0 ? parts.join(" — ") : null;
}

function buildResultHref(result: SearchApiResult): string {
  switch (result.type) {
    case "media":
      return `/media/${result.id}`;
    case "fragment": {
      const params = new URLSearchParams();
      params.set("fragment", result.id);
      if (result.source.media_kind === "epub") {
        params.set("chapter", String(result.fragment_idx));
      }
      const query = params.toString();
      return query
        ? `/media/${result.source.media_id}?${query}`
        : `/media/${result.source.media_id}`;
    }
    case "annotation": {
      const params = new URLSearchParams();
      params.set("fragment", result.fragment_id);
      if (result.source.media_kind === "epub") {
        params.set("chapter", String(result.fragment_idx));
      }
      params.set("highlight", result.highlight_id);
      const query = params.toString();
      return query
        ? `/media/${result.source.media_id}?${query}`
        : `/media/${result.source.media_id}`;
    }
    case "message":
      return `/conversations/${result.conversation_id}`;
    case "transcript_chunk": {
      const params = new URLSearchParams();
      params.set("t_start_ms", String(result.t_start_ms));
      return `/media/${result.source.media_id}?${params.toString()}`;
    }
  }
}

function buildPrimaryText(result: SearchApiResult): string {
  if (result.type === "annotation") {
    return result.highlight.exact;
  }
  if (result.type === "media") {
    return result.source.title || sanitizeSnippet(result.snippet) || "Untitled";
  }
  if (result.type === "message") {
    return sanitizeSnippet(result.snippet) || `Message #${result.seq}`;
  }
  return sanitizeSnippet(result.snippet);
}

function formatTypeLabel(type: SearchType): string {
  return type === "transcript_chunk" ? "transcript chunk" : type;
}

export function buildSearchQueryParams({
  query,
  selectedTypes,
  limit,
  cursor = null,
}: BuildSearchQueryParamsInput): URLSearchParams {
  const params = new URLSearchParams({
    q: query.trim(),
    limit: String(limit),
  });

  const orderedSelected = ALL_SEARCH_TYPES.filter((type) => selectedTypes.has(type));
  if (orderedSelected.length === 0) {
    // Explicitly differentiate from omitted types (which means "all").
    params.set("types", "");
  } else {
    params.set("types", orderedSelected.join(","));
  }
  if (orderedSelected.includes("transcript_chunk")) {
    params.set("semantic", "true");
  }

  if (cursor) {
    params.set("cursor", cursor);
  }

  return params;
}

export function adaptSearchResultRow(result: SearchApiResult): SearchResultRowViewModel {
  const highlightSnippet =
    result.type === "annotation"
      ? {
          prefix: result.highlight.prefix,
          exact: result.highlight.exact,
          suffix: result.highlight.suffix,
        }
      : null;

  return {
    key: `${result.type}-${result.id}`,
    href: buildResultHref(result),
    type: result.type,
    typeLabel: formatTypeLabel(result.type),
    primaryText: buildPrimaryText(result),
    snippetSegments: parseSnippetSegments(result.snippet),
    sourceMeta: buildSourceMeta(result),
    annotationBody: result.type === "annotation" ? result.annotation_body : null,
    highlightSnippet,
    scoreLabel: `score ${result.score.toFixed(2)}`,
  };
}
