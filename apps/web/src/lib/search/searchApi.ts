import { apiFetch } from "@/lib/api/client";
import type { SearchQuery } from "./query";
import { searchQueryToParams } from "./searchParams";
import { adaptSearchResults } from "./searchViewModel";
import type { SearchResponseShape, SearchResultPage } from "./types";

export interface FetchSearchOptions {
  limit: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

function requireSearchResults(results: unknown): unknown[] {
  if (!Array.isArray(results)) {
    throw new Error("Search API response is missing results");
  }
  return results;
}

export async function fetchSearchResultPage(
  query: SearchQuery,
  { limit, cursor = null, signal }: FetchSearchOptions,
): Promise<SearchResultPage> {
  const params = searchQueryToParams(query);
  params.set("limit", String(limit));
  if (cursor) {
    params.set("cursor", cursor);
  }

  const response = await apiFetch<SearchResponseShape>(
    `/api/search?${params.toString()}`,
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
