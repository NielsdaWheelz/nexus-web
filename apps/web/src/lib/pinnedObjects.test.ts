import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPinnedObjects,
  pinnedObjectsPath,
  pinObjectToNavbar,
} from "./pinnedObjects";
import { apiFetch } from "@/lib/api/client";

vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn(),
}));

const mockApiFetch = vi.mocked(apiFetch);

describe("pinnedObjects", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("builds the shared pinned-object read path", () => {
    expect(pinnedObjectsPath("reader tools")).toBe(
      "/api/pinned-objects?surface_key=reader%20tools",
    );
  });

  it("fetches pins for the requested surface", async () => {
    mockApiFetch.mockResolvedValueOnce({ data: { pins: [{ id: "pin-1" }] } });

    await expect(fetchPinnedObjects("navbar")).resolves.toEqual([{ id: "pin-1" }]);

    expect(mockApiFetch).toHaveBeenCalledWith("/api/pinned-objects?surface_key=navbar", {
      cache: "no-store",
    });
  });

  it("pins navbar objects", async () => {
    mockApiFetch.mockResolvedValueOnce({ data: {} });

    await pinObjectToNavbar("page", "page-1");

    expect(mockApiFetch).toHaveBeenCalledWith("/api/pinned-objects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectType: "page", objectId: "page-1", surfaceKey: "navbar" }),
    });
  });
});
