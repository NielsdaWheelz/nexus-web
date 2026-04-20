import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProxyToFastAPI = vi.fn().mockResolvedValue(new Response("ok"));
vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI: (...args: unknown[]) => mockProxyToFastAPI(...args),
}));

describe("podcast BFF proxy routes", () => {
  beforeEach(() => {
    mockProxyToFastAPI.mockClear();
  });

  it("GET /api/browse proxies to /browse", async () => {
    const { GET } = await import("../browse/route");
    const req = new Request("http://localhost/api/browse?q=ai&limit=10");
    await GET(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/browse");
  });

  it("GET /api/browse pagination params proxy to /browse", async () => {
    const { GET } = await import("../browse/route");
    const req = new Request(
      "http://localhost/api/browse?q=ai&limit=10&page_type=documents&cursor=cursor-2"
    );
    await GET(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/browse");
  });

  it("GET /api/podcasts/discover proxies to /podcasts/discover", async () => {
    const { GET } = await import("./discover/route");
    const req = new Request("http://localhost/api/podcasts/discover?q=ai&limit=10");
    await GET(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/discover");
  });

  it("POST /api/podcasts/ensure proxies to /podcasts/ensure", async () => {
    const { POST } = await import("./ensure/route");
    const req = new Request("http://localhost/api/podcasts/ensure", {
      method: "POST",
      body: JSON.stringify({
        provider_podcast_id: "abc",
        feed_url: "https://example.com/feed.xml",
        title: "Example Podcast",
      }),
    });
    await POST(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/ensure");
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
    const req = new Request("http://localhost/api/podcasts/subscriptions/pod-123", {
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

  it("GET /api/podcasts/[podcastId]/libraries proxies to /podcasts/{podcastId}/libraries", async () => {
    const { GET } = await import("./[podcastId]/libraries/route");
    const req = new Request("http://localhost/api/podcasts/pod-123/libraries");
    await GET(req, { params: Promise.resolve({ podcastId: "pod-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/podcasts/pod-123/libraries");
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
