import { apiFetch } from "@/lib/api/client";

export const ALL_SEARCH_TYPES = [
  "media",
  "fragment",
  "annotation",
  "message",
  "transcript_chunk",
] as const;

export type SearchType = (typeof ALL_SEARCH_TYPES)[number];

interface SearchSourceMetadata {
  media_id: string;
  media_kind: string;
  title: string;
  authors: string[];
  published_date: string | null;
}

interface SearchHighlightContext {
  exact: string;
  prefix: string;
  suffix: string;
}

interface SearchBaseResult {
  id: string;
  score: number;
  snippet: string;
}

interface SearchMediaResult extends SearchBaseResult {
  type: "media";
  source: SearchSourceMetadata;
}

interface SearchFragmentResult extends SearchBaseResult {
  type: "fragment";
  fragment_idx: number;
  section_id: string | null;
  source: SearchSourceMetadata;
}

interface SearchAnnotationResult extends SearchBaseResult {
  type: "annotation";
  highlight_id: string;
  fragment_id: string;
  fragment_idx: number;
  section_id: string | null;
  annotation_body: string;
  highlight: SearchHighlightContext;
  source: SearchSourceMetadata;
}

interface SearchMessageResult extends SearchBaseResult {
  type: "message";
  conversation_id: string;
  seq: number;
}

interface SearchTranscriptChunkResult extends SearchBaseResult {
  type: "transcript_chunk";
  t_start_ms: number;
  t_end_ms: number;
  source: SearchSourceMetadata;
}

type SearchApiResult =
  | SearchMediaResult
  | SearchFragmentResult
  | SearchAnnotationResult
  | SearchMessageResult
  | SearchTranscriptChunkResult;

interface SearchResponseShape {
  results: unknown[];
  page?: {
    next_cursor?: string | null;
  } | null;
}

export interface SearchResultRowViewModel {
  key: string;
  href: string;
  type: SearchType;
  typeLabel: string;
  primaryText: string;
  snippetSegments: Array<{
    text: string;
    emphasized: boolean;
  }>;
  sourceMeta: string | null;
  annotationBody: string | null;
  highlightSnippet: {
    prefix: string;
    exact: string;
    suffix: string;
  } | null;
  scoreLabel: string;
}

interface FetchSearchResultPageInput {
  query: string;
  selectedTypes: ReadonlySet<SearchType>;
  limit: number;
  cursor?: string | null;
}

export interface SearchResultPage {
  rows: SearchResultRowViewModel[];
  nextCursor: string | null;
}

function isValidSource(value: unknown): value is SearchSourceMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const source = value as Record<string, unknown>;
  return (
    typeof source.media_id === "string" &&
    typeof source.media_kind === "string" &&
    typeof source.title === "string" &&
    Array.isArray(source.authors)
  );
}

function resolveSource(result: Record<string, unknown>): SearchSourceMetadata | null {
  if (!isValidSource(result.source)) {
    return null;
  }
  return result.source;
}

function isValidHighlight(value: unknown): value is SearchHighlightContext {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const highlight = value as Record<string, unknown>;
  return (
    typeof highlight.exact === "string" &&
    typeof highlight.prefix === "string" &&
    typeof highlight.suffix === "string"
  );
}

function normalizeSearchResult(result: unknown): SearchApiResult | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }

  const row = result as Record<string, unknown>;
  if (typeof row.id !== "string") {
    return null;
  }
  if (typeof row.score !== "number") {
    return null;
  }
  if (typeof row.snippet !== "string") {
    return null;
  }

  const base = {
    id: row.id,
    score: row.score,
    snippet: row.snippet,
  };

  switch (row.type) {
    case "media": {
      const source = resolveSource(row);
      if (!source) {
        return null;
      }
      return { ...base, type: "media", source };
    }
    case "fragment": {
      const source = resolveSource(row);
      if (!source || typeof row.fragment_idx !== "number") {
        return null;
      }

      const sectionId =
        typeof row.section_id === "string" && row.section_id.length > 0
          ? row.section_id
          : null;
      if (source.media_kind === "epub" && sectionId === null) {
        return null;
      }

      return {
        ...base,
        type: "fragment",
        fragment_idx: row.fragment_idx,
        section_id: sectionId,
        source,
      };
    }
    case "annotation": {
      const source = resolveSource(row);
      if (!source || typeof row.fragment_idx !== "number") {
        return null;
      }

      const sectionId =
        typeof row.section_id === "string" && row.section_id.length > 0
          ? row.section_id
          : null;
      if (
        typeof row.highlight_id !== "string" ||
        typeof row.fragment_id !== "string" ||
        typeof row.annotation_body !== "string" ||
        !isValidHighlight(row.highlight) ||
        (source.media_kind === "epub" && sectionId === null)
      ) {
        return null;
      }

      return {
        ...base,
        type: "annotation",
        highlight_id: row.highlight_id,
        fragment_id: row.fragment_id,
        fragment_idx: row.fragment_idx,
        section_id: sectionId,
        annotation_body: row.annotation_body,
        highlight: row.highlight,
        source,
      };
    }
    case "message":
      if (
        typeof row.conversation_id !== "string" ||
        typeof row.seq !== "number"
      ) {
        return null;
      }

      return {
        ...base,
        type: "message",
        conversation_id: row.conversation_id,
        seq: row.seq,
      };
    case "transcript_chunk": {
      const source = resolveSource(row);
      if (
        !source ||
        typeof row.t_start_ms !== "number" ||
        typeof row.t_end_ms !== "number"
      ) {
        return null;
      }

      return {
        ...base,
        type: "transcript_chunk",
        t_start_ms: row.t_start_ms,
        t_end_ms: row.t_end_ms,
        source,
      };
    }
    default:
      return null;
  }
}

function buildSearchQueryParams({
  query,
  selectedTypes,
  limit,
  cursor = null,
}: FetchSearchResultPageInput): URLSearchParams {
  const params = new URLSearchParams({
    q: query.trim(),
    limit: String(limit),
  });

  const orderedSelectedTypes = ALL_SEARCH_TYPES.filter((type) =>
    selectedTypes.has(type)
  );
  if (orderedSelectedTypes.length === 0) {
    params.set("types", "");
  } else {
    params.set("types", orderedSelectedTypes.join(","));
  }
  if (orderedSelectedTypes.includes("transcript_chunk")) {
    params.set("semantic", "true");
  }
  if (cursor) {
    params.set("cursor", cursor);
  }

  return params;
}

function sanitizeSnippet(snippet: string): string {
  return snippet.replace(/<\/?b>/gi, "");
}

function parseSnippetSegments(snippet: string) {
  if (!snippet) {
    return [];
  }

  const segments: SearchResultRowViewModel["snippetSegments"] = [];
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

function buildSourceMeta(result: SearchApiResult): string | null {
  if (result.type === "message") {
    return `message #${result.seq}`;
  }

  const parts = [result.source.title];
  if (result.source.authors.length > 0) {
    parts.push(result.source.authors.join(", "));
  }
  if (result.source.published_date) {
    parts.push(result.source.published_date);
  }
  if (result.source.media_kind) {
    parts.push(result.source.media_kind.replace(/_/g, " "));
  }

  return parts.filter(Boolean).join(" — ") || null;
}

function buildResultHref(result: SearchApiResult): string {
  switch (result.type) {
    case "media":
      return `/media/${result.id}`;
    case "fragment": {
      const params = new URLSearchParams();
      if (result.source.media_kind === "epub") {
        params.set("loc", result.section_id ?? "");
      }
      params.set("fragment", result.id);
      return `/media/${result.source.media_id}?${params.toString()}`;
    }
    case "annotation": {
      const params = new URLSearchParams();
      if (result.source.media_kind === "epub") {
        params.set("loc", result.section_id ?? "");
      }
      params.set("fragment", result.fragment_id);
      params.set("highlight", result.highlight_id);
      return `/media/${result.source.media_id}?${params.toString()}`;
    }
    case "message":
      return `/conversations/${result.conversation_id}`;
    case "transcript_chunk": {
      const params = new URLSearchParams({
        t_start_ms: String(result.t_start_ms),
      });
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

function adaptSearchResultRow(result: SearchApiResult): SearchResultRowViewModel {
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
    typeLabel: result.type === "transcript_chunk" ? "transcript chunk" : result.type,
    primaryText: buildPrimaryText(result),
    snippetSegments: parseSnippetSegments(result.snippet),
    sourceMeta: buildSourceMeta(result),
    annotationBody: result.type === "annotation" ? result.annotation_body : null,
    highlightSnippet,
    scoreLabel: `score ${result.score.toFixed(2)}`,
  };
}

function adaptSearchResults(results: unknown[]): SearchResultRowViewModel[] {
  return results.flatMap((result) => {
    const normalized = normalizeSearchResult(result);
    if (!normalized) {
      console.warn("[search] dropping invalid result", result);
      return [];
    }
    return [adaptSearchResultRow(normalized)];
  });
}

export async function fetchSearchResultPage({
  query,
  selectedTypes,
  limit,
  cursor = null,
}: FetchSearchResultPageInput): Promise<SearchResultPage> {
  const response = await apiFetch<SearchResponseShape>(
    `/api/search?${buildSearchQueryParams({
      query,
      selectedTypes,
      limit,
      cursor,
    }).toString()}`
  );

  return {
    rows: adaptSearchResults(Array.isArray(response.results) ? response.results : []),
    nextCursor:
      typeof response.page?.next_cursor === "string"
        ? response.page.next_cursor
        : null,
  };
}
