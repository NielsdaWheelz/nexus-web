"use client";

// Typed calls for libraries, their entries, placements and destinations, on the
// generated wire types. A committed write publishes its change topics; readers
// reread. Retry rules (the server's contract): a create resends its client id, a
// rename carries the name it expects to replace, and deletes, placements and
// moves are absolute, so resending one that already landed changes nothing.

import { apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import type { ListPage } from "@/lib/api/useServerList";
import type { Schema } from "@/lib/api/wire";

export type Library = Schema<"LibraryOut">;
export type LibraryEntry =
  | Schema<"LibraryMediaEntryOut">
  | Schema<"LibraryPodcastEntryOut">;
export type LibraryPlacement = Schema<"LibraryPlacementOut">;
export type LibraryDestination = Schema<"LibraryDestinationOut">;
export interface LibraryPlacementTarget {
  readonly kind: "Media" | "Podcast";
  readonly id: string;
}

const libraryPath = (id: string) =>
  `/api/libraries/${encodeURIComponent(id)}` as const;
const itemPath = (target: LibraryPlacementTarget, libraryId: string) =>
  `${libraryPath(libraryId)}/items/${target.kind === "Media" ? "media" : "podcast"}:${target.id}` as const;

async function data<T>(path: `/api/${string}`, signal?: AbortSignal) {
  return (await apiFetch<{ data: T }>(path, { signal })).data;
}

export function librariesPage(query: URLSearchParams, signal?: AbortSignal) {
  return data<ListPage<Library>>(`/api/libraries?${query}`, signal);
}

/** Every library the viewer belongs to, oldest first. */
export async function memberLibraries(signal?: AbortSignal) {
  const all: Library[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: "200" });
    if (cursor !== null) query.set("cursor", cursor);
    const page = await librariesPage(query, signal);
    all.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor !== null);
  return all;
}

export function getLibrary(id: string, signal?: AbortSignal) {
  return data<Library>(libraryPath(id), signal);
}

export async function createLibrary(input: {
  readonly id: string;
  readonly name: string;
}): Promise<Library> {
  const response = await apiFetch<{ data: Library }>("/api/libraries", {
    method: "POST",
    body: JSON.stringify(input),
  });
  publishChange("Libraries");
  return response.data;
}

export async function renameLibrary(
  id: string,
  name: string,
  expectedName: string,
): Promise<Library> {
  const response = await apiFetch<{ data: Library }>(libraryPath(id), {
    method: "PATCH",
    body: JSON.stringify({ name, expected_name: expectedName }),
  });
  publishChange("Libraries");
  return response.data;
}

export async function deleteLibrary(id: string): Promise<void> {
  await apiFetch(libraryPath(id), { method: "DELETE" });
  publishChange("Libraries", "Entries");
}

export function entriesPage(
  id: string,
  query: URLSearchParams,
  signal?: AbortSignal,
) {
  return data<ListPage<LibraryEntry>>(
    `${libraryPath(id)}/entries?${query}`,
    signal,
  );
}

/** Put an entry before another (null: last). */
export async function moveEntry(
  libraryId: string,
  entryId: string,
  beforeEntryId: string | null,
): Promise<void> {
  await apiFetch(`${libraryPath(libraryId)}/entries/${entryId}/position`, {
    method: "PUT",
    body: JSON.stringify({ before_entry_id: beforeEntryId }),
  });
  publishChange("Entries");
}

export function placements(
  target: LibraryPlacementTarget,
  signal?: AbortSignal,
) {
  const ref = `${target.kind === "Media" ? "media" : "podcast"}:${target.id}`;
  return data<LibraryPlacement[]>(`/api/libraries/placements/${ref}`, signal);
}

/** File a target into a library; the viewer's All is Saved in Nexus. */
export async function addPlacement(
  target: LibraryPlacementTarget,
  libraryId: string,
  replaceEpisodes = false,
): Promise<void> {
  await apiFetch(itemPath(target, libraryId), {
    method: "PUT",
    body: JSON.stringify({ replace_episodes: replaceEpisodes }),
  });
  publishChange("Entries");
}

export async function removePlacement(
  target: LibraryPlacementTarget,
  libraryId: string,
): Promise<void> {
  await apiFetch(itemPath(target, libraryId), { method: "DELETE" });
  publishChange("Entries");
}

export function destinationsPage(
  q: string,
  cursor: string | null,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ q, limit: "25" });
  if (cursor !== null) query.set("cursor", cursor);
  return data<ListPage<LibraryDestination>>(
    `/api/libraries/destinations?${query}`,
    signal,
  );
}
