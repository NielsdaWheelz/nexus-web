import { describe, expect, it, vi } from "vitest";

const proxyToFastAPI = vi.fn();

vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI,
}));

describe("/api/media/:id", () => {
  it("proxies GET and DELETE to the matching FastAPI path", async () => {
    proxyToFastAPI.mockResolvedValue(new Response("ok"));
    const req = new Request("http://localhost:3000/api/media/media-123?library_id=lib-123");
    const params = { params: Promise.resolve({ id: "media-123" }) };
    const { DELETE, GET } = await import("./route");

    await GET(req, params);
    await DELETE(req, params);

    expect(proxyToFastAPI).toHaveBeenNthCalledWith(1, req, "/media/media-123");
    expect(proxyToFastAPI).toHaveBeenNthCalledWith(2, req, "/media/media-123");
  });
});
