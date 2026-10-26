// The contributor read surface on the generated wire types: author search,
// detail and the complete works index.
// The server validates everything it is sent; nothing here re-validates it.

import { apiFetch } from "@/lib/api/client";
import type { ListPage } from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";

export type ContributorSearchItem = Schema<"ContributorSearchItemOut">;
export type ContributorDetail = Schema<"ContributorDetailOut">;
export type ContributorWork =
  | Schema<"MediaContributorWorkItemOut">
  | Schema<"PodcastContributorWorkItemOut">
  | Schema<"ExternalContributorWorkItemOut">;

const authorPath = (handle: string) =>
  `/api/contributors/${encodeURIComponent(handle)}` as const;

/** One server-ordered author search page; consumers own traversal through the shared list. */
export async function searchContributors({ q, cursor, limit, signal }: {
  readonly q: string;
  readonly cursor: string | null;
  readonly limit: number;
  readonly signal: AbortSignal;
}): Promise<ListPage<ContributorSearchItem>> {
  const query = new URLSearchParams({ q, limit: String(limit) });
  if (cursor !== null) query.set("cursor", cursor);
  type Body = ApiJson<"/contributors", "get">;
  const page = (await apiFetch<Body>(`/api/contributors?${query}`, { signal })).data;
  return { items: page.contributors, next_cursor: page.next_cursor };
}

export async function getContributor(
  handle: string,
  signal?: AbortSignal,
): Promise<ContributorDetail> {
  type Body = ApiJson<"/contributors/{contributor_handle}", "get">;
  return (await apiFetch<Body>(authorPath(handle), { signal })).data;
}

/** Every visible work in the canonical order. */
export async function listContributorWorks(
  handle: string,
  query: URLSearchParams,
  signal: AbortSignal,
) {
  type Body = ApiJson<"/contributors/{contributor_handle}/works", "get">;
  const path = `${authorPath(handle)}/works?${query}` as const;
  return (await apiFetch<Body>(path, { signal })).data;
}
