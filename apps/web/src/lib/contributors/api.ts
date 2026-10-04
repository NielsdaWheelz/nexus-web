import { ApiError, type ApiPath, apiFetch } from "@/lib/api/client";
import {
  decodeCollectionCursor,
  decodeCollectionRevision,
  type CollectionCursor,
  type CollectionPage,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import { absent, present } from "@/lib/api/presence";
import type { ApiJson } from "@/lib/api/wire";
import { contributorWorksResource } from "@/lib/api/resource";
import type { AuthorWorksView } from "@/lib/contributors/workView";
import { parseContributorHandle } from "@/lib/contributors/handle";
import { decodeOptionalPublicationDate } from "@/lib/dates/publicationDate";
import { mediaSummaryFromWire } from "@/lib/media/mediaSummary";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type {
  ContributorDetail,
  ContributorSearchPage,
  ContributorWorkItem,
  MediaAuthorCredit,
  MediaAuthors,
  MediaAuthorsPutBody,
} from "@/lib/contributors/types";

interface Envelope<T> {
  data: T;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

export function contributorDetailFromWire(
  detail: ApiJson<"/contributors/{contributor_handle}", "get">["data"],
): ContributorDetail {
  return {
    ...detail,
    handle: parseContributorHandle(detail.handle),
    actionSubject: { ref: assumeCanonicalResourceRef(detail.actionSubject.ref) },
  };
}

export function contributorWorksPageFromWire(
  page: ApiJson<"/contributors/{contributor_handle}/works", "get">["data"],
): CollectionPage<ContributorWorkItem> {
  try {
    return {
      items: page.items.map((item): ContributorWorkItem => {
        if (item.kind === "Media") {
          return {
            ...item,
            mediaSummary: mediaSummaryFromWire(item.mediaSummary),
            actionSubject: { ref: assumeCanonicalResourceRef(item.actionSubject.ref) },
          };
        }
        const date = decodeOptionalPublicationDate(item.date, "ContributorWorkItem.date");
        if (item.kind === "Podcast") {
          return {
            ...item,
            date,
            actionSubject: { ref: assumeCanonicalResourceRef(item.actionSubject.ref) },
          };
        }
        return { ...item, date };
      }),
      collectionRevision: decodeCollectionRevision(page.collectionRevision),
      nextCursor: page.nextCursor.kind === "Present"
        ? present(decodeCollectionCursor(page.nextCursor.value))
        : absent(),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      200,
      "E_INVALID_RESPONSE",
      error instanceof Error ? error.message : "Invalid CollectionPage",
    );
  }
}

function decodeMediaAuthorCredit(raw: unknown): MediaAuthorCredit {
  const credit = raw as {
    contributorHandle: string;
    href: string;
    displayName: string;
    creditedName: string;
  };
  return {
    contributorHandle: parseContributorHandle(credit.contributorHandle),
    href: credit.href,
    displayName: credit.displayName,
    creditedName: credit.creditedName,
  };
}

function decodeMediaAuthors(raw: unknown): MediaAuthors {
  const authors = raw as {
    authorMode: "automatic" | "manual";
    authors?: unknown[] | null;
    canEditAuthors: boolean;
  };
  return {
    authorMode: authors.authorMode,
    authors: Array.isArray(authors.authors) ? authors.authors.map(decodeMediaAuthorCredit) : [],
    canEditAuthors: Boolean(authors.canEditAuthors),
  };
}

export interface ContributorSearchOptions {
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}

export async function fetchContributorSearch(
  query: string,
  options: ContributorSearchOptions = {},
): Promise<ContributorSearchPage> {
  const params = new URLSearchParams();
  params.set("q", query.trim());
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const path = `/api/contributors?${params.toString()}` as ApiPath;
  const response = await apiFetch<ApiJson<"/contributors", "get">>(
    path,
    { cache: "no-store", signal: options.signal },
  );
  return {
    ...response.data,
    contributors: response.data.contributors.map((item) => ({
      ...item,
      handle: parseContributorHandle(item.handle),
    })),
  };
}

export async function fetchContributorDetail(handle: string): Promise<ContributorDetail> {
  const response = await apiFetch<ApiJson<"/contributors/{contributor_handle}", "get">>(
    `/api/contributors/${encode(handle)}` as ApiPath,
    { cache: "no-store" },
  );
  return contributorDetailFromWire(response.data);
}

export interface ContributorWorksOptions {
  /** The exact works view this page belongs to; every page of a chain shares it. */
  readonly view: AuthorWorksView;
  readonly cursor?: CollectionCursor;
  readonly collectionRevision?: CollectionRevision;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export async function fetchContributorWorks(
  handle: string,
  { view, cursor, collectionRevision, limit, signal }: ContributorWorksOptions,
): Promise<CollectionPage<ContributorWorkItem>> {
  const response = await apiFetch<ApiJson<"/contributors/{contributor_handle}/works", "get">>(
    contributorWorksResource.clientPath({
      handle,
      view,
      cursor,
      collectionRevision,
      limit,
    }),
    { cache: "no-store", signal },
  );
  return contributorWorksPageFromWire(response.data);
}

export async function putMediaAuthors(
  mediaId: string,
  body: MediaAuthorsPutBody,
): Promise<MediaAuthors> {
  const response = await apiFetch<Envelope<unknown>>(
    `/api/media/${encode(mediaId)}/authors` as ApiPath,
    { method: "PUT", body: JSON.stringify(body) },
  );
  return decodeMediaAuthors(response.data);
}
