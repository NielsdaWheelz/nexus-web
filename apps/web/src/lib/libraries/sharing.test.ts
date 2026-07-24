import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import {
  acceptLibraryInvite,
  decodeViewerLibraryInvites,
  fetchEditableLibrarySharing,
} from "./sharing";

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>(
    "@/lib/api/client",
  );
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);
const OWNER_HANDLE =
  "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";
const INVITEE_HANDLE =
  "nus1.CCCCCCCCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD";
const INVITATION_HANDLE =
  "nli1.EEEEEEEEEEEEEEEEEEEEEE.FFFFFFFFFFFFFFFFFFFFFF";
const library = {
  id: "library-1",
  name: "Research",
  color: null,
  ownerUserHandle: OWNER_HANDLE,
  isDefault: false,
  role: "admin",
  systemKey: null,
  canRename: true,
  canDelete: true,
  canEditEntries: true,
  canManageMembers: true,
  canTransferOwnership: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const invite = {
  invitationHandle: INVITATION_HANDLE,
  libraryId: "library-1",
  inviterUserHandle: OWNER_HANDLE,
  inviteeUserHandle: INVITEE_HANDLE,
  role: "member",
  status: "pending",
  inviteeEmail: "invitee@example.test",
  inviteeDisplayName: "Invitee",
  createdAt: "2026-01-01T00:00:00Z",
  respondedAt: null,
};
const viewerInvite = { ...invite, libraryName: "Research" };

describe("library sharing client", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("returns the server-governed role without fetching admin lists", async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: { ...library, role: "member", canManageMembers: false, canTransferOwnership: false },
    });

    await expect(fetchEditableLibrarySharing("library-1")).resolves.toEqual({
      library: {
        id: "library-1",
        name: "Research",
        ownerUserHandle: OWNER_HANDLE,
        isDefault: false,
        systemKey: null,
        role: "member",
        canManageMembers: false,
        canTransferOwnership: false,
      },
      members: [],
      invites: [],
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("decodes sealed member and invitation identities for admins", async () => {
    apiFetchMock
      .mockResolvedValueOnce({ data: library })
      .mockResolvedValueOnce({
        data: [
          {
            userHandle: OWNER_HANDLE,
            role: "admin",
            isOwner: true,
            email: "owner@example.test",
            displayName: "Owner",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      })
      .mockResolvedValueOnce({ data: [invite] });

    const result = await fetchEditableLibrarySharing("library-1");
    expect(result.members[0]).toMatchObject({
      userHandle: OWNER_HANDLE,
      isOwner: true,
    });
    expect(result.invites[0]).toMatchObject({
      invitationHandle: INVITATION_HANDLE,
      inviteeUserHandle: INVITEE_HANDLE,
    });
    expect(apiFetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/libraries/library-1/members",
      { signal: undefined },
    );
    expect(apiFetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/libraries/library-1/invites",
      { signal: undefined },
    );
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });

  it("decodes the viewer inbox and accepts through the sealed handle", async () => {
    expect(decodeViewerLibraryInvites({ data: [viewerInvite] })).toEqual([
      viewerInvite,
    ]);
    apiFetchMock.mockResolvedValueOnce({
      data: {
        invite: { ...invite, status: "accepted", respondedAt: "2026-01-02T00:00:00Z" },
        membership: {
          libraryId: "library-1",
          userHandle: INVITEE_HANDLE,
          role: "member",
        },
        idempotent: false,
      },
    });

    await expect(acceptLibraryInvite(INVITATION_HANDLE)).resolves.toMatchObject({
      invitationHandle: INVITATION_HANDLE,
      status: "accepted",
    });
    expect(apiFetchMock).toHaveBeenCalledWith(
      `/api/libraries/invites/${INVITATION_HANDLE}/accept`,
      { method: "POST" },
    );
  });

  it("rejects a raw user id in accepted membership output", async () => {
    apiFetchMock.mockResolvedValueOnce({
      data: {
        invite: {
          ...invite,
          status: "accepted",
          respondedAt: "2026-01-02T00:00:00Z",
        },
        membership: {
          libraryId: "library-1",
          userHandle: "raw-user-id",
          role: "member",
        },
        idempotent: false,
      },
    });

    await expect(acceptLibraryInvite(INVITATION_HANDLE)).rejects.toThrow(
      "sealed-handle grammar",
    );
  });

  it("rejects legacy raw identity fields", () => {
    expect(() =>
      decodeViewerLibraryInvites({
        data: [
          {
            ...viewerInvite,
            invitationHandle: undefined,
            id: "raw-id",
          },
        ],
      }),
    ).toThrow(/expected/);
  });
});
