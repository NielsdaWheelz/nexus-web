import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProxyToFastAPI = vi.fn().mockResolvedValue(new Response("ok"));
vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI: (...args: unknown[]) => mockProxyToFastAPI(...args),
}));

describe("library media BFF proxy routes", () => {
  beforeEach(() => {
    mockProxyToFastAPI.mockClear();
  });

  it("GET /api/libraries/[id]/media proxies to /libraries/{id}/media", async () => {
    const { GET } = await import("./[id]/media/route");
    const req = new Request("http://localhost/api/libraries/lib-1/media");
    await GET(req, { params: Promise.resolve({ id: "lib-1" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/libraries/lib-1/media");
  });

  it("POST /api/libraries/[id]/media proxies to /libraries/{id}/media", async () => {
    const { POST } = await import("./[id]/media/route");
    const req = new Request("http://localhost/api/libraries/lib-1/media", {
      method: "POST",
    });
    await POST(req, { params: Promise.resolve({ id: "lib-1" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/libraries/lib-1/media");
  });

  it("DELETE /api/libraries/[id]/media/[mediaId] proxies to /libraries/{id}/media/{mediaId}", async () => {
    const { DELETE } = await import("./[id]/media/[mediaId]/route");
    const req = new Request("http://localhost/api/libraries/lib-1/media/media-9", {
      method: "DELETE",
    });
    await DELETE(req, { params: Promise.resolve({ id: "lib-1", mediaId: "media-9" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/libraries/lib-1/media/media-9");
  });

  it("PUT /api/libraries/[id]/media/order proxies to /libraries/{id}/media/order", async () => {
    const { PUT } = await import("./[id]/media/order/route");
    const req = new Request("http://localhost/api/libraries/lib-1/media/order", {
      method: "PUT",
    });
    await PUT(req, { params: Promise.resolve({ id: "lib-1" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/libraries/lib-1/media/order");
  });
});
