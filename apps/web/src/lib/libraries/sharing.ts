"use client";

import { apiCommand204, apiFetch } from "@/lib/api/client";
import { isRecord } from "@/lib/validation";
import {
  expectLibraryInvitationHandle,
  expectUserHandle,
} from "@/lib/sharing/wireValidation";

export type LibraryRole = "admin" | "member";
export type LibraryInvitationStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "revoked";

export interface LibrarySharingTarget {
  id: string;
  name: string;
  ownerUserHandle: string;
  isDefault: boolean;
  systemKey: string | null;
  role: LibraryRole;
  canManageMembers: boolean;
  canTransferOwnership: boolean;
}

export interface LibraryMember {
  userHandle: string;
  role: LibraryRole;
  isOwner: boolean;
  email: string | null;
  displayName: string | null;
  createdAt: string;
}

export interface LibraryInvite {
  invitationHandle: string;
  libraryId: string;
  inviterUserHandle: string;
  inviteeUserHandle: string;
  role: LibraryRole;
  status: LibraryInvitationStatus;
  inviteeEmail: string | null;
  inviteeDisplayName: string | null;
  createdAt: string;
  respondedAt: string | null;
}

export interface ViewerLibraryInvite extends LibraryInvite {
  libraryName: string;
}

export interface UserSearchResult {
  userHandle: string;
  email: string | null;
  displayName: string | null;
}

export interface EditableLibrarySharing {
  library: LibrarySharingTarget;
  members: LibraryMember[];
  invites: LibraryInvite[];
}

export class LibrarySharingContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: malformed same-system governance payloads mean the
    // frontend and backend shipped different sealed-identity contracts.
    super(message);
    this.name = "LibrarySharingContractDefect";
  }
}

function exactRecord(
  raw: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(raw)) {
    throw new LibrarySharingContractDefect(`${name} must be an object`);
  }
  const actual = Object.keys(raw).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new LibrarySharingContractDefect(
      `${name} has keys [${actual.join(", ")}], expected [${expected.join(", ")}]`,
    );
  }
  return raw;
}

function text(raw: unknown, name: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new LibrarySharingContractDefect(`${name} must be a non-empty string`);
  }
  return raw;
}

function nullableText(raw: unknown, name: string): string | null {
  if (raw === null || typeof raw === "string") return raw;
  throw new LibrarySharingContractDefect(`${name} must be a string or null`);
}

function role(raw: unknown, name: string): LibraryRole {
  if (raw === "admin" || raw === "member") return raw;
  throw new LibrarySharingContractDefect(`${name} must be admin or member`);
}

function envelope(raw: unknown, name: string): unknown {
  return exactRecord(raw, name, ["data"]).data;
}

function decodeLibrary(raw: unknown): LibrarySharingTarget {
  const row = exactRecord(raw, "library", [
    "id",
    "name",
    "color",
    "ownerUserHandle",
    "isDefault",
    "role",
    "systemKey",
    "canRename",
    "canDelete",
    "canEditEntries",
    "canManageMembers",
    "canTransferOwnership",
    "createdAt",
    "updatedAt",
  ]);
  if (
    typeof row.isDefault !== "boolean" ||
    typeof row.canManageMembers !== "boolean" ||
    typeof row.canTransferOwnership !== "boolean"
  ) {
    throw new LibrarySharingContractDefect(
      "library sharing flags must be booleans",
    );
  }
  return {
    id: text(row.id, "library.id"),
    name: text(row.name, "library.name"),
    ownerUserHandle: expectUserHandle(
      row.ownerUserHandle,
      "library.ownerUserHandle",
    ),
    isDefault: row.isDefault,
    systemKey: nullableText(row.systemKey, "library.systemKey"),
    role: role(row.role, "library.role"),
    canManageMembers: row.canManageMembers,
    canTransferOwnership: row.canTransferOwnership,
  };
}

function decodeMember(raw: unknown, index: number): LibraryMember {
  const row = exactRecord(raw, `members[${index}]`, [
    "userHandle",
    "role",
    "isOwner",
    "email",
    "displayName",
    "createdAt",
  ]);
  if (typeof row.isOwner !== "boolean") {
    throw new LibrarySharingContractDefect(
      `members[${index}].isOwner must be boolean`,
    );
  }
  return {
    userHandle: expectUserHandle(
      row.userHandle,
      `members[${index}].userHandle`,
    ),
    role: role(row.role, `members[${index}].role`),
    isOwner: row.isOwner,
    email: nullableText(row.email, `members[${index}].email`),
    displayName: nullableText(
      row.displayName,
      `members[${index}].displayName`,
    ),
    createdAt: text(row.createdAt, `members[${index}].createdAt`),
  };
}

const INVITE_KEYS = [
  "invitationHandle",
  "libraryId",
  "inviterUserHandle",
  "inviteeUserHandle",
  "role",
  "status",
  "inviteeEmail",
  "inviteeDisplayName",
  "createdAt",
  "respondedAt",
] as const;

function decodeInviteFields(
  row: Record<string, unknown>,
  index: number,
): LibraryInvite {
  if (
    row.status !== "pending" &&
    row.status !== "accepted" &&
    row.status !== "declined" &&
    row.status !== "revoked"
  ) {
    throw new LibrarySharingContractDefect(
      `invites[${index}].status is invalid`,
    );
  }
  return {
    invitationHandle: expectLibraryInvitationHandle(
      row.invitationHandle,
      `invites[${index}].invitationHandle`,
    ),
    libraryId: text(row.libraryId, `invites[${index}].libraryId`),
    inviterUserHandle: expectUserHandle(
      row.inviterUserHandle,
      `invites[${index}].inviterUserHandle`,
    ),
    inviteeUserHandle: expectUserHandle(
      row.inviteeUserHandle,
      `invites[${index}].inviteeUserHandle`,
    ),
    role: role(row.role, `invites[${index}].role`),
    status: row.status,
    inviteeEmail: nullableText(
      row.inviteeEmail,
      `invites[${index}].inviteeEmail`,
    ),
    inviteeDisplayName: nullableText(
      row.inviteeDisplayName,
      `invites[${index}].inviteeDisplayName`,
    ),
    createdAt: text(row.createdAt, `invites[${index}].createdAt`),
    respondedAt: nullableText(
      row.respondedAt,
      `invites[${index}].respondedAt`,
    ),
  };
}

function decodeInvite(raw: unknown, index: number): LibraryInvite {
  return decodeInviteFields(
    exactRecord(raw, `invites[${index}]`, INVITE_KEYS),
    index,
  );
}

function decodeViewerInvite(
  raw: unknown,
  index: number,
): ViewerLibraryInvite {
  const row = exactRecord(raw, `viewerInvites[${index}]`, [
    ...INVITE_KEYS,
    "libraryName",
  ]);
  return {
    ...decodeInviteFields(row, index),
    libraryName: text(
      row.libraryName,
      `viewerInvites[${index}].libraryName`,
    ),
  };
}

function decodeUsers(raw: unknown): UserSearchResult[] {
  const data = envelope(raw, "user search response");
  if (!Array.isArray(data)) {
    throw new LibrarySharingContractDefect(
      "user search response.data must be an array",
    );
  }
  return data.map((value, index) => {
    const row = exactRecord(value, `users[${index}]`, [
      "userHandle",
      "email",
      "displayName",
    ]);
    return {
      userHandle: expectUserHandle(
        row.userHandle,
        `users[${index}].userHandle`,
      ),
      email: nullableText(row.email, `users[${index}].email`),
      displayName: nullableText(
        row.displayName,
        `users[${index}].displayName`,
      ),
    };
  });
}

export function decodeViewerLibraryInvites(
  raw: unknown,
): ViewerLibraryInvite[] {
  const data = envelope(raw, "viewer invites response");
  if (!Array.isArray(data)) {
    throw new LibrarySharingContractDefect(
      "viewer invites response.data must be an array",
    );
  }
  return data.map(decodeViewerInvite);
}

export async function fetchViewerLibraryInvites(
  signal?: AbortSignal,
): Promise<ViewerLibraryInvite[]> {
  return decodeViewerLibraryInvites(
    await apiFetch<unknown>("/api/libraries/invites", {
      cache: "no-store",
      signal,
    }),
  );
}

export async function acceptLibraryInvite(
  invitationHandle: string,
): Promise<LibraryInvite> {
  const handle = expectLibraryInvitationHandle(
    invitationHandle,
    "accept invite.invitationHandle",
  );
  const response = envelope(
    await apiFetch<unknown>(
      `/api/libraries/invites/${encodeURIComponent(handle)}/accept`,
      { method: "POST" },
    ),
    "accept invite response",
  );
  const row = exactRecord(response, "accept invite response.data", [
    "invite",
    "membership",
    "idempotent",
  ]);
  const membership = exactRecord(
    row.membership,
    "accept invite response.data.membership",
    ["libraryId", "userHandle", "role"],
  );
  text(membership.libraryId, "accept invite membership.libraryId");
  expectUserHandle(
    membership.userHandle,
    "accept invite membership.userHandle",
  );
  role(membership.role, "accept invite membership.role");
  if (typeof row.idempotent !== "boolean") {
    throw new LibrarySharingContractDefect(
      "accept invite response.data.idempotent must be boolean",
    );
  }
  return decodeInvite(row.invite, 0);
}

export async function declineLibraryInvite(
  invitationHandle: string,
): Promise<LibraryInvite> {
  const handle = expectLibraryInvitationHandle(
    invitationHandle,
    "decline invite.invitationHandle",
  );
  const response = envelope(
    await apiFetch<unknown>(
      `/api/libraries/invites/${encodeURIComponent(handle)}/decline`,
      { method: "POST" },
    ),
    "decline invite response",
  );
  const row = exactRecord(response, "decline invite response.data", [
    "invite",
    "idempotent",
  ]);
  if (typeof row.idempotent !== "boolean") {
    throw new LibrarySharingContractDefect(
      "decline invite response.data.idempotent must be boolean",
    );
  }
  return decodeInvite(row.invite, 0);
}

export async function fetchEditableLibrarySharing(
  libraryId: string,
  signal?: AbortSignal,
): Promise<EditableLibrarySharing> {
  const encodedLibraryId = encodeURIComponent(libraryId);
  const library = decodeLibrary(
    envelope(
      await apiFetch<unknown>(`/api/libraries/${encodedLibraryId}`, { signal }),
      "library response",
    ),
  );
  if (!library.canManageMembers) {
    return { library, members: [], invites: [] };
  }
  const [membersRaw, invitesRaw] = await Promise.all([
    apiFetch<unknown>(`/api/libraries/${encodedLibraryId}/members`, { signal }),
    apiFetch<unknown>(`/api/libraries/${encodedLibraryId}/invites`, { signal }),
  ]);
  const members = envelope(membersRaw, "members response");
  const invites = envelope(invitesRaw, "invites response");
  if (!Array.isArray(members) || !Array.isArray(invites)) {
    throw new LibrarySharingContractDefect(
      "library members and invites must be arrays",
    );
  }
  return {
    library,
    members: members.map(decodeMember),
    invites: invites.map(decodeInvite),
  };
}

export async function searchLibraryUsers(
  query: string,
  signal?: AbortSignal,
): Promise<UserSearchResult[]> {
  return decodeUsers(
    await apiFetch<unknown>(
      `/api/users/search?q=${encodeURIComponent(query)}`,
      { signal },
    ),
  );
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
  const libraryId = encodeURIComponent(input.libraryId);
  return decodeMember(
    envelope(
      await apiFetch<unknown>(
        `/api/libraries/${libraryId}/members/${encodeURIComponent(userHandle)}`,
        { method: "PATCH", body: JSON.stringify({ role: input.role }) },
      ),
      "member update response",
    ),
    0,
  );
}

export async function removeLibraryMember(input: {
  libraryId: string;
  userHandle: string;
}): Promise<void> {
  const userHandle = expectUserHandle(
    input.userHandle,
    "remove member.userHandle",
  );
  const libraryId = encodeURIComponent(input.libraryId);
  await apiCommand204(
    `/api/libraries/${libraryId}/members/${encodeURIComponent(userHandle)}`,
    { method: "DELETE" },
  );
}

export async function createLibraryInvite(input: {
  libraryId: string;
  invitee:
    | { kind: "User"; userHandle: string }
    | { kind: "Email"; email: string };
  role: LibraryRole;
}): Promise<LibraryInvite> {
  const invitee =
    input.invitee.kind === "User"
      ? {
          kind: "User" as const,
          userHandle: expectUserHandle(
            input.invitee.userHandle,
            "create invite.userHandle",
          ),
        }
      : input.invitee;
  const libraryId = encodeURIComponent(input.libraryId);
  return decodeInvite(
    envelope(
      await apiFetch<unknown>(`/api/libraries/${libraryId}/invites`, {
        method: "POST",
        body: JSON.stringify({ invitee, role: input.role }),
      }),
      "invite create response",
    ),
    0,
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
}): Promise<void> {
  const newOwnerUserHandle = expectUserHandle(
    input.newOwnerUserHandle,
    "transfer ownership.newOwnerUserHandle",
  );
  const libraryId = encodeURIComponent(input.libraryId);
  await apiFetch(
    `/api/libraries/${libraryId}/transfer-ownership`,
    {
      method: "POST",
      body: JSON.stringify({
        newOwnerUserHandle,
      }),
    },
  );
}
