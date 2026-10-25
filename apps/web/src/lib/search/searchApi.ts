// Complete server-ranked phase responses; phase/view are checked before adoption.
import { apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import type { SearchQuery } from "./query";
import { searchQueryToParams } from "./searchParams";

export type SearchPhase = ApiJson<"/search", "get">["phase"];
export type PreviewPhase = ApiJson<"/search/preview", "get">["phase"];

export async function fetchSearchResultPage(
  query: SearchQuery,
  options: { phase: SearchPhase; limit: number; cursor?: string | null; signal?: AbortSignal },
): Promise<ApiJson<"/search", "get">> {
  const params = searchQueryToParams(query);
  params.set("phase", options.phase);
  params.set("limit", String(Math.min(options.limit, 50)));
  if (options.cursor) params.set("cursor", options.cursor);
  const response = await apiFetch<ApiJson<"/search", "get">>(`/api/search?${params}`, { signal: options.signal });
  // justify-defect: same-deploy JSON is generated; these are the requested read's invariants.
  if (response.phase !== options.phase || response.view !== query.view) throw new Error("search response differs from requested phase or view");
  return response;
}

export async function fetchSearchPreview(
  query: SearchQuery,
  options: { phase: PreviewPhase; signal?: AbortSignal },
): Promise<ApiJson<"/search/preview", "get">> {
  const params = searchQueryToParams(query);
  params.delete("view");
  params.set("phase", options.phase);
  const response = await apiFetch<ApiJson<"/search/preview", "get">>(`/api/search/preview?${params}`, { signal: options.signal });
  // justify-defect: a response from another phase cannot replace these rows.
  if (response.phase !== options.phase) throw new Error("search preview differs from requested phase");
  return response;
}
