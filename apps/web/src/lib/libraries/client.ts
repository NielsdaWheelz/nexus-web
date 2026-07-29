"use client";

import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { librariesResource } from "@/lib/api/resource";
import {
  decodeCollectionPage,
  decodeCollectionRevision,
  type CollectionCursor,
  type CollectionPage,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import {
  expectLibraryOut,
  expectLibraryOutEnvelopeForId,
  isLibraryContractDefect,
  type LibraryOut,
} from "@/lib/libraries/contract";
import {
  expectExactRecord,
  expectString,
  isRecord,
} from "@/lib/validation";

export class LibraryDestinationContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: malformed same-system destination payloads violate the
    // owned library picker contract and cannot be modeled as user failure.
    super(message);
    this.name = "LibraryDestinationContractDefect";
  }
}

export function isLibraryDestinationDefect(error: unknown): boolean {
  return (
    error instanceof LibraryDestinationContractDefect ||
    isLibraryContractDefect(error) ||
    isSameSystemApiDefect(error) ||
    (!isApiError(error) &&
      !(error instanceof TypeError) &&
      !(error instanceof DOMException))
  );
}

export interface LibraryDestination {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export type LibraryDestinationSelection = Pick<
  LibraryDestination,
  "id" | "name" | "color"
>;

export interface LibraryDestinationPage {
  data: LibraryDestination[];
  page: {
    has_more: boolean;
    next_cursor: string | null;
  };
}

export type MemberLibrary = LibraryOut;

export async function listMemberLibraries({
  limit = 200,
  signal,
}: {
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<MemberLibrary[]> {
  const libraries: MemberLibrary[] = [];
  let cursor: CollectionCursor | undefined;
  let collectionRevision: CollectionRevision | undefined;
  do {
    const response = await fetchLibrariesPage({
      cursor,
      collectionRevision,
      limit,
      signal,
    });
    libraries.push(...response.items);
    collectionRevision = response.collectionRevision;
    cursor =
      response.nextCursor.kind === "Present"
        ? response.nextCursor.value
        : undefined;
  } while (cursor !== undefined);
  return libraries;
}

export async function fetchLibrariesPage({
  cursor,
  collectionRevision,
  limit = 100,
  signal,
}: {
  cursor?: CollectionCursor;
  collectionRevision?: CollectionRevision;
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<CollectionPage<MemberLibrary>> {
  return decodeLibrariesPage(
    await apiFetch<unknown>(
      librariesResource.clientPath({
        refreshVersion: 0,
        cursor,
        collectionRevision,
        limit,
      }),
      { signal },
    ),
  );
}

export async function searchWritableLibraryDestinations({
  q = "",
  cursor,
  limit = 25,
  signal,
}: {
  q?: string;
  cursor?: string | null;
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<LibraryDestinationPage> {
  const params = new URLSearchParams();
  const query = q.trim();
  if (query) params.set("q", query);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(limit));
  const suffix = params.toString();
  const response = await apiFetch<unknown>(
    `/api/libraries/writable-destinations${suffix ? `?${suffix}` : ""}`,
    { signal },
  );
  return decodeWritableLibraryDestinationPage(response);
}

export async function createLibrary({
  libraryId,
  name,
  signal,
}: {
  libraryId: string;
  name: string;
  signal?: AbortSignal;
}): Promise<MemberLibrary> {
  const response = await apiFetch<unknown>("/api/libraries", {
    method: "POST",
    body: JSON.stringify({ library_id: libraryId, name }),
    signal,
  });
  return expectLibraryOutEnvelopeForId(
    response,
    libraryId,
    "create Library response",
  );
}

export async function getMemberLibrary(
  libraryId: string,
  signal?: AbortSignal,
): Promise<LibraryOut> {
  return expectLibraryOutEnvelopeForId(
    await apiFetch<unknown>(`/api/libraries/${encodeURIComponent(libraryId)}`, {
      signal,
    }),
    libraryId,
    "get Library response",
  );
}

export async function deleteMemberLibrary(
  libraryId: string,
): Promise<CollectionRevision> {
  const envelope = expectExactRecord(
    await apiFetch<unknown>(
      `/api/libraries/${encodeURIComponent(libraryId)}`,
      { method: "DELETE" },
    ),
    ["data"],
    "delete Library response",
  );
  const data = expectExactRecord(
    envelope.data,
    ["libraryId", "collectionRevision"],
    "delete Library response.data",
  );
  if (
    expectString(data.libraryId, "delete Library response.data.libraryId") !==
    libraryId
  ) {
    throw new TypeError("delete Library response identity does not match request");
  }
  return decodeCollectionRevision(data.collectionRevision);
}

export async function renameMemberLibrary(
  libraryId: string,
  name: string,
): Promise<{
  readonly library: MemberLibrary;
  readonly collectionRevision: CollectionRevision;
}> {
  const envelope = expectExactRecord(
    await apiFetch<unknown>(
      `/api/libraries/${encodeURIComponent(libraryId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name }),
      },
    ),
    ["data"],
    "rename Library response",
  );
  const data = expectExactRecord(
    envelope.data,
    ["library", "collectionRevision"],
    "rename Library response.data",
  );
  const library = expectLibraryOut(
    data.library,
    "rename Library response.data.library",
  );
  if (library.id !== libraryId) {
    throw new TypeError("rename Library response identity does not match request");
  }
  return {
    library,
    collectionRevision: decodeCollectionRevision(data.collectionRevision),
  };
}

export function decodeLibrariesPage(
  raw: unknown,
): CollectionPage<MemberLibrary> {
  return decodeCollectionPage(raw, (row, index) =>
    expectLibraryOut(row, `LibraryOut items[${index}]`),
  );
}

export function decodeWritableLibraryDestinationPage(
  raw: unknown,
): LibraryDestinationPage {
  if (!isRecord(raw) || !Array.isArray(raw.data) || !isRecord(raw.page)) {
    return invalidDestinationResponse(
      "search payload must contain data and page objects",
    );
  }

  const hasMore = raw.page.has_more;
  const nextCursor = raw.page.next_cursor;
  if (typeof hasMore !== "boolean") {
    return invalidDestinationResponse("page.has_more must be a boolean");
  }
  if (
    nextCursor !== null &&
    (typeof nextCursor !== "string" || nextCursor.length === 0)
  ) {
    return invalidDestinationResponse(
      "page.next_cursor must be a non-empty string or null",
    );
  }
  if (hasMore !== (nextCursor !== null)) {
    return invalidDestinationResponse(
      "page.has_more must agree with page.next_cursor",
    );
  }

  return {
    data: raw.data.map((value, index) =>
      decodeLibraryDestination(value, `data[${index}]`),
    ),
    page: { has_more: hasMore, next_cursor: nextCursor },
  };
}

function decodeLibraryDestination(
  raw: unknown,
  field: string,
): LibraryDestination {
  if (!isRecord(raw)) {
    return invalidDestinationResponse(`${field} must be an object`);
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) {
    return invalidDestinationResponse(`${field}.id must be a non-empty string`);
  }
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    return invalidDestinationResponse(
      `${field}.name must be a non-empty string`,
    );
  }
  if (raw.color !== null && typeof raw.color !== "string") {
    return invalidDestinationResponse(
      `${field}.color must be a string or null`,
    );
  }
  if (typeof raw.created_at !== "string" || raw.created_at.length === 0) {
    return invalidDestinationResponse(
      `${field}.created_at must be a non-empty string`,
    );
  }
  if (typeof raw.updated_at !== "string" || raw.updated_at.length === 0) {
    return invalidDestinationResponse(
      `${field}.updated_at must be a non-empty string`,
    );
  }
  return {
    id: raw.id,
    name: raw.name,
    color: raw.color,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

function invalidDestinationResponse(message: string): never {
  throw new LibraryDestinationContractDefect(
    `Invalid library destination response: ${message}.`,
  );
}
