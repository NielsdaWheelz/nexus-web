import { type ApiPath, apiFetch } from "@/lib/api/client";
import { parseContributorHandle } from "@/lib/contributors/handle";
import { decodeContributorWorkItem } from "@/lib/contributors/workItem";
import { expectArray, expectNullableString } from "@/lib/validation";
import type {
  ContributorDetail,
  ContributorRenameBody,
  ContributorSearchItem,
  ContributorSearchPage,
  ContributorWorkPage,
  MediaAuthorCredit,
  MediaAuthors,
  MediaAuthorsPutBody,
} from "@/lib/contributors/types";

// Every inbound handle is branded via parseContributorHandle at this decode
// boundary (D-45): a non-canonical handle from the wire is a defect, surfaced as a
// throw here rather than propagated as a bare string into the UI.

interface Envelope<T> {
  data: T;
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function decodeSearchItem(raw: unknown): ContributorSearchItem {
  const item = raw as {
    handle: string;
    href: string;
    displayName: string;
    workCount: number;
    workExamples?: Array<{ title: string; href: string }> | null;
    matchedAlias?: string | null;
  };
  return {
    handle: parseContributorHandle(item.handle),
    href: item.href,
    displayName: item.displayName,
    workCount: item.workCount,
    workExamples: Array.isArray(item.workExamples)
      ? item.workExamples.map((example) => ({ title: example.title, href: example.href }))
      : [],
    matchedAlias: item.matchedAlias ?? null,
  };
}

function decodeDetail(raw: unknown): ContributorDetail {
  const detail = raw as {
    handle: string;
    href: string;
    displayName: string;
    otherNames?: string[] | null;
    canRename: boolean;
  };
  return {
    handle: parseContributorHandle(detail.handle),
    href: detail.href,
    displayName: detail.displayName,
    otherNames: Array.isArray(detail.otherNames) ? detail.otherNames : [],
    canRename: Boolean(detail.canRename),
  };
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
  const response = await apiFetch<Envelope<{ contributors?: unknown[]; nextCursor?: string | null }>>(
    path,
    { cache: "no-store", signal: options.signal },
  );
  return {
    contributors: Array.isArray(response.data.contributors)
      ? response.data.contributors.map(decodeSearchItem)
      : [],
    nextCursor: response.data.nextCursor ?? null,
  };
}

export async function fetchContributorDetail(handle: string): Promise<ContributorDetail> {
  const response = await apiFetch<Envelope<unknown>>(
    `/api/contributors/${encode(handle)}` as ApiPath,
    { cache: "no-store" },
  );
  return decodeDetail(response.data);
}

export interface ContributorWorksOptions {
  cursor?: string;
  limit?: number;
}

export async function fetchContributorWorks(
  handle: string,
  options: ContributorWorksOptions = {},
): Promise<ContributorWorkPage> {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const suffix = params.toString();
  const path = `/api/contributors/${encode(handle)}/works${suffix ? `?${suffix}` : ""}` as ApiPath;
  const response = await apiFetch<Envelope<{ works: unknown; nextCursor: unknown }>>(path, {
    cache: "no-store",
  });
  return {
    works: expectArray(
      response.data.works,
      decodeContributorWorkItem,
      "ContributorWorkPage.works",
    ),
    nextCursor: expectNullableString(
      response.data.nextCursor,
      "ContributorWorkPage.nextCursor",
    ),
  };
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

export async function patchContributorDisplayName(
  handle: string,
  body: ContributorRenameBody,
): Promise<ContributorDetail> {
  const response = await apiFetch<Envelope<unknown>>(
    `/api/contributors/${encode(handle)}` as ApiPath,
    { method: "PATCH", body: JSON.stringify(body) },
  );
  return decodeDetail(response.data);
}
