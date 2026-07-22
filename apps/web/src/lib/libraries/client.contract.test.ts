import { describe, expect, it } from "vitest";
import {
  decodeCreatedLibraryDestination,
  decodeWritableLibraryDestinationPage,
} from "./client";

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

  it("decodes and projects a create success without trusting extra fields", () => {
    expect(
      decodeCreatedLibraryDestination({
        data: {
          ...destination,
          owner_user_id: "user-1",
          role: "admin",
          is_default: false,
        },
      }),
    ).toEqual(destination);
  });

  it("defects on a malformed create success envelope or destination", () => {
    expect(() => decodeCreatedLibraryDestination({ data: null })).toThrow(
      "create payload",
    );
    expect(() =>
      decodeCreatedLibraryDestination({
        data: { ...destination, color: false },
      }),
    ).toThrow("data.color");
  });
});
