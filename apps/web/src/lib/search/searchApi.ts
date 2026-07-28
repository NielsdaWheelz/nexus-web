import { apiFetch } from "@/lib/api/client";
import {
  expectBoolean,
  expectExactRecord,
  expectNullableString,
} from "@/lib/validation";
import type { SearchQuery } from "./query";
import { searchQueryToParams } from "./searchParams";
import { adaptSearchResults } from "./searchViewModel";
import type { SearchResultPage } from "./types";

export interface FetchSearchOptions {
  limit: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

export class SearchContractDefect extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchContractDefect";
  }
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

  const raw = await apiFetch<unknown>(
    `/api/search?${params.toString()}`,
    { signal },
  );
  try {
    const response = expectExactRecord(
      raw,
      ["results", "page"],
      "SearchResponse",
    );
    if (!Array.isArray(response.results)) {
      throw new TypeError("SearchResponse.results must be an array");
    }
    const page = expectExactRecord(
      response.page,
      ["has_more", "next_cursor"],
      "SearchResponse.page",
    );
    expectBoolean(page.has_more, "SearchResponse.page.has_more");

    return {
      rows: adaptSearchResults(response.results),
      nextCursor: expectNullableString(
        page.next_cursor,
        "SearchResponse.page.next_cursor",
      ),
    };
  } catch (error) {
    if (error instanceof TypeError) {
      throw new SearchContractDefect(error.message);
    }
    throw error;
  }
}
