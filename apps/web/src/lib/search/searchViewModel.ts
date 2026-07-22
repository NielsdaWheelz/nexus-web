import type { ContributorCredit } from "@/lib/contributors/types";
import { absent, type Presence } from "@/lib/api/presence";
import {
  decodeOptionalPublicationDate,
  type PublicationDate,
} from "@/lib/dates/publicationDate";
import { hrefForResourceActivation } from "@/lib/resources/activation";
import { normalizeSearchResult } from "./normalizeSearchResult";
import type { SearchApiResult, SearchResultRowViewModel } from "./types";

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
    // Author rows carry no status/kind after the cutover; the "author" type label
    // is the only meta signal a contributor row needs.
    return null;
  }

  if (result.type === "message") {
    return result.source_label ?? `message #${result.seq}`;
  }

  if (result.type === "conversation") {
    return result.source_label ?? "conversation";
  }

  if (result.type === "artifact") {
    return result.source_label ?? "distillate";
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
    return "note";
  }

  if (result.type === "highlight") {
    return result.source_label ?? "highlight";
  }

  if (result.type === "fragment") {
    return result.source_label ?? "fragment";
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
  if (result.source.media_kind) {
    parts.push(result.source.media_kind.replace(/_/g, " "));
  }

  return parts.filter(Boolean).join(" — ") || null;
}

function publicationDateFor(
  result: SearchApiResult,
): Presence<PublicationDate> {
  if (result.type === "web_result") {
    return decodeOptionalPublicationDate(
      result.published_at,
      "search web_result published_at",
    );
  }
  if (!("source" in result)) return absent();
  return decodeOptionalPublicationDate(
    result.source.published_date,
    `search ${result.type} source.published_date`,
  );
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
    return result.title || sanitizeSnippet(result.snippet) || "Distillate";
  }
  if (result.type === "evidence_span") {
    return sanitizeSnippet(result.snippet) || result.citation_label;
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
  if (result.type === "evidence_span" || result.type === "reader_apparatus_item") {
    return result.source.contributors;
  }
  if (result.type === "highlight") {
    return result.source.contributors;
  }
  return [];
}

export function adaptSearchResultRow(
  result: SearchApiResult,
): SearchResultRowViewModel {
  const primaryText = buildPrimaryText(result);
  const href = hrefForResourceActivation(result.activation);
  if (!href) {
    throw new Error("Search result missing activation href");
  }

  return {
    key: `${result.type}-${result.id}`,
    resourceRef: result.resource_ref,
    activation: result.activation,
    citationTarget: result.citation_target,
    paneLabelHint: primaryText,
    type: result.type,
    mediaId: result.media_id,
    contextRef: {
      type: result.context_ref.type,
      id: result.context_ref.id,
      evidenceSpanIds: result.context_ref.evidence_span_ids ?? [],
      locator: result.context_ref.locator ?? undefined,
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
              ? "distillate"
            : result.type === "web_result"
              ? "web result"
            : result.type,
    primaryText,
    snippetSegments: parseSnippetSegments(result.snippet),
    sourceMeta: buildSourceMeta(result),
    publicationDate: publicationDateFor(result),
    contributorCredits: getContributorCredits(result),
    noteBody: result.type === "note_block" ? result.body_text : null,
  };
}

export function adaptSearchResults(results: unknown[]): SearchResultRowViewModel[] {
  return results.map((result) => {
    const normalized = normalizeSearchResult(result);
    if (!normalized) {
      throw new Error("Search API returned an invalid result row");
    }
    return adaptSearchResultRow(normalized);
  });
}
