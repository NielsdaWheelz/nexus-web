// Browse http: one section page and one preview, both read-only.

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
  readonly cursor?: string;
  readonly signal: AbortSignal;
}): Promise<Schema<"BrowsePage">> {
  const { q, kind, source } = input;
  const params = new URLSearchParams({ q, kind, source, limit: "20" });
  if (input.sort === "Newest") params.set("sort", "Newest");
  if (input.cursor !== undefined) params.set("cursor", input.cursor);
  type Body = ApiJson<"/browse", "get">;
  const path = `/api/browse?${params}` as const;
  return (await apiFetch<Body>(path, { signal: input.signal })).data;
}

/** A preview; `cursor` continues a podcast preview's episode list. */
export async function fetchBrowsePreview(
  target: string,
  cursor: string | null,
  signal: AbortSignal,
): Promise<BrowsePreview> {
  const params = new URLSearchParams({ target, limit: "20" });
  if (cursor !== null) params.set("cursor", cursor);
  type Body = ApiJson<"/browse/preview", "get">;
  const path = `/api/browse/preview?${params}` as const;
  return (await apiFetch<Body>(path, { signal })).data;
}
