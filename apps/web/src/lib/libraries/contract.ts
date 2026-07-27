import { decodePresence, type Presence } from "@/lib/api/presence";
import { isRecord } from "@/lib/validation";

// Keep this isomorphic boundary independent of sharing/wireValidation: that
// browser boundary also owns canonical-href validation and imports client-only
// pane metadata. These two wire grammars mirror the backend sealed-handle types.
const SEALED_ENTITY_PART = "[A-Za-z0-9_-]{22}";
const USER_HANDLE_RE = new RegExp(
  `^nus1\\.${SEALED_ENTITY_PART}\\.${SEALED_ENTITY_PART}$`,
);
const LIBRARY_INVITATION_HANDLE_RE = new RegExp(
  `^nli1\\.${SEALED_ENTITY_PART}\\.${SEALED_ENTITY_PART}$`,
);

export type LibraryRole = "admin" | "member";
export type LibraryInvitationStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "revoked";
export type LibraryGovernanceCursor = string;

export interface LibraryOut {
  id: string;
  name: string;
  color: string | null;
  ownerUserHandle: string;
  isDefault: boolean;
  role: LibraryRole;
  systemKey: string | null;
  canRename: boolean;
  canDelete: boolean;
  canEditEntries: boolean;
  canManageMembers: boolean;
  canTransferOwnership: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryMember {
  userHandle: string;
  role: LibraryRole;
  isOwner: boolean;
  email: Presence<string>;
  displayName: Presence<string>;
  createdAt: string;
}

export interface LibraryInvitation {
  invitationHandle: string;
  libraryId: string;
  inviterUserHandle: string;
  inviteeUserHandle: string;
  role: LibraryRole;
  status: LibraryInvitationStatus;
  inviteeEmail: Presence<string>;
  inviteeDisplayName: Presence<string>;
  createdAt: string;
  respondedAt: Presence<string>;
}

export interface ViewerLibraryInvitation extends LibraryInvitation {
  libraryName: string;
}

export interface LibraryGovernancePageInfo {
  nextCursor: Presence<LibraryGovernanceCursor>;
}

export interface LibraryGovernancePage<T> {
  data: T[];
  page: LibraryGovernancePageInfo;
}

export class LibraryContractDefect extends Error {
  constructor(message: string) {
    // justify-defect: malformed same-system Library payloads mean the
    // frontend and backend shipped different exact contracts.
    super(message);
    this.name = "LibraryContractDefect";
  }
}

export function isLibraryContractDefect(
  error: unknown,
): error is LibraryContractDefect {
  return error instanceof LibraryContractDefect;
}

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

function text(raw: unknown, name: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new LibraryContractDefect(`${name} must be a non-empty string`);
  }
  return raw;
}

function nullableText(raw: unknown, name: string): string | null {
  if (raw === null || typeof raw === "string") return raw;
  throw new LibraryContractDefect(`${name} must be a string or null`);
}

function boolean(raw: unknown, name: string): boolean {
  if (typeof raw !== "boolean") {
    throw new LibraryContractDefect(`${name} must be a boolean`);
  }
  return raw;
}

function role(raw: unknown, name: string): LibraryRole {
  if (raw === "admin" || raw === "member") return raw;
  throw new LibraryContractDefect(`${name} must be admin or member`);
}

function invitationStatus(
  raw: unknown,
  name: string,
): LibraryInvitationStatus {
  if (
    raw === "pending" ||
    raw === "accepted" ||
    raw === "declined" ||
    raw === "revoked"
  ) {
    return raw;
  }
  throw new LibraryContractDefect(`${name} is invalid`);
}

function presenceText(raw: unknown, name: string): Presence<string> {
  try {
    return decodePresence(raw, (value) => {
      if (typeof value !== "string") {
        throw new LibraryContractDefect(`${name}.value must be a string`);
      }
      return value;
    });
  } catch (error) {
    if (error instanceof LibraryContractDefect) throw error;
    throw new LibraryContractDefect(
      `${name} is invalid: ${
        error instanceof Error ? error.message : "invalid Presence"
      }`,
    );
  }
}

function presenceCursor(
  raw: unknown,
  name: string,
): Presence<LibraryGovernanceCursor> {
  try {
    return decodePresence(raw, (value) => text(value, `${name}.value`));
  } catch (error) {
    if (error instanceof LibraryContractDefect) throw error;
    throw new LibraryContractDefect(
      `${name} is invalid: ${
        error instanceof Error ? error.message : "invalid Presence"
      }`,
    );
  }
}

function envelopeData(raw: unknown, name: string): unknown {
  return exactRecord(raw, name, ["data"]).data;
}

function userHandle(raw: unknown, name: string): string {
  if (typeof raw !== "string" || !USER_HANDLE_RE.test(raw)) {
    throw new LibraryContractDefect(
      `${name} has invalid sealed-handle grammar`,
    );
  }
  return raw;
}

function invitationHandle(raw: unknown, name: string): string {
  if (
    typeof raw !== "string" ||
    !LIBRARY_INVITATION_HANDLE_RE.test(raw)
  ) {
    throw new LibraryContractDefect(
      `${name} has invalid sealed-handle grammar`,
    );
  }
  return raw;
}

export function expectLibraryOut(
  raw: unknown,
  name = "LibraryOut",
): LibraryOut {
  const row = exactRecord(raw, name, [
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
  return {
    id: text(row.id, `${name}.id`),
    name: text(row.name, `${name}.name`),
    color: nullableText(row.color, `${name}.color`),
    ownerUserHandle: userHandle(
      row.ownerUserHandle,
      `${name}.ownerUserHandle`,
    ),
    isDefault: boolean(row.isDefault, `${name}.isDefault`),
    role: role(row.role, `${name}.role`),
    systemKey: nullableText(row.systemKey, `${name}.systemKey`),
    canRename: boolean(row.canRename, `${name}.canRename`),
    canDelete: boolean(row.canDelete, `${name}.canDelete`),
    canEditEntries: boolean(row.canEditEntries, `${name}.canEditEntries`),
    canManageMembers: boolean(
      row.canManageMembers,
      `${name}.canManageMembers`,
    ),
    canTransferOwnership: boolean(
      row.canTransferOwnership,
      `${name}.canTransferOwnership`,
    ),
    createdAt: text(row.createdAt, `${name}.createdAt`),
    updatedAt: text(row.updatedAt, `${name}.updatedAt`),
  };
}

export function expectLibraryOutForId(
  raw: unknown,
  requestedId: string,
  name = "LibraryOut",
): LibraryOut {
  const library = expectLibraryOut(raw, name);
  if (library.id !== requestedId) {
    throw new LibraryContractDefect(
      `${name}.id ${JSON.stringify(library.id)} does not match requested Library ${JSON.stringify(requestedId)}`,
    );
  }
  return library;
}

export function expectLibraryOutEnvelopeForId(
  raw: unknown,
  requestedId: string,
  name = "LibraryResponse",
): LibraryOut {
  return expectLibraryOutForId(
    envelopeData(raw, name),
    requestedId,
    `${name}.data`,
  );
}

export function expectLibraryMember(
  raw: unknown,
  name = "LibraryMemberOut",
): LibraryMember {
  const row = exactRecord(raw, name, [
    "userHandle",
    "role",
    "isOwner",
    "email",
    "displayName",
    "createdAt",
  ]);
  return {
    userHandle: userHandle(row.userHandle, `${name}.userHandle`),
    role: role(row.role, `${name}.role`),
    isOwner: boolean(row.isOwner, `${name}.isOwner`),
    email: presenceText(row.email, `${name}.email`),
    displayName: presenceText(row.displayName, `${name}.displayName`),
    createdAt: text(row.createdAt, `${name}.createdAt`),
  };
}

export function expectLibraryInvitation(
  raw: unknown,
  name = "LibraryInvitationOut",
): LibraryInvitation {
  const row = exactRecord(raw, name, [
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
  ]);
  return expectLibraryInvitationFields(row, name);
}

function expectLibraryInvitationFields(
  row: Record<string, unknown>,
  name: string,
): LibraryInvitation {
  return {
    invitationHandle: invitationHandle(
      row.invitationHandle,
      `${name}.invitationHandle`,
    ),
    libraryId: text(row.libraryId, `${name}.libraryId`),
    inviterUserHandle: userHandle(
      row.inviterUserHandle,
      `${name}.inviterUserHandle`,
    ),
    inviteeUserHandle: userHandle(
      row.inviteeUserHandle,
      `${name}.inviteeUserHandle`,
    ),
    role: role(row.role, `${name}.role`),
    status: invitationStatus(row.status, `${name}.status`),
    inviteeEmail: presenceText(row.inviteeEmail, `${name}.inviteeEmail`),
    inviteeDisplayName: presenceText(
      row.inviteeDisplayName,
      `${name}.inviteeDisplayName`,
    ),
    createdAt: text(row.createdAt, `${name}.createdAt`),
    respondedAt: presenceText(row.respondedAt, `${name}.respondedAt`),
  };
}

export function expectViewerLibraryInvitation(
  raw: unknown,
  name = "ViewerLibraryInvitationOut",
): ViewerLibraryInvitation {
  const row = exactRecord(raw, name, [
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
    "libraryName",
  ]);
  return {
    ...expectLibraryInvitationFields(row, name),
    libraryName: text(row.libraryName, `${name}.libraryName`),
  };
}

export function expectLibraryGovernancePage<T>(
  raw: unknown,
  decodeRow: (raw: unknown, name: string) => T,
  name = "LibraryGovernancePage",
): LibraryGovernancePage<T> {
  const envelope = exactRecord(raw, name, ["data", "page"]);
  if (!Array.isArray(envelope.data)) {
    throw new LibraryContractDefect(`${name}.data must be an array`);
  }
  const page = exactRecord(envelope.page, `${name}.page`, ["nextCursor"]);
  return {
    data: envelope.data.map((value, index) =>
      decodeRow(value, `${name}.data[${index}]`),
    ),
    page: {
      nextCursor: presenceCursor(
        page.nextCursor,
        `${name}.page.nextCursor`,
      ),
    },
  };
}

export function expectLibraryMembersPage(
  raw: unknown,
): LibraryGovernancePage<LibraryMember> {
  return expectLibraryGovernancePage(
    raw,
    expectLibraryMember,
    "LibraryMemberPage",
  );
}

export function expectLibraryInvitationsPage(
  raw: unknown,
): LibraryGovernancePage<LibraryInvitation> {
  return expectLibraryGovernancePage(
    raw,
    expectLibraryInvitation,
    "LibraryInvitationPage",
  );
}

export function expectViewerLibraryInvitations(
  raw: unknown,
): ViewerLibraryInvitation[] {
  const data = envelopeData(raw, "ViewerLibraryInvitations");
  if (!Array.isArray(data)) {
    throw new LibraryContractDefect(
      "ViewerLibraryInvitations.data must be an array",
    );
  }
  return data.map((value, index) =>
    expectViewerLibraryInvitation(
      value,
      `ViewerLibraryInvitations.data[${index}]`,
    ),
  );
}
