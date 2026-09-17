import { isRecord } from "@/lib/validation";
import {
  RESULT_TYPE_VALUES,
  type SearchType,
} from "@/lib/search/types";
import { hasOnlyKeys } from "./guards";
import type { MediaRetrievalLocator, RetrievalLocator } from "./locators";

export type SearchCitationResultType = Exclude<SearchType, "web_result">;

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

const SEARCH_CITATION_RESULT_TYPES = new Set<SearchCitationResultType>(
  RESULT_TYPE_VALUES.filter(
    (value): value is SearchCitationResultType => value !== "web_result",
  ),
);

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
  citation_target?: string | null;
  citation_label?: string | null;
  context_ref: {
    type: TContextType;
    id: string;
    evidence_span_ids?: string[];
  };
  evidence_span_id?: string | null;
  locator: TLocator;
  media_id: string | null;
  media_kind: string | null;
  score: number | null;
  selected: boolean;
};

type MediaSearchCitationEventData = SearchCitationBase<
  "media",
  "media",
  null
> & {
  summary_md?: string | null;
};

type PodcastSearchCitationEventData = SearchCitationBase<
  "podcast",
  "podcast",
  null
> & {
  contributors: Array<Record<string, unknown>>;
};

type EpisodeSearchCitationEventData = SearchCitationBase<
  "episode",
  "media",
  null
> & {
  summary_md?: string | null;
};

type VideoSearchCitationEventData = SearchCitationBase<
  "video",
  "media",
  null
> & {
  summary_md?: string | null;
};

type ContentChunkSearchCitationEventData = SearchCitationBase<
  "content_chunk",
  "content_chunk",
  MediaRetrievalLocator
> & {
  citation_label: string;
  source_kind: string;
  evidence_span_ids: string[];
};

type FragmentSearchCitationEventData = SearchCitationBase<
  "fragment",
  "fragment",
  MediaRetrievalLocator
>;

type PageSearchCitationEventData = SearchCitationBase<
  "page",
  "page",
  null
> & {
  description?: string | null;
};

type NoteBlockSearchCitationEventData = SearchCitationBase<
  "note_block",
  "note_block",
  Extract<RetrievalLocator, { type: "note_block_offsets" }>
> & {
  body_text: string;
  highlight_excerpt?: string | null;
};

type HighlightSearchCitationEventData = SearchCitationBase<
  "highlight",
  "highlight",
  MediaRetrievalLocator
> & {
  color: string;
  exact: string;
};

type MessageSearchCitationEventData = SearchCitationBase<
  "message",
  "message",
  Extract<RetrievalLocator, { type: "message_offsets" }>
> & {
  conversation_id: string;
  seq: number;
};

type ContributorSearchCitationEventData = SearchCitationBase<
  "contributor",
  "contributor",
  null
> & {
  contributor_handle: string;
};

type EvidenceSpanSearchCitationEventData = SearchCitationBase<
  "evidence_span",
  "evidence_span",
  MediaRetrievalLocator
> & {
  citation_label: string;
  evidence_span_id: string;
  media_id: string;
};

type ConversationSearchCitationEventData = SearchCitationBase<
  "conversation",
  "conversation",
  null
>;

type ArtifactSearchCitationEventData = SearchCitationBase<
  "artifact",
  "artifact",
  null
> & {
  revision_id: string;
  subject_ref: string;
};

type ReaderApparatusItemSearchCitationEventData = SearchCitationBase<
  "reader_apparatus_item",
  "reader_apparatus_item",
  RetrievalLocator
> & {
  apparatus_kind: string;
  media_id: string;
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
  | ReaderApparatusItemSearchCitationEventData;

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
  citation_target?: string | null;
  snippet: string;
  excerpt?: string | null;
  extra_snippets?: string[];
  published_at?: string | null;
  provider?: string | null;
  provider_request_id?: string | null;
  rank?: number;
  context_ref: Extract<RetrievalContextRef, { type: "web_result" }>;
  media_id: null;
  media_kind: null;
  score: number | null;
  selected: boolean;
  locator: Extract<RetrievalLocator, { type: "external_url" }>;
};

export type CitationEventData = SearchCitationEventData | WebCitationEventData;

export function isSearchCitationEventData(
  citation: unknown,
): citation is SearchCitationEventData {
  return (
    isRecord(citation) &&
    typeof citation.result_type === "string" &&
    SEARCH_CITATION_RESULT_TYPES.has(
      citation.result_type as SearchCitationResultType,
    ) &&
    citation.type === citation.result_type
  );
}

export function isWebCitationEventData(
  citation: unknown,
): citation is WebCitationEventData {
  return isRecord(citation) && citation.type === "web_result";
}

export function isCitationEventData(
  citation: unknown,
): citation is CitationEventData {
  return (
    isWebCitationEventData(citation) || isSearchCitationEventData(citation)
  );
}
