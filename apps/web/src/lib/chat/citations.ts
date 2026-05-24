import {
  isSearchCitationEventData,
  isWebCitationEventData,
  type SearchCitationEventData,
  type WebCitationEventData,
} from "@/lib/api/sse/citations";

export function isWebCitation(
  citation: unknown,
): citation is WebCitationEventData {
  return isWebCitationEventData(citation);
}

export function isSearchCitation(
  citation: unknown,
): citation is SearchCitationEventData {
  return isSearchCitationEventData(citation);
}
