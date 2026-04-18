import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProxyToFastAPI = vi.fn().mockResolvedValue(new Response("ok"));
vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI: (...args: unknown[]) => mockProxyToFastAPI(...args),
}));

describe("library media BFF proxy routes", () => {
  beforeEach(() => {
    mockProxyToFastAPI.mockClear();
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

  it("GET /api/libraries/[id]/entries proxies to /libraries/{id}/entries", async () => {
    const { GET } = await import("./[id]/entries/route");
    const req = new Request("http://localhost/api/libraries/lib-1/entries");
    await GET(req, { params: Promise.resolve({ id: "lib-1" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/libraries/lib-1/entries");
  });

  it("PATCH /api/libraries/[id]/entries/reorder proxies to /libraries/{id}/entries/reorder", async () => {
    const { PATCH } = await import("./[id]/entries/reorder/route");
    const req = new Request("http://localhost/api/libraries/lib-1/entries/reorder", {
      method: "PATCH",
    });
    await PATCH(req, { params: Promise.resolve({ id: "lib-1" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/libraries/lib-1/entries/reorder");
  });

  it("POST /api/libraries/[id]/podcasts proxies to /libraries/{id}/podcasts", async () => {
    const { POST } = await import("./[id]/podcasts/route");
    const req = new Request("http://localhost/api/libraries/lib-1/podcasts", {
      method: "POST",
    });
    await POST(req, { params: Promise.resolve({ id: "lib-1" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/libraries/lib-1/podcasts");
  });

  it("DELETE /api/libraries/[id]/podcasts/[podcastId] proxies to /libraries/{id}/podcasts/{podcastId}", async () => {
    const { DELETE } = await import("./[id]/podcasts/[podcastId]/route");
    const req = new Request("http://localhost/api/libraries/lib-1/podcasts/podcast-9", {
      method: "DELETE",
    });
    await DELETE(req, {
      params: Promise.resolve({ id: "lib-1", podcastId: "podcast-9" }),
    });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/libraries/lib-1/podcasts/podcast-9"
    );
  });
});
