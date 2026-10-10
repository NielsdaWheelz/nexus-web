// The contributor http surface on the generated wire types: author search,
// detail, works pages, a media's author slice and the manual-authors PUT.
// The server validates everything it is sent; nothing here re-validates it.

import { apiFetch } from "@/lib/api/client";
import type { ServerPage } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";

export type ContributorSearchItem = Schema<"ContributorSearchItemOut">;
export type ContributorDetail = Schema<"ContributorDetailOut">;
export type ContributorWork =
  | Schema<"MediaContributorWorkItemOut">
  | Schema<"PodcastContributorWorkItemOut">
  | Schema<"ExternalContributorWorkItemOut">;
export type AuthorBinding =
  Schema<"ExistingAuthorBinding"> | Schema<"NewAuthorBinding">;
type MediaAuthorsBody =
  Schema<"ManualMediaAuthorsRequest"> | Schema<"AutomaticMediaAuthorsRequest">;

const authorPath = (handle: string) =>
  `/api/contributors/${encodeURIComponent(handle)}` as const;

/** The first ten people whose names match `q`. */
export async function searchContributors(
  q: string,
  signal: AbortSignal,
): Promise<Schema<"ContributorSearchPageOut">> {
  const query = new URLSearchParams({ q, limit: "10" });
  type Body = ApiJson<"/contributors", "get">;
  return (await apiFetch<Body>(`/api/contributors?${query}`, { signal })).data;
}

export async function getContributor(
  handle: string,
  signal?: AbortSignal,
): Promise<ContributorDetail> {
  type Body = ApiJson<"/contributors/{contributor_handle}", "get">;
  return (await apiFetch<Body>(authorPath(handle), { signal })).data;
}

/** One works page; `query` carries the view keys and the page keys as given. */
export async function listContributorWorks(
  handle: string,
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<ServerPage<ContributorWork>> {
  type Body = ApiJson<"/contributors/{contributor_handle}/works", "get">;
  const path = `${authorPath(handle)}/works?${query}` as const;
  return (await apiFetch<Body>(path, { signal })).data;
}

/** The media's author-role credits that name a person, and its pin. */
export async function getMediaAuthors(
  mediaId: string,
  signal: AbortSignal,
): Promise<{
  readonly authors: readonly Schema<"ContributorCreditOut">[];
  readonly manual: boolean;
}> {
  type Body = ApiJson<"/media/{media_id}", "get">;
  const path = `/api/media/${encodeURIComponent(mediaId)}` as const;
  const media = (await apiFetch<Body>(path, { signal })).data;
  return {
    authors: media.contributors.filter(
      (credit) => credit.role === "author" && credit.contributor_handle,
    ),
    manual: media.author_mode === "manual",
  };
}

export async function putMediaAuthors(
  mediaId: string,
  body: MediaAuthorsBody,
): Promise<void> {
  type Body = ApiJson<"/media/{media_id}/authors", "put">;
  const path = `/api/media/${encodeURIComponent(mediaId)}/authors` as const;
  await apiFetch<Body>(path, { method: "PUT", body: JSON.stringify(body) });
}
