"use client";

import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { librariesResource } from "@/lib/api/resource";
import type { ApiJson } from "@/lib/api/wire";
import {
  decodeCollectionRevision,
  type CollectionCursor,
  type CollectionPage,
  type CollectionRevision,
} from "@/lib/api/collectionPage";
import {
  libraryOutForId,
  librariesPageFromWire,
  isLibraryContractDefect,
  type LibraryOut,
} from "@/lib/libraries/contract";
import {
  LibraryDestinationContractDefect,
  type LibraryDestinationPage,
} from "@/lib/libraries/destinationContract";
import {
  CANONICAL_LIBRARIES_INDEX_VIEW,
  type LibrariesIndexView,
} from "@/lib/libraries/libraryIndexView";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";

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
      view: CANONICAL_LIBRARIES_INDEX_VIEW,
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
  view,
  cursor,
  collectionRevision,
  limit = 100,
  signal,
}: {
  // Required: every page of the index names the exact view it belongs to.
  view: LibrariesIndexView;
  cursor?: CollectionCursor;
  collectionRevision?: CollectionRevision;
  limit?: number;
  signal?: AbortSignal;
}): Promise<CollectionPage<MemberLibrary>> {
  const response = await apiFetch<ApiJson<"/libraries", "get">>(
    librariesResource.clientPath({
      refreshVersion: 0,
      view,
      cursor,
      collectionRevision,
      limit,
    }),
    { signal },
  );
  return librariesPageFromWire(response.data);
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
  const response = await apiFetch<ApiJson<"/libraries/writable-destinations", "get">>(
    `/api/libraries/writable-destinations${suffix ? `?${suffix}` : ""}`,
    { signal },
  );
  if (response.page.has_more !== (response.page.next_cursor !== null)) {
    throw new LibraryDestinationContractDefect(
      "Invalid library destination response: page.has_more must agree with page.next_cursor.",
    );
  }
  return response;
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
  // A new library is a new row in an open Libraries index or placement editor,
  // and both reread on an Unknown change.
  publishLibraryPlacementChange("Unknown");
  return response.data;
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

export async function deleteMemberLibrary(
  libraryId: string,
): Promise<CollectionRevision> {
  const { data } = await apiFetch<ApiJson<"/libraries/{library_id}", "delete">>(
    `/api/libraries/${encodeURIComponent(libraryId)}`,
    { method: "DELETE" },
  );
  if (data.libraryId !== libraryId) {
    throw new TypeError("delete Library response identity does not match request");
  }
  const collectionRevision = decodeCollectionRevision(data.collectionRevision);
  // Library deletion changes placement reachability for every former member.
  // Publish only after the complete same-system response has decoded so direct
  // canonical Delete and Settings Delete share one exact completion boundary.
  publishLibraryPlacementChange("Unknown");
  return collectionRevision;
}

export async function renameMemberLibrary(
  libraryId: string,
  name: string,
): Promise<{
  readonly library: MemberLibrary;
  readonly collectionRevision: CollectionRevision;
}> {
  const { data } = await apiFetch<ApiJson<"/libraries/{library_id}", "patch">>(
    `/api/libraries/${encodeURIComponent(libraryId)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
  );
  const library = data.library;
  if (library.id !== libraryId) {
    throw new TypeError("rename Library response identity does not match request");
  }
  // A Library name is presented by the Libraries index and every placement
  // editor. Reuse the domain's broad revision so all mounted projections
  // authoritatively refresh after this committed rename.
  publishLibraryPlacementChange("Unknown");
  return {
    library,
    collectionRevision: decodeCollectionRevision(data.collectionRevision),
  };
}
