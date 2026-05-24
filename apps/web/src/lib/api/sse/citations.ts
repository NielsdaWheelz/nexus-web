import { isRecord } from "@/lib/validation";
import { hasOnlyKeys, isOptionalString } from "./guards";
import {
  isMediaRetrievalLocator,
  isRetrievalLocator,
  type MediaRetrievalLocator,
  type RetrievalLocator,
} from "./locators";

export type SearchCitationResultType =
  | "media"
  | "podcast"
  | "episode"
  | "video"
  | "content_chunk"
  | "fragment"
  | "page"
  | "note_block"
  | "highlight"
  | "message"
  | "contributor"
  | "evidence_span"
  | "conversation"
  | "artifact"
  | "artifact_part";

export type RetrievalContextRef =
  | {
      type: SearchCitationResultType;
      id: string;
      evidence_span_ids?: string[];
    }
  | {
      type: "web_result";
      id: string;
      evidence_span_ids?: string[];
    };

const SEARCH_CITATION_RESULT_TYPES = new Set<SearchCitationResultType>([
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
  "contributor",
  "evidence_span",
  "conversation",
  "artifact",
  "artifact_part",
]);

export function isRetrievalContextRef(
  value: unknown,
): value is RetrievalContextRef {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, ["type", "id", "evidence_span_ids"]) ||
    typeof value.type !== "string" ||
    typeof value.id !== "string"
  ) {
    return false;
  }
  if (
    !SEARCH_CITATION_RESULT_TYPES.has(value.type as SearchCitationResultType) &&
    value.type !== "web_result"
  ) {
    return false;
  }
  return (
    value.evidence_span_ids === undefined ||
    (Array.isArray(value.evidence_span_ids) &&
      value.evidence_span_ids.every((id) => typeof id === "string"))
  );
}

type SearchCitationBase<
  TType extends SearchCitationResultType,
  TContextType extends RetrievalContextRef["type"],
  TSourceVersion extends string | null,
  TLocator extends RetrievalLocator | null,
> = {
  type: TType;
  id: string;
  result_type: TType;
  source_id: string;
  title: string;
  source_label: string | null;
  snippet: string;
  deep_link: string;
  citation_label?: string | null;
  context_ref: {
    type: TContextType;
    id: string;
    evidence_span_ids?: string[];
  };
  evidence_span_id?: string | null;
  source_version: TSourceVersion;
  locator: TLocator;
  media_id: string | null;
  media_kind: string | null;
  score: number | null;
  selected: boolean;
};

export type MediaSearchCitationEventData = SearchCitationBase<
  "media",
  "media",
  null,
  null
>;

export type PodcastSearchCitationEventData = SearchCitationBase<
  "podcast",
  "podcast",
  null,
  null
> & {
  contributors: Array<Record<string, unknown>>;
};

export type EpisodeSearchCitationEventData = SearchCitationBase<
  "episode",
  "media",
  null,
  null
>;

export type VideoSearchCitationEventData = SearchCitationBase<
  "video",
  "media",
  null,
  null
>;

export type ContentChunkSearchCitationEventData = SearchCitationBase<
  "content_chunk",
  "content_chunk",
  string,
  MediaRetrievalLocator
> & {
  citation_label: string;
  source_kind: string;
  evidence_span_ids: string[];
};

export type FragmentSearchCitationEventData = SearchCitationBase<
  "fragment",
  "fragment",
  string,
  MediaRetrievalLocator
>;

export type PageSearchCitationEventData = SearchCitationBase<
  "page",
  "page",
  string,
  null
> & {
  description?: string | null;
};

export type NoteBlockSearchCitationEventData = SearchCitationBase<
  "note_block",
  "note_block",
  string,
  Extract<RetrievalLocator, { type: "note_block_offsets" }>
> & {
  page_id: string;
  page_title: string;
  body_text: string;
  highlight_excerpt?: string | null;
};

export type HighlightSearchCitationEventData = SearchCitationBase<
  "highlight",
  "highlight",
  string,
  MediaRetrievalLocator
> & {
  color: string;
  exact: string;
};

export type MessageSearchCitationEventData = SearchCitationBase<
  "message",
  "message",
  string,
  Extract<RetrievalLocator, { type: "message_offsets" }>
> & {
  conversation_id: string;
  seq: number;
};

export type ContributorSearchCitationEventData = SearchCitationBase<
  "contributor",
  "contributor",
  null,
  null
> & {
  contributor_handle: string;
};

export type EvidenceSpanSearchCitationEventData = SearchCitationBase<
  "evidence_span",
  "evidence_span",
  string,
  MediaRetrievalLocator
> & {
  citation_label: string;
  evidence_span_id: string;
  media_id: string;
};

export type ConversationSearchCitationEventData = SearchCitationBase<
  "conversation",
  "conversation",
  null,
  null
>;

export type ArtifactSearchCitationEventData = SearchCitationBase<
  "artifact",
  "artifact",
  null,
  null
> & {
  conversation_id: string;
  message_id: string;
  artifact_kind: string;
};

export type ArtifactPartSearchCitationEventData = SearchCitationBase<
  "artifact_part",
  "artifact_part",
  string,
  Extract<RetrievalLocator, { type: "artifact_part_ref" }>
> & {
  artifact_id: string;
  message_id: string;
  conversation_id: string;
  artifact_kind: string;
  artifact_title?: string | null;
  part_key?: string | null;
  part_type?: string | null;
};

export type SearchCitationEventData =
  | MediaSearchCitationEventData
  | PodcastSearchCitationEventData
  | EpisodeSearchCitationEventData
  | VideoSearchCitationEventData
  | ContentChunkSearchCitationEventData
  | FragmentSearchCitationEventData
  | PageSearchCitationEventData
  | NoteBlockSearchCitationEventData
  | HighlightSearchCitationEventData
  | MessageSearchCitationEventData
  | ContributorSearchCitationEventData
  | EvidenceSpanSearchCitationEventData
  | ConversationSearchCitationEventData
  | ArtifactSearchCitationEventData
  | ArtifactPartSearchCitationEventData;

export type WebCitationEventData = {
  assistant_message_id?: string;
  tool_call_id?: string | null;
  tool_name?: string | null;
  tool_call_index?: number | null;
  citation_index?: number;
  index?: number;
  type: "web_result";
  id: string;
  result_ref: string;
  result_type: "web_result";
  source_id: string;
  title: string;
  url: string;
  display_url?: string | null;
  source_name?: string | null;
  deep_link: string;
  snippet: string;
  excerpt?: string | null;
  extra_snippets?: string[];
  published_at?: string | null;
  provider?: string | null;
  provider_request_id?: string | null;
  rank?: number;
  source_version: string;
  context_ref: Extract<RetrievalContextRef, { type: "web_result" }>;
  media_id: null;
  media_kind: null;
  score: number | null;
  selected: boolean;
  locator: Extract<RetrievalLocator, { type: "external_url" }>;
};

export type CitationEventData = SearchCitationEventData | WebCitationEventData;

const SEARCH_CITATION_BASE_KEYS = [
  "type",
  "id",
  "result_type",
  "source_id",
  "title",
  "source_label",
  "snippet",
  "deep_link",
  "citation_label",
  "context_ref",
  "evidence_span_id",
  "source_version",
  "locator",
  "media_id",
  "media_kind",
  "score",
  "selected",
];

export function isSearchCitationEventData(
  citation: unknown,
): citation is SearchCitationEventData {
  if (!isRecord(citation)) return false;
  const resultType = citation.result_type;
  if (
    typeof resultType !== "string" ||
    !SEARCH_CITATION_RESULT_TYPES.has(resultType as SearchCitationResultType)
  ) {
    return false;
  }

  switch (resultType) {
    case "media":
      return isSearchCitationBase(citation, "media", "media", []);
    case "podcast":
      return (
        isSearchCitationBase(citation, "podcast", "podcast", [
          "contributors",
        ]) &&
        Array.isArray(citation.contributors) &&
        citation.contributors.every(isRecord)
      );
    case "episode":
      return isSearchCitationBase(citation, "episode", "media", []);
    case "video":
      return isSearchCitationBase(citation, "video", "media", []);
    case "content_chunk":
      return (
        isSearchCitationBase(citation, "content_chunk", "content_chunk", [
          "source_kind",
          "evidence_span_ids",
        ]) &&
        typeof citation.source_kind === "string" &&
        Array.isArray(citation.evidence_span_ids) &&
        citation.evidence_span_ids.every((id) => typeof id === "string") &&
        typeof citation.source_version === "string" &&
        typeof citation.citation_label === "string"
      );
    case "fragment":
      return (
        isSearchCitationBase(citation, "fragment", "fragment", []) &&
        typeof citation.source_version === "string"
      );
    case "page":
      return (
        isSearchCitationBase(citation, "page", "page", ["description"]) &&
        isOptionalString(citation.description) &&
        typeof citation.source_version === "string"
      );
    case "note_block":
      return (
        isSearchCitationBase(citation, "note_block", "note_block", [
          "page_id",
          "page_title",
          "body_text",
          "highlight_excerpt",
        ]) &&
        typeof citation.page_id === "string" &&
        typeof citation.page_title === "string" &&
        typeof citation.body_text === "string" &&
        isOptionalString(citation.highlight_excerpt) &&
        typeof citation.source_version === "string"
      );
    case "highlight":
      return (
        isSearchCitationBase(citation, "highlight", "highlight", [
          "color",
          "exact",
        ]) &&
        typeof citation.color === "string" &&
        typeof citation.exact === "string" &&
        typeof citation.source_version === "string"
      );
    case "message":
      return (
        isSearchCitationBase(citation, "message", "message", [
          "conversation_id",
          "seq",
        ]) &&
        typeof citation.conversation_id === "string" &&
        typeof citation.seq === "number" &&
        typeof citation.source_version === "string"
      );
    case "contributor":
      return (
        isSearchCitationBase(citation, "contributor", "contributor", [
          "contributor_handle",
        ]) && typeof citation.contributor_handle === "string"
      );
    case "evidence_span":
      return (
        isSearchCitationBase(citation, "evidence_span", "evidence_span", []) &&
        typeof citation.evidence_span_id === "string" &&
        typeof citation.citation_label === "string" &&
        typeof citation.source_version === "string" &&
        typeof citation.media_id === "string"
      );
    case "conversation":
      return isSearchCitationBase(citation, "conversation", "conversation", []);
    case "artifact":
      return (
        isSearchCitationBase(citation, "artifact", "artifact", [
          "conversation_id",
          "message_id",
          "artifact_kind",
        ]) &&
        typeof citation.conversation_id === "string" &&
        typeof citation.message_id === "string" &&
        typeof citation.artifact_kind === "string"
      );
    case "artifact_part":
      return (
        isSearchCitationBase(citation, "artifact_part", "artifact_part", [
          "artifact_id",
          "message_id",
          "conversation_id",
          "artifact_kind",
          "artifact_title",
          "part_key",
          "part_type",
        ]) &&
        typeof citation.artifact_id === "string" &&
        typeof citation.message_id === "string" &&
        typeof citation.conversation_id === "string" &&
        typeof citation.artifact_kind === "string" &&
        typeof citation.source_version === "string" &&
        isOptionalString(citation.artifact_title) &&
        isOptionalString(citation.part_key) &&
        isOptionalString(citation.part_type)
      );
  }
  return false;
}

function isSearchCitationBase(
  citation: Record<string, unknown>,
  resultType: SearchCitationResultType,
  contextType: RetrievalContextRef["type"],
  variantKeys: string[],
): boolean {
  return (
    hasOnlyKeys(citation, [...SEARCH_CITATION_BASE_KEYS, ...variantKeys]) &&
    citation.type === resultType &&
    citation.result_type === resultType &&
    typeof citation.id === "string" &&
    typeof citation.source_id === "string" &&
    typeof citation.title === "string" &&
    (typeof citation.source_label === "string" ||
      citation.source_label === null) &&
    typeof citation.snippet === "string" &&
    typeof citation.deep_link === "string" &&
    isOptionalString(citation.citation_label) &&
    isRetrievalContextRef(citation.context_ref) &&
    citation.context_ref.type === contextType &&
    isOptionalString(citation.evidence_span_id) &&
    (citation.source_version === null ||
      typeof citation.source_version === "string") &&
    isSearchCitationLocator(resultType, citation.locator) &&
    (typeof citation.media_id === "string" || citation.media_id === null) &&
    (typeof citation.media_kind === "string" || citation.media_kind === null) &&
    (typeof citation.score === "number" || citation.score === null) &&
    typeof citation.selected === "boolean"
  );
}

function isSearchCitationLocator(
  resultType: SearchCitationResultType,
  locator: unknown,
): boolean {
  switch (resultType) {
    case "media":
    case "podcast":
    case "episode":
    case "video":
    case "page":
    case "contributor":
    case "conversation":
    case "artifact":
      return locator === null;
    case "content_chunk":
    case "fragment":
    case "highlight":
    case "evidence_span":
      return isRetrievalLocator(locator) && isMediaRetrievalLocator(locator);
    case "note_block":
      return (
        isRetrievalLocator(locator) && locator.type === "note_block_offsets"
      );
    case "message":
      return isRetrievalLocator(locator) && locator.type === "message_offsets";
    case "artifact_part":
      return (
        isRetrievalLocator(locator) && locator.type === "artifact_part_ref"
      );
  }
}

export function isWebCitationEventData(
  citation: unknown,
): citation is WebCitationEventData {
  return (
    isRecord(citation) &&
    hasOnlyKeys(citation, [
      "assistant_message_id",
      "tool_call_id",
      "tool_name",
      "tool_call_index",
      "citation_index",
      "index",
      "type",
      "id",
      "result_ref",
      "result_type",
      "source_id",
      "title",
      "url",
      "display_url",
      "source_name",
      "deep_link",
      "snippet",
      "excerpt",
      "extra_snippets",
      "published_at",
      "provider",
      "provider_request_id",
      "rank",
      "source_version",
      "context_ref",
      "media_id",
      "media_kind",
      "score",
      "selected",
      "locator",
    ]) &&
    citation.type === "web_result" &&
    typeof citation.id === "string" &&
    citation.result_type === "web_result" &&
    typeof citation.result_ref === "string" &&
    typeof citation.source_id === "string" &&
    typeof citation.title === "string" &&
    typeof citation.url === "string" &&
    (citation.display_url === undefined ||
      citation.display_url === null ||
      typeof citation.display_url === "string") &&
    (citation.source_name === undefined ||
      citation.source_name === null ||
      typeof citation.source_name === "string") &&
    typeof citation.deep_link === "string" &&
    typeof citation.snippet === "string" &&
    (citation.excerpt === undefined ||
      citation.excerpt === null ||
      typeof citation.excerpt === "string") &&
    (citation.extra_snippets === undefined ||
      (Array.isArray(citation.extra_snippets) &&
        citation.extra_snippets.every((item) => typeof item === "string"))) &&
    (citation.published_at === undefined ||
      citation.published_at === null ||
      typeof citation.published_at === "string") &&
    (citation.provider === undefined ||
      citation.provider === null ||
      typeof citation.provider === "string") &&
    (citation.provider_request_id === undefined ||
      citation.provider_request_id === null ||
      typeof citation.provider_request_id === "string") &&
    (citation.rank === undefined || Number.isInteger(citation.rank)) &&
    typeof citation.source_version === "string" &&
    isRetrievalContextRef(citation.context_ref) &&
    citation.context_ref.type === "web_result" &&
    isRetrievalLocator(citation.locator) &&
    citation.locator.type === "external_url" &&
    citation.media_id === null &&
    citation.media_kind === null &&
    (citation.score === null || typeof citation.score === "number") &&
    typeof citation.selected === "boolean"
  );
}

export function isCitationEventData(
  citation: unknown,
): citation is CitationEventData {
  return (
    isWebCitationEventData(citation) || isSearchCitationEventData(citation)
  );
}
