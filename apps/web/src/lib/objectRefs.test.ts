import { beforeEach, describe, expect, it, vi } from "vitest";
import { isObjectType, searchObjectRefs } from "./objectRefs";

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
              objectType: "page",
              objectId: "77777777-7777-4777-8777-777777777777",
              label: "SOTA",
              route: "/pages/77777777-7777-4777-8777-777777777777",
            },
          ],
        },
      })
    );

    await expect(searchObjectRefs("sot", 4, { objectTypes: ["page"] })).resolves.toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/object-refs/search?q=sot&limit=4&type=page",
      expect.objectContaining({ cache: "no-store" })
    );
  });

  it("does not admit user graph tags as object types", () => {
    expect(isObjectType("tag")).toBe(false);
  });
});
