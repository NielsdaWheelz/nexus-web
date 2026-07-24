import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import LibraryMemberEditor from "./LibraryMemberEditor";

const fetchEditableLibrarySharing = vi.hoisted(() => vi.fn());

vi.mock("@/lib/libraries/sharing", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/libraries/sharing")>();
  return { ...original, fetchEditableLibrarySharing };
});

describe("LibraryMemberEditor", () => {
  it("describes a non-default system library as copy-only", async () => {
    fetchEditableLibrarySharing.mockResolvedValueOnce({
      library: {
        id: "library-1",
        name: "Oracle Corpus",
        ownerUserHandle:
          "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
        isDefault: false,
        systemKey: "oracle_corpus",
        role: "admin",
        canManageMembers: false,
        canTransferOwnership: false,
      },
      members: [],
      invites: [],
    });

    render(<LibraryMemberEditor libraryId="library-1" />);

    expect(await screen.findByText("This library is copy-only.")).toBeVisible();
    expect(
      screen.queryByText("Membership is managed by library admins."),
    ).not.toBeInTheDocument();
  });
});
