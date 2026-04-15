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

  it("GET /api/podcasts/categories proxies to /podcasts/categories", async () => {
    const { GET } = await import("./categories/route");
    const req = new Request("http://localhost/api/podcasts/categories");
    await GET(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/categories");
  });

  it("POST /api/podcasts/categories proxies to /podcasts/categories", async () => {
    const { POST } = await import("./categories/route");
    const req = new Request("http://localhost/api/podcasts/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Tech", color: "#334455" }),
    });
    await POST(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/categories");
  });

  it("PATCH /api/podcasts/categories/[categoryId] proxies to /podcasts/categories/{categoryId}", async () => {
    const { PATCH } = await import("./categories/[categoryId]/route");
    const req = new Request("http://localhost/api/podcasts/categories/cat-123", {
      method: "PATCH",
      body: JSON.stringify({ name: "Engineering" }),
    });
    await PATCH(req, { params: Promise.resolve({ categoryId: "cat-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/categories/cat-123");
  });

  it("DELETE /api/podcasts/categories/[categoryId] proxies to /podcasts/categories/{categoryId}", async () => {
    const { DELETE } = await import("./categories/[categoryId]/route");
    const req = new Request("http://localhost/api/podcasts/categories/cat-123", {
      method: "DELETE",
    });
    await DELETE(req, { params: Promise.resolve({ categoryId: "cat-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/categories/cat-123");
  });

  it("PUT /api/podcasts/categories/order proxies to /podcasts/categories/order", async () => {
    const { PUT } = await import("./categories/order/route");
    const req = new Request("http://localhost/api/podcasts/categories/order", {
      method: "PUT",
      body: JSON.stringify({ category_ids: ["cat-1", "cat-2"] }),
    });
    await PUT(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/categories/order");
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

  it("POST /api/podcasts/subscriptions/[podcastId]/sync proxies to /podcasts/subscriptions/{podcastId}/sync", async () => {
    const { POST } = await import("./subscriptions/[podcastId]/sync/route");
    const req = new Request("http://localhost/api/podcasts/subscriptions/pod-123/sync", {
      method: "POST",
    });
    await POST(req, { params: Promise.resolve({ podcastId: "pod-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/subscriptions/pod-123/sync");
  });

  it("PATCH /api/podcasts/subscriptions/[podcastId]/settings proxies to /podcasts/subscriptions/{podcastId}/settings", async () => {
    const { PATCH } = await import("./subscriptions/[podcastId]/settings/route");
    const req = new Request("http://localhost/api/podcasts/subscriptions/pod-123/settings", {
      method: "PATCH",
      body: JSON.stringify({ default_playback_speed: 1.5 }),
    });
    await PATCH(req, { params: Promise.resolve({ podcastId: "pod-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/podcasts/subscriptions/pod-123/settings"
    );
  });

  it("POST /api/podcasts/import/opml proxies to /podcasts/import/opml", async () => {
    const { POST } = await import("./import/opml/route");
    const body = new FormData();
    body.append("file", new File(["<opml/>"], "podcasts.opml", { type: "application/xml" }));
    const req = new Request("http://localhost/api/podcasts/import/opml", {
      method: "POST",
      body,
    });
    await POST(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/import/opml");
  });

  it("GET /api/podcasts/export/opml proxies to /podcasts/export/opml", async () => {
    const { GET } = await import("./export/opml/route");
    const req = new Request("http://localhost/api/podcasts/export/opml");
    await GET(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/export/opml");
  });
});
