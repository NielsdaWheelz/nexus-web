import type { ApiJson } from "@/lib/api/wire";

type SearchResult = ApiJson<"/search", "get">["results"][number];
export type SearchType = SearchResult["type"];
export type SearchResultRowViewModel = SearchResult & { key: string };
export interface SearchResultPage {
  rows: SearchResultRowViewModel[];
  nextCursor: string | null;
}
