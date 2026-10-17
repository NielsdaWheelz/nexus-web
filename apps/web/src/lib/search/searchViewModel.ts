import type { ApiJson } from "@/lib/api/wire";
import type { SearchResultRowViewModel } from "./types";

/** Preserve the server's content, ordering and unavailable occurrences. */
export function projectSearchResult(result: ApiJson<"/search", "get">["results"][number]): SearchResultRowViewModel {
  return { ...result, key: `${result.type}:${result.id}` };
}
