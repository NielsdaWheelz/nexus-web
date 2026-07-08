"use client";

import { apiFetch } from "@/lib/api/client";
import { librariesResource } from "@/lib/api/resource";

export interface LibraryDestination {
  id: string;
  name: string;
  color: string | null;
  created_at: string;
  updated_at: string;
}

export interface LibraryDestinationPage {
  data: LibraryDestination[];
  page: {
    has_more: boolean;
    next_cursor: string | null;
  };
}

export interface MemberLibrary extends LibraryDestination {
  owner_user_id: string;
  is_default: boolean;
  role: "admin" | "member";
}

interface MemberLibrariesResponse {
  data: MemberLibrary[];
  page: {
    has_more: boolean;
    next_cursor: string | null;
  };
}

interface CreateLibraryResponse {
  data: {
    id: string;
    name: string;
    color: string | null;
    created_at: string;
    updated_at: string;
  };
}

const destinationById = new Map<string, LibraryDestination>();

function remember(destinations: LibraryDestination[]) {
  for (const destination of destinations) {
    destinationById.set(destination.id, destination);
  }
}

export function cachedLibraryDestinations(ids: string[]): LibraryDestination[] {
  return ids
    .map((id) => destinationById.get(id))
    .filter((destination): destination is LibraryDestination => Boolean(destination));
}

export async function listMemberLibraries({
  limit = 200,
  signal,
}: {
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<MemberLibrary[]> {
  const libraries: MemberLibrary[] = [];
  let cursor: string | null = null;
  do {
    const response: MemberLibrariesResponse = await apiFetch<MemberLibrariesResponse>(
      librariesResource.clientPath({
        refreshVersion: 0,
        limit,
        cursor: cursor ?? undefined,
      }),
      { signal },
    );
    remember(response.data);
    libraries.push(...response.data);
    cursor = response.page.next_cursor;
  } while (cursor !== null);
  return libraries;
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
  const page = await apiFetch<LibraryDestinationPage>(
    `/api/libraries/writable-destinations${suffix ? `?${suffix}` : ""}`,
    { signal },
  );
  remember(page.data);
  return page;
}

export async function createLibrary({
  name,
}: {
  name: string;
}): Promise<LibraryDestination> {
  const response = await apiFetch<CreateLibraryResponse>("/api/libraries", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  const destination = {
    id: response.data.id,
    name: response.data.name,
    color: response.data.color,
    created_at: response.data.created_at,
    updated_at: response.data.updated_at,
  };
  destinationById.set(destination.id, destination);
  return destination;
}
