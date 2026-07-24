import { describe, expect, it } from "vitest";
import {
  decodeMemberLibrariesResponse,
  decodeWritableLibraryDestinationPage,
} from "./client";

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
});
