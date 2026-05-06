import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPinnedObjects, pinObjectToNavbar } from "./pinnedObjects";
import { apiFetch } from "@/lib/api/client";

vi.mock("@/lib/api/client", () => ({
  apiFetch: vi.fn(),
}));

const mockApiFetch = vi.mocked(apiFetch);

describe("pinnedObjects", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("fetches pins for the requested surface", async () => {
    mockApiFetch.mockResolvedValueOnce({ data: { pins: [{ id: "pin-1" }] } });

    await expect(fetchPinnedObjects("navbar")).resolves.toEqual([{ id: "pin-1" }]);

    expect(mockApiFetch).toHaveBeenCalledWith("/api/pinned-objects?surface_key=navbar", {
      cache: "no-store",
    });
  });

  it("pins navbar objects through the hard-cutover endpoint", async () => {
    mockApiFetch.mockResolvedValueOnce({ data: {} });

    await pinObjectToNavbar("page", "page-1");

    expect(mockApiFetch).toHaveBeenCalledWith("/api/pinned-objects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objectType: "page", objectId: "page-1", surfaceKey: "navbar" }),
    });
  });
});
