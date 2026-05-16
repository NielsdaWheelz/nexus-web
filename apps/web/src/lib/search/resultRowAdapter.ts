import { apiFetch } from "@/lib/api/client";
import { isRetrievalLocator, type RetrievalLocator } from "@/lib/api/sse";
import type { ContributorCredit } from "@/lib/contributors/types";

export const ALL_SEARCH_TYPES = [
  "contributor",
  "media",
  "podcast",
  "episode",
  "video",
  "content_chunk",
  "fragment",
  "page",
  "note_block",
  "highlight",
  "message",
  "evidence_span",
  "conversation",
  "artifact",
  "artifact_part",
  "web_result",
] as const;

export type SearchType = (typeof ALL_SEARCH_TYPES)[number];

interface SearchSourceMetadata {
  media_id: string;
  media_kind: string;
  title: string;
  contributors: ContributorCredit[];
  published_date: string | null;
}

interface SearchBaseResult {
  id: string;
  score: number;
  snippet: string;
  title: string;
  source_label: string | null;
  media_id: string | null;
  media_kind: string | null;
  deep_link: string;
  context_ref: {
    type: SearchType;
    id: string;
    evidence_span_ids?: string[];
  };
}

interface SearchMediaResult extends SearchBaseResult {
  type: "media" | "episode" | "video";
  source: SearchSourceMetadata;
}

interface SearchPodcastResult extends SearchBaseResult {
  type: "podcast";
  contributors: ContributorCredit[];
}

interface SearchContributorResult extends SearchBaseResult {
  type: "contributor";
  contributor_handle: string;
  contributor: {
    handle: string;
    display_name: string;
    status: string | null;
  };
}

interface SearchContentChunkResult extends SearchBaseResult {
  type: "content_chunk";
  media_id: string;
  media_kind: string;
  source_version: string;
  citation_label: string;
  source: SearchSourceMetadata;
  locator: RetrievalLocator;
}

interface SearchFragmentResult extends SearchBaseResult {
  type: "fragment";
  source_version: string;
  citation_label: string | null;
  locator: RetrievalLocator;
  source: SearchSourceMetadata;
}

interface SearchNoteBlockResult extends SearchBaseResult {
  type: "note_block";
  page_id: string;
  page_title: string;
  body_text: string;
  highlight_excerpt: string | null;
  source_version: string;
  locator: RetrievalLocator;
}

interface SearchHighlightResult extends SearchBaseResult {
  type: "highlight";
  color: string;
  exact: string;
  source_version: string;
  citation_label: string | null;
  locator: RetrievalLocator;
  source: SearchSourceMetadata;
}

interface SearchPageResult extends SearchBaseResult {
  type: "page";
  description: string | null;
  source_version: string;
}

interface SearchMessageResult extends SearchBaseResult {
  type: "message";
  conversation_id: string;
  seq: number;
  source_version: string;
  locator: RetrievalLocator;
}

interface SearchEvidenceSpanResult extends SearchBaseResult {
  type: "evidence_span";
  evidence_span_id: string;
  source_version: string;
  citation_label: string;
  locator: RetrievalLocator;
  source: SearchSourceMetadata;
}

interface SearchConversationResult extends SearchBaseResult {
  type: "conversation";
}

interface SearchArtifactResult extends SearchBaseResult {
  type: "artifact";
  conversation_id: string;
  message_id: string;
  artifact_kind: string;
}

interface SearchArtifactPartResult extends SearchBaseResult {
  type: "artifact_part";
  artifact_id: string;
  message_id: string;
  conversation_id: string;
  artifact_kind: string;
  artifact_title: string | null;
  part_key: string | null;
  part_type: string | null;
  source_version: string;
  locator: RetrievalLocator;
}

interface SearchWebResult extends SearchBaseResult {
  type: "web_result";
  result_type: "web_result";
  source_id: string;
  result_ref: string;
  url: string;
  display_url: string | null;
  extra_snippets: string[];
  published_at: string | null;
  source_name: string | null;
  rank: number | null;
  provider: string | null;
  source_version: string;
  locator: Extract<RetrievalLocator, { type: "external_url" }>;
  selected: boolean;
}

type SearchApiResult =
  | SearchMediaResult
  | SearchPodcastResult
  | SearchContributorResult
  | SearchContentChunkResult
  | SearchFragmentResult
  | SearchPageResult
  | SearchNoteBlockResult
  | SearchHighlightResult
  | SearchMessageResult
  | SearchEvidenceSpanResult
  | SearchConversationResult
  | SearchArtifactResult
  | SearchArtifactPartResult
  | SearchWebResult;

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
  mediaId: string | null;
  contextRef: {
    type: SearchType;
    id: string;
    evidenceSpanIds: string[];
  } | null;
  typeLabel: string;
  primaryText: string;
  snippetSegments: Array<{
    text: string;
    emphasized: boolean;
  }>;
  sourceMeta: string | null;
  contributorCredits: ContributorCredit[];
  noteBody: string | null;
  scoreLabel: string;
}

interface FetchSearchResultPageInput {
  query: string;
  selectedTypes: ReadonlySet<SearchType>;
  contributorHandles?: readonly string[];
  roles?: readonly string[];
  contentKinds?: readonly string[];
  limit: number;
  cursor?: string | null;
  signal?: AbortSignal;
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
    Array.isArray(source.contributors)
  );
}

function resolveSource(
  result: Record<string, unknown>,
): SearchSourceMetadata | null {
  if (!isValidSource(result.source)) {
    return null;
  }
  return result.source;
}

function stringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function nullableStringField(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  const value = stringField(record, ...keys);
  return value || null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function locatorMatchesSearchType(
  type: SearchType,
  locator: RetrievalLocator,
): boolean {
  if (
    type === "content_chunk" ||
    type === "fragment" ||
    type === "highlight" ||
    type === "evidence_span"
  ) {
    return (
      locator.type === "web_text_offsets" ||
      locator.type === "epub_fragment_offsets" ||
      locator.type === "pdf_page_geometry" ||
      locator.type === "transcript_time_range" ||
      locator.type === "audio_time_range" ||
      locator.type === "video_time_range"
    );
  }
  if (type === "note_block") return locator.type === "note_block_offsets";
  if (type === "message") return locator.type === "message_offsets";
  if (type === "artifact_part") return locator.type === "artifact_part_ref";
  if (type === "web_result") return locator.type === "external_url";
  return false;
}

function normalizeContributorCredit(value: unknown): ContributorCredit | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const credit = value as Record<string, unknown>;
  const sourceRef = credit.source_ref ?? credit.sourceRef;
  const contributorHandle = stringField(
    credit,
    "contributor_handle",
    "contributorHandle",
  );
  const contributorDisplayName = stringField(
    credit,
    "contributor_display_name",
    "contributorDisplayName",
  );
  const creditedName = stringField(credit, "credited_name", "creditedName");
  const role = stringField(credit, "role");
  const href = stringField(credit, "href");
  const source = stringField(credit, "source");
  let nestedDisplayName = "";
  if (typeof credit.contributor === "object" && credit.contributor !== null) {
    const contributor = credit.contributor as Record<string, unknown>;
    nestedDisplayName = stringField(contributor, "display_name", "displayName");
  }
  const displayName = contributorDisplayName || nestedDisplayName;
  if (
    !contributorHandle ||
    !displayName ||
    !creditedName ||
    !role ||
    !href ||
    !source
  ) {
    return null;
  }
  return {
    contributor_handle: contributorHandle,
    contributor_display_name: displayName,
    credited_name: creditedName,
    role,
    raw_role: nullableStringField(credit, "raw_role", "rawRole"),
    ordinal: typeof credit.ordinal === "number" ? credit.ordinal : null,
    source,
    source_ref: isPlainRecord(sourceRef) ? sourceRef : null,
    confidence:
      typeof credit.confidence === "string" ||
      typeof credit.confidence === "number"
        ? credit.confidence
        : null,
    href,
  };
}

function normalizeContributorCredits(
  value: unknown,
): ContributorCredit[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const credits: ContributorCredit[] = [];
  for (const item of value) {
    const credit = normalizeContributorCredit(item);
    if (!credit) {
      return null;
    }
    credits.push(credit);
  }
  return credits;
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
  if (typeof row.title !== "string") {
    return null;
  }
  if (typeof row.deep_link !== "string") {
    return null;
  }
  if (typeof row.context_ref !== "object" || row.context_ref === null) {
    return null;
  }
  const contextRef = row.context_ref as Record<string, unknown>;
  if (
    typeof contextRef.type !== "string" ||
    !ALL_SEARCH_TYPES.includes(contextRef.type as SearchType) ||
    typeof contextRef.id !== "string"
  ) {
    return null;
  }
  let evidenceSpanIds: string[] | undefined;
  if (contextRef.evidence_span_ids !== undefined) {
    if (
      !Array.isArray(contextRef.evidence_span_ids) ||
      !contextRef.evidence_span_ids.every((id) => typeof id === "string")
    ) {
      return null;
    }
    evidenceSpanIds = contextRef.evidence_span_ids;
  }

  const base = {
    id: row.id,
    score: row.score,
    snippet: row.snippet,
    title: row.title,
    source_label:
      typeof row.source_label === "string" ? row.source_label : null,
    media_id: typeof row.media_id === "string" ? row.media_id : null,
    media_kind: typeof row.media_kind === "string" ? row.media_kind : null,
    deep_link: row.deep_link,
    context_ref: {
      type: contextRef.type as SearchType,
      id: contextRef.id,
      ...(evidenceSpanIds ? { evidence_span_ids: evidenceSpanIds } : {}),
    },
  };

  switch (row.type) {
    case "media": {
      if (base.context_ref.type !== row.type) {
        return null;
      }
      const source = resolveSource(row);
      if (!source) {
        return null;
      }
      const contributors = normalizeContributorCredits(source.contributors);
      if (!contributors) {
        return null;
      }
      return {
        ...base,
        type: "media",
        source: {
          ...source,
          contributors,
        },
      };
    }
    case "episode":
    case "video": {
      if (base.context_ref.type !== "media") {
        return null;
      }
      const source = resolveSource(row);
      if (!source) {
        return null;
      }
      const contributors = normalizeContributorCredits(source.contributors);
      if (!contributors) {
        return null;
      }
      return {
        ...base,
        type: row.type,
        source: {
          ...source,
          contributors,
        },
      };
    }
    case "podcast": {
      const contributors = normalizeContributorCredits(row.contributors);
      if (!contributors) {
        return null;
      }
      return {
        ...base,
        type: "podcast",
        contributors,
      };
    }
    case "contributor": {
      const contributor = row.contributor as Record<string, unknown> | null;
      const contributorHandle = stringField(
        row,
        "contributor_handle",
        "contributorHandle",
      );
      if (
        !contributorHandle ||
        typeof contributor !== "object" ||
        contributor === null ||
        typeof contributor.handle !== "string" ||
        !stringField(contributor, "display_name", "displayName") ||
        base.context_ref.type !== "contributor"
      ) {
        return null;
      }
      return {
        ...base,
        type: "contributor",
        contributor_handle: contributorHandle,
        contributor: {
          handle: contributor.handle,
          display_name: stringField(contributor, "display_name", "displayName"),
          status: nullableStringField(contributor, "status"),
        },
      };
    }
    case "content_chunk": {
      if (
        typeof row.media_id !== "string" ||
        typeof row.media_kind !== "string" ||
        typeof row.source_version !== "string" ||
        typeof row.citation_label !== "string" ||
        base.context_ref.type !== "content_chunk" ||
        !base.context_ref.evidence_span_ids ||
        base.context_ref.evidence_span_ids.length === 0 ||
        !isValidSource(row.source) ||
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("content_chunk", row.locator)
      ) {
        return null;
      }
      const contributors = normalizeContributorCredits(row.source.contributors);
      if (!contributors) {
        return null;
      }

      return {
        ...base,
        type: "content_chunk",
        media_id: row.media_id,
        media_kind: row.media_kind,
        source_version: row.source_version,
        citation_label: row.citation_label,
        source: {
          ...row.source,
          contributors,
        },
        locator: row.locator,
      };
    }
    case "fragment": {
      if (
        typeof row.source_version !== "string" ||
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("fragment", row.locator) ||
        !isValidSource(row.source) ||
        base.context_ref.type !== "fragment"
      ) {
        return null;
      }
      const contributors = normalizeContributorCredits(row.source.contributors);
      if (!contributors) {
        return null;
      }
      return {
        ...base,
        type: "fragment",
        source_version: row.source_version,
        citation_label:
          typeof row.citation_label === "string" ? row.citation_label : null,
        locator: row.locator,
        source: {
          ...row.source,
          contributors,
        },
      };
    }
    case "page":
      if (typeof row.source_version !== "string") {
        return null;
      }
      return {
        ...base,
        type: "page",
        description:
          typeof row.description === "string" ? row.description : null,
        source_version: row.source_version,
      };
    case "note_block":
      if (
        typeof row.page_id !== "string" ||
        typeof row.page_title !== "string" ||
        typeof row.body_text !== "string" ||
        typeof row.source_version !== "string" ||
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("note_block", row.locator)
      ) {
        return null;
      }
      return {
        ...base,
        type: "note_block",
        page_id: row.page_id,
        page_title: row.page_title,
        body_text: row.body_text,
        highlight_excerpt:
          typeof row.highlight_excerpt === "string" ? row.highlight_excerpt : null,
        source_version: row.source_version,
        locator: row.locator,
      };
    case "highlight": {
      if (
        typeof row.color !== "string" ||
        typeof row.exact !== "string" ||
        typeof row.source_version !== "string" ||
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("highlight", row.locator) ||
        !isValidSource(row.source)
      ) {
        return null;
      }
      const contributors = normalizeContributorCredits(row.source.contributors);
      if (!contributors) {
        return null;
      }
      return {
        ...base,
        type: "highlight",
        color: row.color,
        exact: row.exact,
        source_version: row.source_version,
        citation_label:
          typeof row.citation_label === "string" ? row.citation_label : null,
        locator: row.locator,
        source: {
          ...row.source,
          contributors,
        },
      };
    }
    case "message":
      if (
        typeof row.conversation_id !== "string" ||
        typeof row.seq !== "number" ||
        typeof row.source_version !== "string" ||
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("message", row.locator)
      ) {
        return null;
      }

      return {
        ...base,
        type: "message",
        conversation_id: row.conversation_id,
        seq: row.seq,
        source_version: row.source_version,
        locator: row.locator,
      };
    case "evidence_span": {
      if (
        typeof row.evidence_span_id !== "string" ||
        typeof row.source_version !== "string" ||
        typeof row.citation_label !== "string" ||
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("evidence_span", row.locator) ||
        !isValidSource(row.source) ||
        base.context_ref.type !== "evidence_span"
      ) {
        return null;
      }
      const contributors = normalizeContributorCredits(row.source.contributors);
      if (!contributors) {
        return null;
      }
      return {
        ...base,
        type: "evidence_span",
        evidence_span_id: row.evidence_span_id,
        source_version: row.source_version,
        citation_label: row.citation_label,
        locator: row.locator,
        source: {
          ...row.source,
          contributors,
        },
      };
    }
    case "conversation":
      if (base.context_ref.type !== "conversation") {
        return null;
      }
      return {
        ...base,
        type: "conversation",
      };
    case "artifact":
      if (
        typeof row.conversation_id !== "string" ||
        typeof row.message_id !== "string" ||
        typeof row.artifact_kind !== "string" ||
        base.context_ref.type !== "artifact"
      ) {
        return null;
      }
      return {
        ...base,
        type: "artifact",
        conversation_id: row.conversation_id,
        message_id: row.message_id,
        artifact_kind: row.artifact_kind,
      };
    case "artifact_part":
      if (
        typeof row.artifact_id !== "string" ||
        typeof row.message_id !== "string" ||
        typeof row.conversation_id !== "string" ||
        typeof row.artifact_kind !== "string" ||
        typeof row.source_version !== "string" ||
        !isRetrievalLocator(row.locator) ||
        !locatorMatchesSearchType("artifact_part", row.locator) ||
        base.context_ref.type !== "artifact_part"
      ) {
        return null;
      }
      return {
        ...base,
        type: "artifact_part",
        artifact_id: row.artifact_id,
        message_id: row.message_id,
        conversation_id: row.conversation_id,
        artifact_kind: row.artifact_kind,
        artifact_title:
          typeof row.artifact_title === "string" ? row.artifact_title : null,
        part_key: typeof row.part_key === "string" ? row.part_key : null,
        part_type: typeof row.part_type === "string" ? row.part_type : null,
        source_version: row.source_version,
        locator: row.locator,
      };
    case "web_result":
      if (
        base.context_ref.type !== "web_result" ||
        row.result_type !== "web_result" ||
        typeof row.source_id !== "string" ||
        typeof row.result_ref !== "string" ||
        typeof row.url !== "string" ||
        typeof row.source_version !== "string" ||
        !isRetrievalLocator(row.locator) ||
        row.locator.type !== "external_url" ||
        !Array.isArray(row.extra_snippets) ||
        !row.extra_snippets.every((snippet) => typeof snippet === "string") ||
        typeof row.selected !== "boolean"
      ) {
        return null;
      }
      return {
        ...base,
        type: "web_result",
        result_type: "web_result",
        source_id: row.source_id,
        result_ref: row.result_ref,
        url: row.url,
        display_url:
          typeof row.display_url === "string" ? row.display_url : null,
        extra_snippets: row.extra_snippets,
        published_at:
          typeof row.published_at === "string" ? row.published_at : null,
        source_name:
          typeof row.source_name === "string" ? row.source_name : null,
        rank: typeof row.rank === "number" ? row.rank : null,
        provider: typeof row.provider === "string" ? row.provider : null,
        source_version: row.source_version,
        locator: row.locator,
        selected: row.selected,
      };
    default:
      return null;
  }
}

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

function buildResultHref(result: SearchApiResult): string {
  return result.deep_link;
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
    href: buildResultHref(result),
    type: result.type,
    mediaId: result.media_id,
    contextRef: {
      type: result.context_ref.type,
      id: result.context_ref.id,
      evidenceSpanIds: result.context_ref.evidence_span_ids ?? [],
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

function requireSearchResults(results: unknown): unknown[] {
  if (!Array.isArray(results)) {
    throw new Error("Search API response is missing results");
  }
  return results;
}
