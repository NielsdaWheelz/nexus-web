"use client";

import { apiCommand204, apiFetch } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import {
  LibraryContractDefect,
  libraryOutForId,
  type LibraryGovernanceCursor,
  type LibraryGovernancePage,
  type LibraryInvitation,
  type LibraryMember,
  type LibraryOut,
  type LibraryRole,
  type ViewerLibraryInvitation,
} from "@/lib/libraries/contract";
import { publishLibraryPlacementChange } from "@/lib/libraries/placementRevision";
import {
  expectLibraryInvitationHandle,
  expectUserHandle,
} from "@/lib/sharing/wireValidation";

export const LIBRARY_GOVERNANCE_PAGE_LIMIT = 100;

function governancePagePath(
  libraryId: string,
  endpoint: "members" | "invites",
  input: {
    cursor?: LibraryGovernanceCursor;
    limit?: number;
  },
): `/api/${string}` {
  const params = new URLSearchParams();
  if (endpoint === "invites") params.set("status", "pending");
  params.set("limit", String(input.limit ?? LIBRARY_GOVERNANCE_PAGE_LIMIT));
  if (input.cursor) params.set("cursor", input.cursor);
  return `/api/libraries/${encodeURIComponent(libraryId)}/${endpoint}?${params.toString()}`;
}

export async function listLibraryMembers(input: {
  libraryId: string;
  cursor?: LibraryGovernanceCursor;
  limit?: number;
  signal?: AbortSignal;
}): Promise<LibraryGovernancePage<LibraryMember>> {
  return apiFetch<ApiJson<"/libraries/{library_id}/members", "get">>(
    governancePagePath(input.libraryId, "members", input),
    { signal: input.signal },
  );
}

export async function listPendingLibraryInvites(input: {
  libraryId: string;
  cursor?: LibraryGovernanceCursor;
  limit?: number;
  signal?: AbortSignal;
}): Promise<LibraryGovernancePage<LibraryInvitation>> {
  const page = await apiFetch<ApiJson<"/libraries/{library_id}/invites", "get">>(
    governancePagePath(input.libraryId, "invites", input),
    { signal: input.signal },
  );
  for (const invitation of page.data) {
    if (
      invitation.libraryId !== input.libraryId ||
      invitation.status !== "pending"
    ) {
      throw new LibraryContractDefect(
        "pending invitation page contains a row outside its requested Library/status scope",
      );
    }
  }
  return page;
}

export async function fetchViewerLibraryInvites(
  signal?: AbortSignal,
): Promise<ViewerLibraryInvitation[]> {
  const response = await apiFetch<ApiJson<"/libraries/invites", "get">>(
    "/api/libraries/invites",
    { cache: "no-store", signal },
  );
  return response.data;
}

export async function acceptLibraryInvite(
  invitationHandle: string,
): Promise<LibraryInvitation> {
  const handle = expectLibraryInvitationHandle(
    invitationHandle,
    "accept invite.invitationHandle",
  );
  const response = await apiFetch<ApiJson<"/libraries/invites/{invitation_handle}/accept", "post">>(
    `/api/libraries/invites/${encodeURIComponent(handle)}/accept`,
    { method: "POST" },
  );
  publishLibraryPlacementChange("Unknown");
  return response.data.invite;
}

export async function declineLibraryInvite(
  invitationHandle: string,
): Promise<LibraryInvitation> {
  const handle = expectLibraryInvitationHandle(
    invitationHandle,
    "decline invite.invitationHandle",
  );
  const response = await apiFetch<ApiJson<"/libraries/invites/{invitation_handle}/decline", "post">>(
    `/api/libraries/invites/${encodeURIComponent(handle)}/decline`,
    { method: "POST" },
  );
  return response.data.invite;
}

export async function createLibraryInvite(input: {
  libraryId: string;
  userHandle: string;
  role: LibraryRole;
}): Promise<LibraryInvitation> {
  const userHandle = expectUserHandle(
    input.userHandle,
    "create invite.userHandle",
  );
  const response = await apiFetch<ApiJson<"/libraries/{library_id}/invites", "post">>(
    `/api/libraries/${encodeURIComponent(input.libraryId)}/invites`,
    {
      method: "POST",
      body: JSON.stringify({
        invitee: { kind: "User", userHandle },
        role: input.role,
      }),
    },
  );
  return response.data;
}

export async function updateLibraryMemberRole(input: {
  libraryId: string;
  userHandle: string;
  role: LibraryRole;
}): Promise<LibraryMember> {
  const userHandle = expectUserHandle(
    input.userHandle,
    "update member.userHandle",
  );
  const response = await apiFetch<ApiJson<"/libraries/{library_id}/members/{user_handle}", "patch">>(
    `/api/libraries/${encodeURIComponent(input.libraryId)}/members/${encodeURIComponent(userHandle)}`,
    { method: "PATCH", body: JSON.stringify({ role: input.role }) },
  );
  return response.data;
}

export async function removeLibraryMember(input: {
  libraryId: string;
  userHandle: string;
}): Promise<void> {
  const userHandle = expectUserHandle(
    input.userHandle,
    "remove member.userHandle",
  );
  await apiCommand204(
    `/api/libraries/${encodeURIComponent(input.libraryId)}/members/${encodeURIComponent(userHandle)}`,
    { method: "DELETE" },
  );
}

export async function revokeLibraryInvite(
  invitationHandle: string,
): Promise<void> {
  const handle = expectLibraryInvitationHandle(
    invitationHandle,
    "revoke invite.invitationHandle",
  );
  await apiCommand204(
    `/api/libraries/invites/${encodeURIComponent(handle)}`,
    { method: "DELETE" },
  );
}

export async function transferLibraryOwnership(input: {
  libraryId: string;
  newOwnerUserHandle: string;
}): Promise<LibraryOut> {
  const newOwnerUserHandle = expectUserHandle(
    input.newOwnerUserHandle,
    "transfer ownership.newOwnerUserHandle",
  );
  const response = await apiFetch<ApiJson<"/libraries/{library_id}/transfer-ownership", "post">>(
    `/api/libraries/${encodeURIComponent(input.libraryId)}/transfer-ownership`,
    {
      method: "POST",
      body: JSON.stringify({ newOwnerUserHandle }),
    },
  );
  return libraryOutForId(
    response.data, input.libraryId, "transfer ownership response.data",
  );
}
