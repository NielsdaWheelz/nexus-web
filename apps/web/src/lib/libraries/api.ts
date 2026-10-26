"use client";

// Typed calls for libraries, their entries, placements, destinations, members and
// invitations, on the generated wire types. A committed write publishes the change
// topics it moved for the viewer; readers reread. Retry rules (the server's
// contract): a create or an invitation resends its client id, a rename or a role
// change carries the value it expects to replace; moves carry the collection's
// revision and cannot be rebased by a retry. Placements carry exact library and removal revisions; a replay may conflict.
// Deletes, leaving, revoking and answering are absolute.

import { apiFetch } from "@/lib/api/client";
import { publishChange } from "@/lib/api/changes";
import { pageQuery, type ListPage } from "@/lib/api/useServerList";
import type { ApiJson, Schema } from "@/lib/api/wire";
import type { Move, Snapshot } from "@/lib/collections/order";
import { stampedRead, type StampedRead } from "@/lib/consumption/listening";

export type Library = Schema<"LibraryOut">;
export type LibraryEntry = Schema<"LibraryMediaEntryOut">;
export type LibraryPlacement = Schema<"LibraryPlacementOut">;
export type LibraryDestination = Schema<"LibraryDestinationOut">;
export type LibraryMember = Schema<"LibraryMemberOut">;
export type LibraryInvitation = Schema<"LibraryInvitationOut">;
export type ViewerInvitation = Schema<"ViewerInvitationOut">;
export type LibraryRole = LibraryMember["role"];
export interface LibraryPlacementTarget {
  readonly kind: "Media";
  readonly id: string;
}

const libraryPath = (id: string) =>
  `/api/libraries/${encodeURIComponent(id)}` as const;
const itemPath = (target: LibraryPlacementTarget, libraryId: string) =>
  `${libraryPath(libraryId)}/items/media:${target.id}` as const;

async function data<T>(path: `/api/${string}`, signal?: AbortSignal) {
  return (await apiFetch<{ data: T }>(path, { signal })).data;
}

export async function librariesIndex(query: URLSearchParams, signal?: AbortSignal) {
  return (await apiFetch<ApiJson<"/libraries", "get">>(`/api/libraries?${query}`, { signal })).data;
}

/** Stamped with its read snapshot's consumption revision; observations reach native. */
export async function getLibrary(id: string, signal?: AbortSignal): Promise<StampedRead<Library>> {
  return stampedRead(await apiFetch<ApiJson<"/libraries/{library_id}", "get">>(libraryPath(id), { signal }));
}

export async function createLibrary(
  input: Schema<"CreateLibraryRequest">,
  signal?: AbortSignal,
): Promise<Library> {
  const response = await apiFetch<{ data: Library }>("/api/libraries", {
    method: "POST",
    body: JSON.stringify(input),
    signal,
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

/** One atomic library, entry and podcast observation. */
export async function libraryEntriesIndex(
  id: string,
  query: URLSearchParams,
  signal?: AbortSignal,
) {
  return stampedRead(await apiFetch<ApiJson<"/libraries/{library_id}/entries", "get">>(
    `${libraryPath(id)}/entries?${query}`, { signal }));
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
  const ref = `media:${target.id}`;
  return data<Schema<"LibraryPlacementsOut">>(`/api/libraries/placements/${ref}`, signal);
}

/** One strict absolute command; retry retains every precondition. */
export async function setPlacement(
  target: LibraryPlacementTarget,
  libraryId: string,
  command: Schema<"PlaceItemRequest">,
  signal?: AbortSignal,
): Promise<LibraryPlacement> {
  const response = await apiFetch<{ data: LibraryPlacement }>(itemPath(target, libraryId), {
    method: "PUT", body: JSON.stringify(command), signal,
  });
  publishChange("Entries");
  return response.data;
}

export function libraryDestinations(signal?: AbortSignal) {
  return data<Schema<"LibraryDestinationsOut">>("/api/libraries/destinations", signal);
}

export type AcquisitionGuard = Pick<Schema<"ConfirmUploadRequest">, "expected_removal_revision" | "destinations">;

/** Selected revisions are what the reader reviewed, never a submission-time rebase. */
export function acquisitionGuard(selected: readonly LibraryDestination[], removalRevision: string): AcquisitionGuard {
  return {
    expected_removal_revision: removalRevision,
    destinations: selected.map(destination => ({ library_id: destination.id, expected_order_revision: destination.order_revision })),
  };
}

/** Initial submission only. The caller retains this snapshot through unknown outcomes. */
export async function readAcquisitionGuard(selected: readonly LibraryDestination[], signal?: AbortSignal): Promise<AcquisitionGuard> {
  return acquisitionGuard(selected, (await libraryDestinations(signal)).removal_revision);
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

/** Authenticated complete membership count, including all's visible union. */
export async function getLibraryMetadata(id: string, signal: AbortSignal) {
  return (await apiFetch<ApiJson<"/libraries/{library_id}/metadata", "get">>(`${libraryPath(id)}/metadata`, { signal })).data;
}
