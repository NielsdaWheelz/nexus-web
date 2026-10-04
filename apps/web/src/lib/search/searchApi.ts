import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import type { SearchQuery } from "./query";
import { searchQueryToParams } from "./searchParams";
import { adaptSearchResults } from "./searchViewModel";
import type { SearchResultPage } from "./types";

export interface FetchSearchOptions {
  limit: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

export async function fetchSearchResultPage(
  query: SearchQuery,
  { limit, cursor = null, signal }: FetchSearchOptions,
): Promise<SearchResultPage> {
  const params = searchQueryToParams(query);
  params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  const response = await apiFetch<ApiJson<"/search", "get">>(
    `/api/search?${params.toString()}`,
    { signal },
  );
  return {
    rows: adaptSearchResults(response.results),
    nextCursor: response.page.next_cursor,
  };
}
