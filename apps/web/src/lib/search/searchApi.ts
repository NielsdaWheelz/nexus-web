import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import type { SearchQuery } from "./query";
import { searchQueryToParams } from "./searchParams";

/** Keep server grouping, evidence, activation and semantic status intact. */
export async function fetchSearchResultPage(
  query: SearchQuery,
  options: { limit: number; cursor?: string | null; signal?: AbortSignal },
): Promise<ApiJson<"/search", "get">> {
  const params = searchQueryToParams(query);
  params.set("limit", String(Math.min(options.limit, 50)));
  if (options.cursor) params.set("cursor", options.cursor);
  return apiFetch<ApiJson<"/search", "get">>(
    `/api/search?${params}`,
    { signal: options.signal },
  );
}

/** Two bounded preview phases share one wire contract. */
export async function fetchSearchPreview(
  query: SearchQuery,
  options: { phase: "direct" | "content"; signal?: AbortSignal },
): Promise<ApiJson<"/search/preview", "get">> {
  const params = searchQueryToParams(query);
  params.delete("view");
  params.set("phase", options.phase);
  return apiFetch<ApiJson<"/search/preview", "get">>(
    `/api/search/preview?${params}`,
    { signal: options.signal },
  );
}
