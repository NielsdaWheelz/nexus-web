// Browse http: one section page and one target-only preview, both read-only.

import { apiFetch } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";

export type BrowseKind = Schema<"BrowseKind">;
export type BrowseSource = Schema<"BrowseSource">;
export type BrowseSort = Schema<"BrowseSort">;
export type BrowseCandidate = Schema<"BrowseCandidate">;
export type BrowsePreview = Schema<"BrowsePreview">;
export type PreviewEpisode = Schema<"PodcastPreviewEpisode">;

export function browsePreviewHref(target: string): string {
  return `/browse/preview?target=${encodeURIComponent(target)}`;
}

export async function fetchBrowsePage(input: {
  readonly q: string;
  readonly kind: BrowseKind;
  readonly source: BrowseSource;
  readonly sort: BrowseSort;
  readonly cursor: string | null;
  readonly limit: number;
  readonly signal: AbortSignal;
}): Promise<Schema<"BrowsePage">> {
  const { q, kind, source } = input;
  const params = new URLSearchParams({ q, kind, source, limit: String(input.limit) });
  if (input.sort === "Newest") params.set("sort", "Newest");
  if (input.cursor !== null) params.set("cursor", input.cursor);
  type Body = ApiJson<"/browse", "get">;
  const path = `/api/browse?${params}` as const;
  return (await apiFetch<Body>(path, { signal: input.signal })).data;
}

/** One preview; podcasts carry their entire bounded directory snapshot. */
export async function fetchBrowsePreview(
  target: string,
  signal: AbortSignal,
): Promise<BrowsePreview> {
  const params = new URLSearchParams({ target });
  type Body = ApiJson<"/browse/preview", "get">;
  const path = `/api/browse/preview?${params}` as const;
  return (await apiFetch<Body>(path, { signal })).data;
}
