import { afterEach, describe, expect, it, vi } from "vitest";
import { createLibrary, listMemberLibraries, searchWritableLibraryDestinations } from "./client";

describe("library client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("searches writable destinations through the BFF route", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [],
        page: { next_cursor: null },
      }),
    );

    await searchWritableLibraryDestinations({
      q: "Research",
      cursor: "cursor-1",
      limit: 10,
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/libraries/writable-destinations?q=Research&cursor=cursor-1&limit=10",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("lists member libraries through the standard library route", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [
          {
            id: "library-1",
            name: "Research",
            color: null,
            is_default: false,
            role: "member",
            owner_user_id: "user-1",
            created_at: "2026-06-04T00:00:00Z",
            updated_at: "2026-06-04T00:00:00Z",
          },
        ],
      }),
    );

    await expect(listMemberLibraries({ limit: 200 })).resolves.toEqual([
      {
        id: "library-1",
        name: "Research",
        color: null,
        is_default: false,
        role: "member",
        owner_user_id: "user-1",
        created_at: "2026-06-04T00:00:00Z",
        updated_at: "2026-06-04T00:00:00Z",
      },
    ]);
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/libraries?limit=200",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("creates libraries and adapts the response to a destination", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: {
          id: "library-1",
          name: "Research",
          color: null,
          is_default: false,
          role: "admin",
          owner_user_id: "user-1",
          created_at: "2026-06-04T00:00:00Z",
          updated_at: "2026-06-04T00:00:00Z",
        },
      }),
    );

    await expect(createLibrary({ name: "Research" })).resolves.toEqual({
      id: "library-1",
      name: "Research",
      color: null,
      created_at: "2026-06-04T00:00:00Z",
      updated_at: "2026-06-04T00:00:00Z",
    });
  });
});
