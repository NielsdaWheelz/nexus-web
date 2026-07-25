import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api/client";
import {
  decodeMemberLibrariesResponse,
  decodeWritableLibraryDestinationPage,
  getMemberLibrary,
} from "./client";

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>(
    "@/lib/api/client",
  );
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

const OWNER_USER_HANDLE =
  "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

const destination = {
  id: "library-1",
  name: "Research",
  color: "#0ea5e9",
  created_at: "2026-07-21T12:00:00Z",
  updated_at: "2026-07-21T12:30:00Z",
};

describe("library destination response contract", () => {
  beforeEach(() => apiFetchMock.mockReset());

  it("decodes destination identity, display fields, and an opaque next cursor", () => {
    expect(
      decodeWritableLibraryDestinationPage({
        data: [destination],
        page: { has_more: true, next_cursor: "opaque-cursor" },
      }),
    ).toEqual({
      data: [destination],
      page: { has_more: true, next_cursor: "opaque-cursor" },
    });
  });

  it.each([
    ["id", { ...destination, id: "" }],
    ["name", { ...destination, name: null }],
    ["color", { ...destination, color: 42 }],
    ["created_at", { ...destination, created_at: "" }],
    ["updated_at", { ...destination, updated_at: undefined }],
  ])("defects when search data has an invalid %s", (field, malformed) => {
    expect(() =>
      decodeWritableLibraryDestinationPage({
        data: [malformed],
        page: { has_more: false, next_cursor: null },
      }),
    ).toThrow(`data[0].${field}`);
  });

  it.each([
    [{ has_more: "yes", next_cursor: null }, "has_more"],
    [{ has_more: true, next_cursor: "" }, "next_cursor"],
    [{ has_more: true, next_cursor: null }, "must agree"],
    [{ has_more: false, next_cursor: "cursor" }, "must agree"],
  ])("defects on a malformed pagination contract", (page, message) => {
    expect(() =>
      decodeWritableLibraryDestinationPage({ data: [], page }),
    ).toThrow(message);
  });

  it("decodes the exact camel-case member LibraryOut contract", () => {
    const library = {
      id: "library-1",
      name: "Research",
      color: "#0ea5e9",
      ownerUserHandle: OWNER_USER_HANDLE,
      isDefault: false,
      role: "admin",
      systemKey: null,
      canRename: true,
      canDelete: true,
      canEditEntries: true,
      canManageMembers: true,
      canTransferOwnership: true,
      createdAt: "2026-07-21T12:00:00Z",
      updatedAt: "2026-07-21T12:30:00Z",
    };
    expect(
      decodeMemberLibrariesResponse({
        data: [library],
        page: { has_more: false, next_cursor: null },
      }),
    ).toEqual({
      data: [library],
      page: { has_more: false, next_cursor: null },
    });
    expect(() =>
      decodeMemberLibrariesResponse({
        data: [{ ...library, ownerUserHandle: undefined }],
        page: { has_more: false, next_cursor: null },
      }),
    ).toThrow("LibraryOut");
    expect(() =>
      decodeMemberLibrariesResponse({
        data: [{ ...library, ownerUserHandle: "raw-user-id" }],
        page: { has_more: false, next_cursor: null },
      }),
    ).toThrow("sealed-handle grammar");
  });

  it("correlates singleton Library reads with the requested identity", async () => {
    const library = {
      id: "library-1",
      name: "Research",
      color: null,
      ownerUserHandle: OWNER_USER_HANDLE,
      isDefault: false,
      role: "admin",
      systemKey: null,
      canRename: true,
      canDelete: true,
      canEditEntries: true,
      canManageMembers: true,
      canTransferOwnership: true,
      createdAt: "2026-07-21T12:00:00Z",
      updatedAt: "2026-07-21T12:30:00Z",
    };
    apiFetchMock.mockResolvedValueOnce({ data: library });
    await expect(getMemberLibrary("library-1")).resolves.toEqual(library);
    expect(apiFetchMock).toHaveBeenCalledWith("/api/libraries/library-1", {
      signal: undefined,
    });

    apiFetchMock.mockResolvedValueOnce({
      data: { ...library, id: "library-other" },
    });
    await expect(getMemberLibrary("library-1")).rejects.toThrow(
      /does not match requested Library/,
    );

    apiFetchMock.mockResolvedValueOnce({
      data: { ...library, canManageMembers: "yes" },
    });
    await expect(getMemberLibrary("library-1")).rejects.toThrow(
      /canManageMembers/,
    );

    apiFetchMock.mockResolvedValueOnce({ data: library, extra: true });
    await expect(getMemberLibrary("library-1")).rejects.toThrow(
      /expected \[data\]/,
    );
  });
});
