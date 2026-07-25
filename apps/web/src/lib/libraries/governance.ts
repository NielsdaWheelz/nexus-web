"use client";

import { apiCommand204, apiFetch } from "@/lib/api/client";
import {
  LibraryContractDefect,
  expectLibraryInvitation,
  expectLibraryInvitationsPage,
  expectLibraryMember,
  expectLibraryMembersPage,
  expectLibraryOutEnvelopeForId,
  expectViewerLibraryInvitations,
  type LibraryGovernanceCursor,
  type LibraryGovernancePage,
  type LibraryInvitation,
  type LibraryMember,
  type LibraryOut,
  type LibraryRole,
  type ViewerLibraryInvitation,
} from "@/lib/libraries/contract";
import {
  expectLibraryInvitationHandle,
  expectUserHandle,
} from "@/lib/sharing/wireValidation";
import { isRecord } from "@/lib/validation";

export const LIBRARY_GOVERNANCE_PAGE_LIMIT = 100;

function exactRecord(
  raw: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new LibraryContractDefect(`${name} must be an object`);
  }
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new LibraryContractDefect(
      `${name} has keys [${actual.join(", ")}], expected [${expected.join(", ")}]`,
    );
  }
  return raw;
}

function responseData(raw: unknown, name: string): unknown {
  return exactRecord(raw, name, ["data"]).data;
}

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
  return expectLibraryMembersPage(
    await apiFetch<unknown>(
      governancePagePath(input.libraryId, "members", input),
      { signal: input.signal },
    ),
  );
}

export async function listPendingLibraryInvites(input: {
  libraryId: string;
  cursor?: LibraryGovernanceCursor;
  limit?: number;
  signal?: AbortSignal;
}): Promise<LibraryGovernancePage<LibraryInvitation>> {
  const page = expectLibraryInvitationsPage(
    await apiFetch<unknown>(
      governancePagePath(input.libraryId, "invites", input),
      { signal: input.signal },
    ),
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
  return expectViewerLibraryInvitations(
    await apiFetch<unknown>("/api/libraries/invites", {
      cache: "no-store",
      signal,
    }),
  );
}

export async function acceptLibraryInvite(
  invitationHandle: string,
): Promise<LibraryInvitation> {
  const handle = expectLibraryInvitationHandle(
    invitationHandle,
    "accept invite.invitationHandle",
  );
  const data = exactRecord(
    responseData(
      await apiFetch<unknown>(
        `/api/libraries/invites/${encodeURIComponent(handle)}/accept`,
        { method: "POST" },
      ),
      "accept invite response",
    ),
    "accept invite response.data",
    ["invite", "membership", "idempotent"],
  );
  const membership = exactRecord(
    data.membership,
    "accept invite response.data.membership",
    ["libraryId", "userHandle", "role"],
  );
  if (
    typeof membership.libraryId !== "string" ||
    membership.libraryId.length === 0
  ) {
    throw new LibraryContractDefect(
      "accept invite response.data.membership.libraryId must be a non-empty string",
    );
  }
  if (
    typeof membership.userHandle !== "string" ||
    membership.userHandle.length === 0
  ) {
    throw new LibraryContractDefect(
      "accept invite response.data.membership.userHandle must be a non-empty string",
    );
  }
  if (membership.role !== "admin" && membership.role !== "member") {
    throw new LibraryContractDefect(
      "accept invite response.data.membership.role is invalid",
    );
  }
  if (typeof data.idempotent !== "boolean") {
    throw new LibraryContractDefect(
      "accept invite response.data.idempotent must be a boolean",
    );
  }
  const invitation = expectLibraryInvitation(
    data.invite,
    "accept invite response.data.invite",
  );
  if (
    invitation.invitationHandle !== handle ||
    invitation.status !== "accepted" ||
    invitation.libraryId !== membership.libraryId ||
    invitation.inviteeUserHandle !== membership.userHandle ||
    invitation.role !== membership.role
  ) {
    throw new LibraryContractDefect(
      "accept invite response projections do not correlate",
    );
  }
  return invitation;
}

export async function declineLibraryInvite(
  invitationHandle: string,
): Promise<LibraryInvitation> {
  const handle = expectLibraryInvitationHandle(
    invitationHandle,
    "decline invite.invitationHandle",
  );
  const data = exactRecord(
    responseData(
      await apiFetch<unknown>(
        `/api/libraries/invites/${encodeURIComponent(handle)}/decline`,
        { method: "POST" },
      ),
      "decline invite response",
    ),
    "decline invite response.data",
    ["invite", "idempotent"],
  );
  if (typeof data.idempotent !== "boolean") {
    throw new LibraryContractDefect(
      "decline invite response.data.idempotent must be a boolean",
    );
  }
  const invitation = expectLibraryInvitation(
    data.invite,
    "decline invite response.data.invite",
  );
  if (
    invitation.invitationHandle !== handle ||
    invitation.status !== "declined"
  ) {
    throw new LibraryContractDefect(
      "decline invite response does not correlate to its command",
    );
  }
  return invitation;
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
  const invitation = expectLibraryInvitation(
    responseData(
      await apiFetch<unknown>(
        `/api/libraries/${encodeURIComponent(input.libraryId)}/invites`,
        {
          method: "POST",
          body: JSON.stringify({
            invitee: { kind: "User", userHandle },
            role: input.role,
          }),
        },
      ),
      "create invite response",
    ),
    "create invite response.data",
  );
  if (
    invitation.libraryId !== input.libraryId ||
    invitation.inviteeUserHandle !== userHandle ||
    invitation.role !== input.role
  ) {
    throw new LibraryContractDefect(
      "create invite response does not correlate to its command",
    );
  }
  return invitation;
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
  const member = expectLibraryMember(
    responseData(
      await apiFetch<unknown>(
        `/api/libraries/${encodeURIComponent(input.libraryId)}/members/${encodeURIComponent(userHandle)}`,
        { method: "PATCH", body: JSON.stringify({ role: input.role }) },
      ),
      "update member response",
    ),
    "update member response.data",
  );
  if (member.userHandle !== userHandle || member.role !== input.role) {
    throw new LibraryContractDefect(
      "update member response does not correlate to its command",
    );
  }
  return member;
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
  const library = expectLibraryOutEnvelopeForId(
    await apiFetch<unknown>(
      `/api/libraries/${encodeURIComponent(input.libraryId)}/transfer-ownership`,
      {
        method: "POST",
        body: JSON.stringify({ newOwnerUserHandle }),
      },
    ),
    input.libraryId,
    "transfer ownership response",
  );
  if (library.ownerUserHandle !== newOwnerUserHandle) {
    throw new LibraryContractDefect(
      "transfer ownership response does not identify the requested owner",
    );
  }
  return library;
}
