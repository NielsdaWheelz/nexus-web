export const ALL_SEARCH_TYPES = [
  "media",
  "fragment",
  "annotation",
  "message",
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

export type SearchApiResult =
  | SearchMediaResult
  | SearchFragmentResult
  | SearchAnnotationResult
  | SearchMessageResult;

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

  const parts: string[] = [];
  if ("source" in result) {
    parts.push(result.source.title);
    if (result.source.authors.length > 0) {
      parts.push(result.source.authors.join(", "));
    }
    if (result.source.published_date) {
      parts.push(result.source.published_date);
    }
    parts.push(formatMediaKind(result.source.media_kind));
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
  }

  const exhaustive: never = result;
  throw new Error(`Unsupported search result type: ${String(exhaustive)}`);
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
  } else if (orderedSelected.length < ALL_SEARCH_TYPES.length) {
    params.set("types", orderedSelected.join(","));
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
    typeLabel: result.type,
    primaryText: buildPrimaryText(result),
    snippetSegments: parseSnippetSegments(result.snippet),
    sourceMeta: buildSourceMeta(result),
    annotationBody: result.type === "annotation" ? result.annotation_body : null,
    highlightSnippet,
    scoreLabel: `score ${result.score.toFixed(2)}`,
  };
}
