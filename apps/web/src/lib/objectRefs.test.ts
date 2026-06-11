import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchObjectRefs } from "./objectRefs";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("object ref api", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("passes object type filters to search", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        data: {
          objects: [
            {
              objectType: "tag",
              objectId: "77777777-7777-4777-8777-777777777777",
              label: "#SOTA",
              route: null,
            },
          ],
        },
      })
    );

    await expect(searchObjectRefs("sot", 4, { objectTypes: ["tag"] })).resolves.toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/object-refs/search?q=sot&limit=4&type=tag",
      expect.objectContaining({ cache: "no-store" })
    );
  });
});
