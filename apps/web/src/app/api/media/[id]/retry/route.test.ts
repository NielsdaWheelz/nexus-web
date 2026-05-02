import { describe, expect, it, vi } from "vitest";

const proxyToFastAPI = vi.fn();

vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI,
}));

describe("/api/media/:id/retry", () => {
  it("proxies POST to the matching FastAPI retry path", async () => {
    proxyToFastAPI.mockResolvedValue(new Response("ok"));
    const req = new Request("http://localhost:3000/api/media/media-123/retry", {
      method: "POST",
    });
    const params = { params: Promise.resolve({ id: "media-123" }) };
    const { POST } = await import("./route");

    await POST(req, params);

    expect(proxyToFastAPI).toHaveBeenCalledWith(req, "/media/media-123/retry");
  });
});
