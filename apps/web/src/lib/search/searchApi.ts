import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import type { SearchQuery } from "./query";
import { searchQueryToParams } from "./searchParams";
import { projectSearchResult } from "./searchViewModel";
import type { SearchResultPage } from "./types";

/** One page of `GET /api/search` as view-model rows. */
export async function fetchSearchResultPage(
  query: SearchQuery,
  options: { limit: number; cursor?: string | null; signal?: AbortSignal },
): Promise<SearchResultPage> {
  const params = searchQueryToParams(query);
  params.set("limit", String(options.limit));
  if (options.cursor) params.set("cursor", options.cursor);
  const page = await apiFetch<ApiJson<"/search", "get">>(
    `/api/search?${params}`,
    { signal: options.signal },
  );
  return {
    rows: page.results.map(projectSearchResult),
    nextCursor: page.page.next_cursor,
  };
}
