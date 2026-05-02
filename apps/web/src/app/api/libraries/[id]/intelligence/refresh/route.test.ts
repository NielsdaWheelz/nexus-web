import { describe, expect, it, vi } from "vitest";

const proxyToFastAPI = vi.fn();

vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI,
}));

describe("/api/libraries/:id/intelligence/refresh", () => {
  it("proxies POST to the matching FastAPI path", async () => {
    proxyToFastAPI.mockResolvedValue(new Response("ok"));
    const req = new Request(
      "http://localhost:3000/api/libraries/library-123/intelligence/refresh",
      { method: "POST" }
    );
    const params = { params: Promise.resolve({ id: "library-123" }) };
    const { POST } = await import("./route");

    await POST(req, params);

    expect(proxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/libraries/library-123/intelligence/refresh"
    );
  });
});
