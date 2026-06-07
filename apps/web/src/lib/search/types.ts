import type { RetrievalLocator } from "@/lib/api/sse/locators";
import type { ContributorCredit } from "@/lib/contributors/types";

// Canonical internal result-type discriminants (the response union tags). Kept as
// the validator for normalizeSearchResult — NOT a user-facing filter taxonomy.
export const RESULT_TYPE_VALUES = [
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
  "web_result",
] as const;

export type SearchType = (typeof RESULT_TYPE_VALUES)[number];

export interface SearchSourceMetadata {
  media_id: string;
  media_kind: string;
  title: string;
  contributors: ContributorCredit[];
  published_date: string | null;
}

export interface SearchBaseResult {
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
    locator?: RetrievalLocator | null;
  };
}

export interface SearchMediaResult extends SearchBaseResult {
  type: "media" | "episode" | "video";
  source: SearchSourceMetadata;
}

export interface SearchPodcastResult extends SearchBaseResult {
  type: "podcast";
  contributors: ContributorCredit[];
}

export interface SearchContributorResult extends SearchBaseResult {
  type: "contributor";
  contributor_handle: string;
  contributor: {
    handle: string;
    display_name: string;
    status: string | null;
  };
}

export interface SearchContentChunkResult extends SearchBaseResult {
  type: "content_chunk";
  media_id: string;
  media_kind: string;
  citation_label: string;
  source: SearchSourceMetadata;
  locator: RetrievalLocator;
}

export interface SearchFragmentResult extends SearchBaseResult {
  type: "fragment";
  citation_label: string | null;
  locator: RetrievalLocator;
  source: SearchSourceMetadata;
}

export interface SearchNoteBlockResult extends SearchBaseResult {
  type: "note_block";
  page_id: string;
  page_title: string;
  body_text: string;
  highlight_excerpt: string | null;
  locator: RetrievalLocator;
}

export interface SearchHighlightResult extends SearchBaseResult {
  type: "highlight";
  color: string;
  exact: string;
  citation_label: string | null;
  locator: RetrievalLocator;
  source: SearchSourceMetadata;
}

export interface SearchPageResult extends SearchBaseResult {
  type: "page";
  description: string | null;
}

export interface SearchMessageResult extends SearchBaseResult {
  type: "message";
  conversation_id: string;
  seq: number;
  locator: RetrievalLocator;
}

export interface SearchEvidenceSpanResult extends SearchBaseResult {
  type: "evidence_span";
  evidence_span_id: string;
  citation_label: string;
  locator: RetrievalLocator;
  source: SearchSourceMetadata;
}

export interface SearchConversationResult extends SearchBaseResult {
  type: "conversation";
}

export interface SearchWebResult extends SearchBaseResult {
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
  locator: Extract<RetrievalLocator, { type: "external_url" }>;
  selected: boolean;
}

export type SearchApiResult =
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
  | SearchWebResult;

export interface SearchResponseShape {
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
    locator?: RetrievalLocator;
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
}

export interface SearchResultPage {
  rows: SearchResultRowViewModel[];
  nextCursor: string | null;
}
