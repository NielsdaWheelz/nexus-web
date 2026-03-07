import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProxyToFastAPI = vi.fn().mockResolvedValue(new Response("ok"));
vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI: (...args: unknown[]) => mockProxyToFastAPI(...args),
}));

describe("podcast BFF proxy routes", () => {
  beforeEach(() => {
    mockProxyToFastAPI.mockClear();
  });

  it("GET /api/podcasts/discover proxies to /podcasts/discover", async () => {
    const { GET } = await import("./discover/route");
    const req = new Request("http://localhost/api/podcasts/discover?q=ai&limit=10");
    await GET(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/discover");
  });

  it("GET /api/podcasts/subscriptions proxies to /podcasts/subscriptions", async () => {
    const { GET } = await import("./subscriptions/route");
    const req = new Request("http://localhost/api/podcasts/subscriptions?limit=20");
    await GET(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/subscriptions");
  });

  it("POST /api/podcasts/subscriptions proxies to /podcasts/subscriptions", async () => {
    const { POST } = await import("./subscriptions/route");
    const req = new Request("http://localhost/api/podcasts/subscriptions", {
      method: "POST",
      body: JSON.stringify({ provider_podcast_id: "abc", feed_url: "https://example.com/feed.xml" }),
    });
    await POST(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/subscriptions");
  });

  it("GET /api/podcasts/subscriptions/[podcastId] proxies to /podcasts/subscriptions/{podcastId}", async () => {
    const { GET } = await import("./subscriptions/[podcastId]/route");
    const req = new Request("http://localhost/api/podcasts/subscriptions/pod-123");
    await GET(req, { params: Promise.resolve({ podcastId: "pod-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/subscriptions/pod-123");
  });

  it("DELETE /api/podcasts/subscriptions/[podcastId] proxies to /podcasts/subscriptions/{podcastId}", async () => {
    const { DELETE } = await import("./subscriptions/[podcastId]/route");
    const req = new Request("http://localhost/api/podcasts/subscriptions/pod-123?mode=2", {
      method: "DELETE",
    });
    await DELETE(req, { params: Promise.resolve({ podcastId: "pod-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/subscriptions/pod-123");
  });

  it("GET /api/podcasts/[podcastId] proxies to /podcasts/{podcastId}", async () => {
    const { GET } = await import("./[podcastId]/route");
    const req = new Request("http://localhost/api/podcasts/pod-123");
    await GET(req, { params: Promise.resolve({ podcastId: "pod-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/pod-123");
  });

  it("GET /api/podcasts/[podcastId]/episodes proxies to /podcasts/{podcastId}/episodes", async () => {
    const { GET } = await import("./[podcastId]/episodes/route");
    const req = new Request("http://localhost/api/podcasts/pod-123/episodes?limit=50");
    await GET(req, { params: Promise.resolve({ podcastId: "pod-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/pod-123/episodes");
  });
});
