import type {
  CitationEventData,
  SearchCitationEventData,
  WebCitationEventData,
} from "@/lib/api/sse";

export interface WebCitationChipData {
  assistant_message_id?: string;
  tool_call_id?: string | null;
  tool_call_index?: number | null;
  citation_index?: number;
  result_ref?: string;
  title: string;
  url: string;
  display_url?: string | null;
  source_name?: string | null;
  snippet?: string | null;
  provider?: string | null;
}

export function isWebCitation(
  citation: CitationEventData,
): citation is WebCitationEventData {
  return "url" in citation;
}

export function isSearchCitation(
  citation: CitationEventData,
): citation is SearchCitationEventData {
  return "deep_link" in citation && "source_id" in citation;
}

export function toWebCitationChipData(
  citation: WebCitationEventData,
): WebCitationChipData {
  return {
    assistant_message_id: citation.assistant_message_id,
    tool_call_id: citation.tool_call_id,
    tool_call_index: citation.tool_call_index,
    citation_index: citation.citation_index ?? citation.index,
    result_ref: citation.result_ref,
    title: citation.title,
    url: citation.url,
    display_url: citation.display_url,
    source_name: citation.source_name,
    snippet: citation.snippet ?? citation.excerpt ?? null,
    provider: citation.provider,
  };
}

export function getWebCitationKey(
  citation: WebCitationChipData,
  fallbackIndex: number,
): string {
  return (
    citation.result_ref ||
    citation.url ||
    `${citation.tool_call_id ?? "citation"}-${citation.citation_index ?? fallbackIndex}`
  );
}
