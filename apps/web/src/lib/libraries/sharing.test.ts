import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import { fetchEditableLibrarySharing } from "./sharing";

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>(
    "@/lib/api/client",
  );
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

const apiFetchMock = vi.mocked(apiFetch);

describe("fetchEditableLibrarySharing", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("returns empty sharing for non-admin libraries without fetching", async () => {
    await expect(
      fetchEditableLibrarySharing({ id: "library-1", role: "member" }),
    ).resolves.toEqual({ members: [], invites: [] });

    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("fetches members and invites for admin libraries", async () => {
    apiFetchMock
      .mockResolvedValueOnce({
        data: [
          {
            user_id: "user-1",
            role: "admin",
            is_owner: true,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "invite-1",
            library_id: "library-1",
            inviter_user_id: "user-1",
            invitee_user_id: "user-2",
            role: "member",
            status: "pending",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      });

    await expect(
      fetchEditableLibrarySharing({ id: "library-1", role: "admin" }),
    ).resolves.toEqual({
      members: [
        {
          user_id: "user-1",
          role: "admin",
          is_owner: true,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      invites: [
        {
          id: "invite-1",
          library_id: "library-1",
          inviter_user_id: "user-1",
          invitee_user_id: "user-2",
          role: "member",
          status: "pending",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });

    expect(apiFetchMock).toHaveBeenCalledWith("/api/libraries/library-1/members");
    expect(apiFetchMock).toHaveBeenCalledWith("/api/libraries/library-1/invites");
  });
});
