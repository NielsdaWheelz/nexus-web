import { describe, expect, it } from "vitest";
import {
  LibraryContractDefect,
  expectLibraryInvitationsPage,
  expectLibraryMembersPage,
  expectLibraryOut,
  expectLibraryOutForId,
  expectLibraryOutEnvelopeForId,
  isLibraryContractDefect,
} from "./contract";

const OWNER = "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";
const USER = "nus1.CCCCCCCCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD";
const INVITE =
  "nli1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";
const absent = { kind: "Absent" } as const;
const present = (value: string) => ({ kind: "Present" as const, value });

const library = {
  id: "library-1",
  name: "Research",
  color: null,
  ownerUserHandle: OWNER,
  isDefault: false,
  role: "admin",
  systemKey: null,
  canRename: true,
  canDelete: true,
  canEditEntries: true,
  canManageMembers: true,
  canTransferOwnership: true,
  createdAt: "2026-07-24T10:00:00Z",
  updatedAt: "2026-07-24T10:30:00Z",
} as const;

describe("Library contract", () => {
  it("uses one exact LibraryOut decoder for list rows and correlated singleton reads", () => {
    expect(expectLibraryOut(library)).toEqual(library);
    expect(expectLibraryOutForId(library, "library-1")).toEqual(library);
    expect(() => expectLibraryOutForId(library, "library-2")).toThrow(
      LibraryContractDefect,
    );
    expect(() =>
      expectLibraryOut({ ...library, unknown: true }),
    ).toThrow(/expected/);
  });

  it("classifies exact-envelope, sealed-handle, and ID defects in one family", () => {
    for (const read of [
      () => expectLibraryOutEnvelopeForId({ library }, "library-1"),
      () =>
        expectLibraryOut(
          { ...library, ownerUserHandle: "private-database-id" },
        ),
      () => expectLibraryOutForId(library, "library-other"),
    ]) {
      try {
        read();
        throw new Error("expected a Library contract defect");
      } catch (error) {
        expect(isLibraryContractDefect(error)).toBe(true);
      }
    }
  });

  it("preserves Presence fields and the exact governance page envelope", () => {
    const member = {
      userHandle: USER,
      role: "member",
      isOwner: false,
      email: present("reader@example.test"),
      displayName: absent,
      createdAt: "2026-07-24T10:00:00Z",
    };
    expect(
      expectLibraryMembersPage({
        data: [member],
        page: { nextCursor: present("opaque") },
      }),
    ).toEqual({
      data: [member],
      page: { nextCursor: present("opaque") },
    });
  });

  it("rejects nullable absence and malformed Presence variants", () => {
    const member = {
      userHandle: USER,
      role: "member",
      isOwner: false,
      email: null,
      displayName: absent,
      createdAt: "2026-07-24T10:00:00Z",
    };
    expect(() =>
      expectLibraryMembersPage({
        data: [member],
        page: { nextCursor: absent },
      }),
    ).toThrow(/email.*Presence/);
    expect(() =>
      expectLibraryMembersPage({
        data: [{ ...member, email: { kind: "Absent", value: "extra" } }],
        page: { nextCursor: absent },
      }),
    ).toThrow(/no keys besides/);
  });

  it("strictly decodes invitation Presence and page keys", () => {
    const invitation = {
      invitationHandle: INVITE,
      libraryId: "library-1",
      inviterUserHandle: OWNER,
      inviteeUserHandle: USER,
      role: "member",
      status: "pending",
      inviteeEmail: absent,
      inviteeDisplayName: present("Reader"),
      createdAt: "2026-07-24T10:00:00Z",
      respondedAt: absent,
    };
    expect(
      expectLibraryInvitationsPage({
        data: [invitation],
        page: { nextCursor: absent },
      }),
    ).toEqual({
      data: [invitation],
      page: { nextCursor: absent },
    });
    expect(() =>
      expectLibraryInvitationsPage({
        data: [{ ...invitation, respondedAt: null }],
        page: { nextCursor: absent, hasMore: false },
      }),
    ).toThrow();
  });
});
