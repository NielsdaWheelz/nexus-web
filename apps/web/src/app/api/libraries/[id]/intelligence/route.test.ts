import { describe, expect, it, vi } from "vitest";

const proxyToFastAPI = vi.fn();

vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI,
}));

describe("/api/libraries/:id/intelligence", () => {
  it("proxies GET to the matching FastAPI path", async () => {
    proxyToFastAPI.mockResolvedValue(new Response("ok"));
    const req = new Request(
      "http://localhost:3000/api/libraries/library-123/intelligence"
    );
    const params = { params: Promise.resolve({ id: "library-123" }) };
    const { GET } = await import("./route");

    await GET(req, params);

    expect(proxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/libraries/library-123/intelligence"
    );
  });
});
