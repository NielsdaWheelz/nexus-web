"use client";

import { apiFetch, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { librariesResource } from "@/lib/api/resource";
import { isRecord } from "@/lib/validation";

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
    const response: MemberLibrariesResponse =
      await apiFetch<MemberLibrariesResponse>(
        librariesResource.clientPath({
          refreshVersion: 0,
          limit,
          cursor: cursor ?? undefined,
        }),
        { signal },
      );
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
  const response = await apiFetch<unknown>(
    `/api/libraries/writable-destinations${suffix ? `?${suffix}` : ""}`,
    { signal },
  );
  return decodeWritableLibraryDestinationPage(response);
}

export async function createLibrary({
  name,
  signal,
}: {
  name: string;
  signal?: AbortSignal;
}): Promise<LibraryDestination> {
  const response = await apiFetch<unknown>("/api/libraries", {
    method: "POST",
    body: JSON.stringify({ name }),
    signal,
  });
  return decodeCreatedLibraryDestination(response);
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

export function decodeCreatedLibraryDestination(
  raw: unknown,
): LibraryDestination {
  if (!isRecord(raw) || !isRecord(raw.data)) {
    return invalidDestinationResponse(
      "create payload must contain a data object",
    );
  }
  return decodeLibraryDestination(raw.data, "data");
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
