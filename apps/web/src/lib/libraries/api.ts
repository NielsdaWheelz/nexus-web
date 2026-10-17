"use client";

// Typed calls for libraries, their entries, placements, destinations, members and
// invitations, on the generated wire types. A committed write publishes the change
// topics it moved for the viewer; readers reread. Retry rules (the server's
// contract): a create or an invitation resends its client id, a rename or a role
// change carries the value it expects to replace; moves carry the collection's
// revision and cannot be rebased by a retry. Deletes, placements,
// leaving, revoking and answering are absolute, so resending one that already
// landed changes nothing.

import { ApiError, apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { pageQuery, type ListPage } from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { Move, Snapshot } from "@/lib/collections/order";

export type Library = Schema<"LibraryOut">;
export type LibraryEntry =
  | Schema<"LibraryMediaEntryOut">
  | Schema<"LibraryPodcastEntryOut">;
export type LibraryPlacement = Schema<"LibraryPlacementOut">;
export type LibraryDestination = Schema<"LibraryDestinationOut">;
export type LibraryMember = Schema<"LibraryMemberOut">;
export type LibraryInvitation = Schema<"LibraryInvitationOut">;
export type ViewerInvitation = Schema<"ViewerInvitationOut">;
export type LibraryRole = LibraryMember["role"];
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

export async function createLibrary(
  input: { readonly id: string; readonly name: string },
  signal?: AbortSignal,
): Promise<Library> {
  const response = await apiFetch<{ data: Library }>("/api/libraries", {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
  if (response.data.id !== input.id) {
    throw new ApiError(200, "E_INVALID_RESPONSE", "Created library id did not match its request");
  }
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
  return data<Schema<"LibraryEntriesPageOut">>(
    `${libraryPath(id)}/entries?${query}`,
    signal,
  );
}

export async function libraryOrder(libraryId: string, signal: AbortSignal): Promise<Snapshot> {
  const result = await data<Schema<"LibraryOrderOut">>(`${libraryPath(libraryId)}/order`, signal);
  return { revision: result.order_revision, ids: result.entry_ids };
}

/** Strict move. Its owner accepts the answer before publishing Entries. */
export async function moveEntry(
  libraryId: string,
  move: Move,
  signal: AbortSignal,
): Promise<Snapshot> {
  const { data } = await apiFetch<ApiJson<"/libraries/{library_id}/entries/{entry_id}/position", "put">>(`${libraryPath(libraryId)}/entries/${move.itemId}/position`, {
    method: "PUT",
    signal,
    body: JSON.stringify({ before_entry_id: move.beforeId,
      expected_order_revision: move.expectedRevision }),
  });
  return { revision: data.order_revision, ids: data.entry_ids };
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
  signal?: AbortSignal,
): Promise<void> {
  await apiFetch(itemPath(target, libraryId), {
    method: "PUT",
    body: JSON.stringify({ replace_episodes: replaceEpisodes }),
    signal,
  });
  publishChange("Entries");
}

export async function removePlacement(
  target: LibraryPlacementTarget,
  libraryId: string,
  signal?: AbortSignal,
): Promise<void> {
  await apiFetch(itemPath(target, libraryId), { method: "DELETE", signal });
  publishChange("Entries");
}

export function libraryDestinations(signal?: AbortSignal): Promise<LibraryDestination[]> {
  return data<LibraryDestination[]>("/api/libraries/destinations", signal);
}

function page<T>(path: string, cursor: string | null, limit: number, signal: AbortSignal) {
  return data<ListPage<T>>(`/api/libraries/${path}?${pageQuery("", cursor, limit)}`, signal);
}

export const membersPage = (id: string, cursor: string | null, limit: number, signal: AbortSignal) =>
  page<LibraryMember>(`${encodeURIComponent(id)}/members`, cursor, limit, signal);

/** A library's pending invitations, newest first. */
export const invitationsPage = (
  id: string,
  cursor: string | null,
  limit: number,
  signal: AbortSignal,
) => page<LibraryInvitation>(`${encodeURIComponent(id)}/invites`, cursor, limit, signal);

/** The invitations waiting for the viewer, newest first. */
export const viewerInvitationsPage = (cursor: string | null, limit: number, signal: AbortSignal) =>
  page<ViewerInvitation>("invites", cursor, limit, signal);

export async function invite(
  libraryId: string,
  body: Schema<"CreateInvitationRequest">,
): Promise<void> {
  await apiFetch(`${libraryPath(libraryId)}/invites`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function setMemberRole(
  libraryId: string,
  userId: string,
  role: LibraryRole,
  expectedRole: LibraryRole,
): Promise<void> {
  await apiFetch(`${libraryPath(libraryId)}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ role, expected_role: expectedRole }),
  });
}

/** Removing the viewer's own row is leaving, so their libraries and All may change. */
export async function removeMember(libraryId: string, userId: string): Promise<void> {
  await apiFetch(`${libraryPath(libraryId)}/members/${userId}`, { method: "DELETE" });
  publishChange("Libraries", "Entries");
}

export async function leaveLibrary(id: string): Promise<void> {
  await apiFetch(`${libraryPath(id)}/membership`, { method: "DELETE" });
  publishChange("Libraries", "Entries");
}

/** The viewer stays an admin; the new owner may delete and transfer. */
export async function transferOwnership(libraryId: string, userId: string): Promise<void> {
  await apiFetch(`${libraryPath(libraryId)}/transfer-ownership`, {
    method: "POST",
    body: JSON.stringify({ user_id: userId }),
  });
  publishChange("Libraries");
}

export async function revokeInvitation(id: string): Promise<void> {
  await apiFetch(`/api/libraries/invites/${id}`, { method: "DELETE" });
}

/** Accepting joins the library, so the viewer's libraries and All change. */
export async function respondToInvitation(id: string, accept: boolean): Promise<void> {
  await apiFetch(`/api/libraries/invites/${id}/${accept ? "accept" : "decline"}`, {
    method: "POST",
  });
  if (accept) publishChange("Libraries", "Entries");
}
