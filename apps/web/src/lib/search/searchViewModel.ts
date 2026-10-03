import type { EmphasisSegment } from "@/lib/ui/emphasis";
import { absent, present, type Presence } from "@/lib/api/presence";
import type { ApiJson } from "@/lib/api/wire";
import {
  decodeOptionalPublicationDate,
  decodePublicationDateOnly,
  type PublicationDate,
} from "@/lib/dates/publicationDate";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { mediaSummaryFromWire } from "@/lib/media/mediaSummary";
import type { SearchResultRowViewModel, SearchType } from "./types";

type SearchResult = ApiJson<"/search", "get">["results"][number];
type NonMediaSearchResult = Exclude<SearchResult, { mediaSummary: unknown }>;

function sanitizeSnippet(snippet: string): string {
  return snippet.replace(/<\/?b>/gi, "");
}

export function parseSnippetSegments(snippet: string): EmphasisSegment[] {
  if (!snippet) {
    return [];
  }

  const segments: EmphasisSegment[] = [];
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

function buildSourceMeta(result: NonMediaSearchResult): string | null {
  if (result.type === "contributor") {
    // the author label supplies this row's metadata.
    return null;
  }

  if (result.type === "message") {
    return result.source_label ?? `message #${result.seq}`;
  }

  if (result.type === "conversation") {
    return result.source_label ?? "conversation";
  }

  if (result.type === "artifact") {
    return result.source_label ?? "artifact";
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
    return (
      result.source_name ?? result.display_url ?? result.source_label ?? "web"
    );
  }

  if (result.type === "content_chunk") {
    if (result.media_id === null || result.media_kind === null) {
      // justify-defect: a chunk must identify its source media, unlike other titled rows.
      throw new Error("Search chunk has no media identity");
    }
    return result.source_label ||
      [result.title, result.media_kind.replace(/_/g, " ")].filter(Boolean).join(" — ") || null;
  }
  if (result.source_label) return result.source_label;

  const parts = [result.source.title];
  if (result.source.media_kind) {
    parts.push(result.source.media_kind.replace(/_/g, " "));
  }

  return parts.filter(Boolean).join(" — ") || null;
}

function publicationDateFor(
  result: NonMediaSearchResult,
): Presence<PublicationDate> {
  if (result.type === "web_result") {
    return decodeOptionalPublicationDate(
      result.published_at,
      "search web_result published_at",
    );
  }
  if (!("source" in result)) return absent();
  const date = result.source.original_published_date;
  return date.kind === "Absent"
    ? date
    : present(
        decodePublicationDateOnly(date.value, "Search source.original_published_date"),
      );
}

function buildPrimaryText(result: NonMediaSearchResult): string {
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
  if (result.type === "podcast") {
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
    return result.title || sanitizeSnippet(result.snippet) || "Dossier";
  }
  if (result.type === "evidence_span") {
    return sanitizeSnippet(result.snippet) || result.citation_label;
  }
  if (result.type === "web_result") {
    return result.title || sanitizeSnippet(result.snippet) || result.url;
  }
  return sanitizeSnippet(result.snippet);
}

const TYPE_LABELS: Partial<Record<SearchType, string>> = {
  contributor: "author",
  page: "page",
  conversation: "conversation",
  artifact: "artifact",
  web_result: "web result",
};

function adaptSearchResultRow(result: SearchResult): SearchResultRowViewModel {
  const activation = result.activation;
  if (
    parseResourceRef(activation.resource_ref) === null ||
    activation.kind === "none" ||
    !activation.href
  ) {
    // justify-defect: search only emits canonical, activatable occurrences.
    throw new Error("Search result missing canonical activation");
  }
  const context = result.context_ref;
  if (
    ("mediaSummary" in result && context.type !== "media") ||
    ([
      "contributor", "content_chunk", "fragment", "evidence_span",
      "reader_apparatus_item", "conversation", "artifact", "web_result",
    ].includes(result.type) && context.type !== result.type) ||
    (result.type === "content_chunk" &&
      (!context.evidence_span_ids || context.evidence_span_ids.length === 0)) ||
    (result.type === "note_block" &&
      ((result.note_origin === "highlight_note") !== (result.highlight_excerpt !== null))) ||
    (result.type === "web_result" && context.id !== result.source_id)
  ) {
    // justify-defect: occurrence context and variant-specific identities must agree.
    throw new Error("Search result identity is inconsistent");
  }
  if (
    result.type === "contributor" &&
    (!result.contributor_handle || !result.contributor.display_name)
  ) {
    // justify-defect: contributor search identities and their display names are nonempty.
    throw new Error("Search contributor identity is empty");
  }
  if (result.type === "artifact") {
    const ref = parseResourceRef(result.resource_ref);
    if (ref?.scheme !== "artifact_revision" || ref.id !== result.revision_id) {
      // justify-defect: a dossier occurrence names the exact revision it carries.
      throw new Error("Search artifact revision is inconsistent");
    }
  }
  const base = {
    key: `${result.type}-${result.id}`,
    score: result.score,
    resourceRef: result.resource_ref,
    ownerResourceRef: result.owner_resource_ref,
    activation,
    actionSubject: { ref: assumeCanonicalResourceRef(result.actionSubjectRef) },
    snippetSegments: parseSnippetSegments(result.snippet),
  };
  if ("mediaSummary" in result) {
    const summary = result.mediaSummary;
    if (
      summary.mediaId !== result.id ||
      ((result.type === "episode") !== (summary.mediaKind === "podcast_episode")) ||
      ((result.type === "video") !== (summary.mediaKind === "video"))
    ) {
      // justify-defect: the summary and result tag must name the same media and kind.
      throw new Error("Search media identity is inconsistent");
    }
    const mediaSummary = mediaSummaryFromWire(summary);
    return { ...base, type: result.type, mediaSummary };
  }
  const primaryText = buildPrimaryText(result);
  return {
    ...base,
    type: result.type,
    paneLabelHint: primaryText,
    typeLabel:
      result.type === "content_chunk" || result.type === "evidence_span"
        ? result.citation_label
        : (TYPE_LABELS[result.type] ?? result.type),
    primaryText,
    sourceMeta: buildSourceMeta(result),
    publicationDate: publicationDateFor(result),
    contributorCredits: "source" in result
      ? result.source.contributors
      : result.type === "podcast" ? result.contributors : [],
  };
}

export function adaptSearchResults(
  results: SearchResult[],
): SearchResultRowViewModel[] {
  return results.map(adaptSearchResultRow);
}
