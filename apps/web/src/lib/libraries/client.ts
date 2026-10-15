"use client";

import {
  apiCommand204,
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { librariesResource } from "@/lib/api/resource";
import type { ListPage } from "@/lib/api/useServerList";
import type { ApiJson } from "@/lib/api/wire";
import {
  libraryOutForId,
  isLibraryContractDefect,
  type LibraryOut,
} from "@/lib/libraries/contract";
import {
  LibraryDestinationContractDefect,
  type LibraryDestinationSelection,
} from "@/lib/libraries/destinationContract";
import {
  CANONICAL_LIBRARIES_INDEX_VIEW,
  type LibrariesIndexView,
} from "@/lib/libraries/libraryIndexView";

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

type MemberLibrary = LibraryOut;

/** Every library the viewer belongs to, in the canonical order. */
export async function listMemberLibraries({
  signal,
}: { signal?: AbortSignal } = {}): Promise<MemberLibrary[]> {
  const libraries: MemberLibrary[] = [];
  let cursor: string | null = null;
  do {
    const page = await fetchLibrariesPage({
      view: CANONICAL_LIBRARIES_INDEX_VIEW,
      cursor,
      limit: 200,
      signal,
    });
    libraries.push(...page.items);
    cursor = page.nextCursor.kind === "Present" ? page.nextCursor.value : null;
  } while (cursor !== null);
  return libraries;
}

export async function fetchLibrariesPage({
  view,
  cursor,
  limit,
  signal,
}: {
  // Required: every page of the index names the exact view it belongs to.
  view: LibrariesIndexView;
  cursor: string | null;
  limit: number;
  signal?: AbortSignal;
}): Promise<ListPage<MemberLibrary>> {
  const response = await apiFetch<ApiJson<"/libraries", "get">>(
    librariesResource.clientPath({ view, cursor: cursor ?? undefined, limit }),
    { signal },
  );
  return response.data;
}

export async function listWritableLibraryDestinations({
  signal,
}: {
  signal?: AbortSignal;
} = {}): Promise<LibraryDestinationSelection[]> {
  const response = await apiFetch<ApiJson<"/libraries/writable-destinations", "get">>(
    "/api/libraries/writable-destinations",
    { signal },
  );
  return response.data;
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
  const response = await apiFetch<ApiJson<"/libraries", "post">>(
    "/api/libraries",
    {
      method: "POST",
      body: JSON.stringify({ library_id: libraryId, name }),
      signal,
    },
  );
  const library = libraryOutForId(response.data, libraryId, "create Library response.data");
  publishChange("Libraries");
  return library;
}

export async function getMemberLibrary(
  libraryId: string,
  signal?: AbortSignal,
): Promise<LibraryOut> {
  const response = await apiFetch<ApiJson<"/libraries/{library_id}", "get">>(
    `/api/libraries/${encodeURIComponent(libraryId)}`,
    { signal },
  );
  return libraryOutForId(response.data, libraryId, "get Library response.data");
}

export async function deleteMemberLibrary(libraryId: string): Promise<void> {
  await apiCommand204(`/api/libraries/${encodeURIComponent(libraryId)}`, {
    method: "DELETE",
  });
  // Deletion also removes the library's entries from every member's Default.
  publishChange("Libraries", "Entries");
}

export async function renameMemberLibrary(
  libraryId: string,
  name: string,
): Promise<MemberLibrary> {
  const { data } = await apiFetch<ApiJson<"/libraries/{library_id}", "patch">>(
    `/api/libraries/${encodeURIComponent(libraryId)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
  );
  publishChange("Libraries");
  return libraryOutForId(data, libraryId, "rename Library response.data");
}
