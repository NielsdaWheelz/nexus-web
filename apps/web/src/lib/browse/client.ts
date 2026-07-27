import { apiFetch } from "@/lib/api/client";
import type { BrowseResponse, BrowseResult } from "./types";

export async function fetchBrowseResults(input: {
  query: string;
  limit: number;
  signal?: AbortSignal;
}): Promise<BrowseResult[]> {
  const params = new URLSearchParams({
    q: input.query.trim(),
    limit: String(input.limit),
  });
  const response = await apiFetch<BrowseResponse>(
    `/api/browse?${params.toString()}`,
    { signal: input.signal },
  );
  return Object.values(response.data.sections).flatMap(
    (section) => section?.results ?? [],
  );
}

export async function fetchPodcastBrowseResults(input: {
  query: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<
  Array<Extract<BrowseResult, { type: "podcasts" | "podcast_episodes" }>>
> {
  const results = await fetchBrowseResults({
    query: input.query,
    limit: input.limit ?? 12,
    signal: input.signal,
  });
  return results.filter(
    (
      result,
    ): result is Extract<
      BrowseResult,
      { type: "podcasts" | "podcast_episodes" }
    > => result.type === "podcasts" || result.type === "podcast_episodes",
  );
}
