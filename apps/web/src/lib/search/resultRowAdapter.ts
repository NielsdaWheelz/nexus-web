import { apiFetch } from "@/lib/api/client";
import type { ContributorCredit } from "@/lib/contributors/types";
import { normalizeSearchResult } from "./normalizeSearchResult";
import {
  ALL_SEARCH_TYPES,
  type FetchSearchResultPageInput,
  type SearchApiResult,
  type SearchResponseShape,
  type SearchResultPage,
  type SearchResultRowViewModel,
} from "./types";

function buildSearchQueryParams({
  query,
  selectedTypes,
  contributorHandles = [],
  roles = [],
  contentKinds = [],
  limit,
  cursor = null,
}: FetchSearchResultPageInput): URLSearchParams {
  const params = new URLSearchParams({
    q: query.trim(),
    limit: String(limit),
  });

  const orderedSelectedTypes = ALL_SEARCH_TYPES.filter((type) =>
    selectedTypes.has(type),
  );
  if (orderedSelectedTypes.length === 0) {
    params.set("types", "");
  } else {
    params.set("types", orderedSelectedTypes.join(","));
  }
  if (cursor) {
    params.set("cursor", cursor);
  }
  const handles = contributorHandles
    .map((handle) => handle.trim())
    .filter(Boolean);
  if (handles.length > 0) {
    params.set("contributor_handles", handles.join(","));
  }
  const normalizedRoles = roles.map((role) => role.trim()).filter(Boolean);
  if (normalizedRoles.length > 0) {
    params.set("roles", normalizedRoles.join(","));
  }
  const normalizedContentKinds = contentKinds
    .map((contentKind) => contentKind.trim())
    .filter(Boolean);
  if (normalizedContentKinds.length > 0) {
    params.set("content_kinds", normalizedContentKinds.join(","));
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
  if (result.type === "contributor") {
    return result.contributor.status;
  }

  if (result.type === "message") {
    return result.source_label ?? `message #${result.seq}`;
  }

  if (result.type === "conversation") {
    return result.source_label ?? "conversation";
  }

  if (result.type === "artifact") {
    return result.source_label ?? result.artifact_kind;
  }

  if (result.type === "evidence_span") {
    return result.source_label ?? result.citation_label;
  }

  if (result.type === "podcast") {
    return result.source_label;
  }

  if (result.type === "page") {
    return result.source_label;
  }

  if (result.type === "note_block") {
    return result.page_title;
  }

  if (result.type === "highlight") {
    return result.source_label ?? "highlight";
  }

  if (result.type === "fragment") {
    return result.source_label ?? "fragment";
  }

  if (result.type === "artifact_part") {
    return result.source_label ?? result.artifact_kind;
  }

  if (result.type === "web_result") {
    return result.source_name ?? result.display_url ?? result.source_label ?? "web";
  }

  if (result.source_label) {
    return result.source_label;
  }

  if (result.type === "content_chunk") {
    const parts = [result.title, result.media_kind.replace(/_/g, " ")];
    return parts.filter(Boolean).join(" — ") || null;
  }

  const parts = [result.source.title];
  if (result.source.published_date) {
    parts.push(result.source.published_date);
  }
  if (result.source.media_kind) {
    parts.push(result.source.media_kind.replace(/_/g, " "));
  }

  return parts.filter(Boolean).join(" — ") || null;
}

function buildPrimaryText(result: SearchApiResult): string {
  if (result.type === "contributor") {
    return (
      result.contributor.display_name ||
      sanitizeSnippet(result.snippet) ||
      "Author"
    );
  }
  if (result.type === "note_block") {
    if (result.highlight_excerpt) return result.highlight_excerpt;
    return result.body_text || sanitizeSnippet(result.snippet) || "Note";
  }
  if (
    result.type === "media" ||
    result.type === "podcast" ||
    result.type === "episode" ||
    result.type === "video"
  ) {
    return result.title || sanitizeSnippet(result.snippet) || "Untitled";
  }
  if (result.type === "page") {
    return result.title || sanitizeSnippet(result.snippet) || "Untitled page";
  }
  if (result.type === "highlight") {
    return result.exact || sanitizeSnippet(result.snippet) || "Highlight";
  }
  if (result.type === "fragment") {
    return sanitizeSnippet(result.snippet) || "Fragment";
  }
  if (result.type === "message") {
    return sanitizeSnippet(result.snippet) || `Message #${result.seq}`;
  }
  if (result.type === "conversation") {
    return result.title || sanitizeSnippet(result.snippet) || "Conversation";
  }
  if (result.type === "artifact") {
    return result.title || sanitizeSnippet(result.snippet) || result.artifact_kind;
  }
  if (result.type === "evidence_span") {
    return sanitizeSnippet(result.snippet) || result.citation_label;
  }
  if (result.type === "artifact_part") {
    return sanitizeSnippet(result.snippet) || result.artifact_title || result.artifact_kind;
  }
  if (result.type === "web_result") {
    return result.title || sanitizeSnippet(result.snippet) || result.url;
  }
  return sanitizeSnippet(result.snippet);
}

function getContributorCredits(result: SearchApiResult): ContributorCredit[] {
  if (result.type === "media" || result.type === "episode" || result.type === "video") {
    return result.source.contributors;
  }
  if (result.type === "podcast") {
    return result.contributors;
  }
  if (result.type === "content_chunk" || result.type === "fragment") {
    return result.source.contributors;
  }
  if (result.type === "evidence_span") {
    return result.source.contributors;
  }
  if (result.type === "highlight") {
    return result.source.contributors;
  }
  return [];
}

function adaptSearchResultRow(
  result: SearchApiResult,
): SearchResultRowViewModel {
  return {
    key: `${result.type}-${result.id}`,
    href: result.deep_link,
    type: result.type,
    mediaId: result.media_id,
    contextRef: {
      type: result.context_ref.type,
      id: result.context_ref.id,
      evidenceSpanIds: result.context_ref.evidence_span_ids ?? [],
      artifactId: result.context_ref.artifact_id ?? undefined,
      artifactKey: result.context_ref.artifact_key,
      artifactVersion: result.context_ref.artifact_version,
      sourceVersion: result.context_ref.source_version ?? undefined,
      locator: result.context_ref.locator ?? undefined,
      artifactPartProvenance: result.context_ref.artifact_part_provenance ?? undefined,
    },
    typeLabel:
      result.type === "content_chunk"
        ? result.citation_label
        : result.type === "episode"
          ? "episode"
        : result.type === "contributor"
          ? "author"
          : result.type === "page"
            ? "page"
            : result.type === "evidence_span"
              ? result.citation_label
            : result.type === "conversation"
              ? "conversation"
            : result.type === "artifact"
              ? "artifact"
            : result.type === "artifact_part"
              ? "artifact"
            : result.type === "web_result"
              ? "web result"
            : result.type,
    primaryText: buildPrimaryText(result),
    snippetSegments: parseSnippetSegments(result.snippet),
    sourceMeta: buildSourceMeta(result),
    contributorCredits: getContributorCredits(result),
    noteBody: result.type === "note_block" ? result.body_text : null,
    scoreLabel: `score ${result.score.toFixed(2)}`,
  };
}

function adaptSearchResults(results: unknown[]): SearchResultRowViewModel[] {
  return results.map((result) => {
    const normalized = normalizeSearchResult(result);
    if (!normalized) {
      throw new Error("Search API returned an invalid result row");
    }
    return adaptSearchResultRow(normalized);
  });
}

function requireSearchResults(results: unknown): unknown[] {
  if (!Array.isArray(results)) {
    throw new Error("Search API response is missing results");
  }
  return results;
}

export async function fetchSearchResultPage({
  query,
  selectedTypes,
  contributorHandles = [],
  roles = [],
  contentKinds = [],
  limit,
  cursor = null,
  signal,
}: FetchSearchResultPageInput): Promise<SearchResultPage> {
  const response = await apiFetch<SearchResponseShape>(
    `/api/search?${buildSearchQueryParams({
      query,
      selectedTypes,
      contributorHandles,
      roles,
      contentKinds,
      limit,
      cursor,
    }).toString()}`,
    { signal },
  );

  return {
    rows: adaptSearchResults(requireSearchResults(response.results)),
    nextCursor:
      typeof response.page?.next_cursor === "string"
        ? response.page.next_cursor
        : null,
  };
}
