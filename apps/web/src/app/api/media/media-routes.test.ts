/**
 * BFF proxy route tests for media endpoints.
 *
 * Verifies each route handler calls proxyToFastAPI with the exact
 * expected upstream path including query strings where applicable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockProxyToFastAPI = vi.fn().mockResolvedValue(new Response("ok"));
vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI: (...args: unknown[]) => mockProxyToFastAPI(...args),
}));

describe("media EPUB BFF proxy routes", () => {
  beforeEach(() => {
    mockProxyToFastAPI.mockClear();
  });

  it("GET /api/media proxies to /media", async () => {
    const { GET } = await import("./route");
    const req = new Request("http://localhost/api/media?kind=pdf&limit=20");
    await GET(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/media");
  });

  it("GET /api/media/[id]/chapters proxies to /media/{id}/chapters", async () => {
    const { GET } = await import("./[id]/chapters/route");
    const req = new Request("http://localhost/api/media/mid-123/chapters");
    await GET(req, { params: Promise.resolve({ id: "mid-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/media/mid-123/chapters");
  });

  it("GET /api/media/[id]/chapters forwards limit/cursor query string unchanged", async () => {
    const { GET } = await import("./[id]/chapters/route");
    const req = new Request(
      "http://localhost/api/media/mid-123/chapters?limit=10&cursor=5"
    );
    await GET(req, { params: Promise.resolve({ id: "mid-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/media/mid-123/chapters");
  });

  it("GET /api/media/[id]/chapters/[idx] proxies to /media/{id}/chapters/{idx}", async () => {
    const { GET } = await import("./[id]/chapters/[idx]/route");
    const req = new Request(
      "http://localhost/api/media/mid-123/chapters/4"
    );
    await GET(req, {
      params: Promise.resolve({ id: "mid-123", idx: "4" }),
    });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/media/mid-123/chapters/4");
  });

  it("GET /api/media/[id]/toc proxies to /media/{id}/toc", async () => {
    const { GET } = await import("./[id]/toc/route");
    const req = new Request("http://localhost/api/media/mid-123/toc");
    await GET(req, { params: Promise.resolve({ id: "mid-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/media/mid-123/toc");
  });

  it("GET /api/media/[id]/navigation proxies to /media/{id}/navigation", async () => {
    const { GET } = await import("./[id]/navigation/route");
    const req = new Request("http://localhost/api/media/mid-123/navigation");
    await GET(req, { params: Promise.resolve({ id: "mid-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/media/mid-123/navigation");
  });

  it("GET /api/media/[id]/libraries proxies to /media/{id}/libraries", async () => {
    const { GET } = await import("./[id]/libraries/route");
    const req = new Request("http://localhost/api/media/mid-123/libraries");
    await GET(req, { params: Promise.resolve({ id: "mid-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/media/mid-123/libraries");
  });

  it("GET /api/media/[id]/file proxies to canonical /media/{id}/file", async () => {
    const { GET } = await import("./[id]/file/route");
    const req = new Request("http://localhost/api/media/mid-123/file");
    await GET(req, { params: Promise.resolve({ id: "mid-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/media/mid-123/file");
  });

  it("GET /api/media/[id]/pdf-highlights proxies to /media/{id}/pdf-highlights", async () => {
    const { GET } = await import("./[id]/pdf-highlights/route");
    const req = new Request(
      "http://localhost/api/media/mid-123/pdf-highlights?page_number=1&mine_only=false"
    );
    await GET(req, { params: Promise.resolve({ id: "mid-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/media/mid-123/pdf-highlights"
    );
  });

  it("GET /api/media/[id]/pdf-highlights/index proxies to /media/{id}/pdf-highlights/index", async () => {
    const { GET } = await import("./[id]/pdf-highlights/index/route");
    const req = new Request(
      "http://localhost/api/media/mid-123/pdf-highlights/index?limit=50&cursor=opaque&mine_only=false"
    );
    await GET(req, { params: Promise.resolve({ id: "mid-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/media/mid-123/pdf-highlights/index"
    );
  });

  it("GET /api/media/[id]/highlights proxies to /media/{id}/highlights", async () => {
    const { GET } = await import("./[id]/highlights/route");
    const req = new Request(
      "http://localhost/api/media/mid-123/highlights?limit=50&cursor=opaque&mine_only=false"
    );
    await GET(req, { params: Promise.resolve({ id: "mid-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/media/mid-123/highlights");
  });

  it("POST /api/media/[id]/pdf-highlights proxies to /media/{id}/pdf-highlights", async () => {
    const { POST } = await import("./[id]/pdf-highlights/route");
    const req = new Request("http://localhost/api/media/mid-123/pdf-highlights", {
      method: "POST",
      body: JSON.stringify({
        page_number: 1,
        exact: "hello",
        color: "yellow",
        quads: [
          {
            x1: 10,
            y1: 20,
            x2: 30,
            y2: 20,
            x3: 30,
            y3: 32,
            x4: 10,
            y4: 32,
          },
        ],
      }),
    });
    await POST(req, { params: Promise.resolve({ id: "mid-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/media/mid-123/pdf-highlights"
    );
  });

  it("POST /api/media/[id]/transcript/request proxies to /media/{id}/transcript/request", async () => {
    const { POST } = await import("./[id]/transcript/request/route");
    const req = new Request("http://localhost/api/media/mid-123/transcript/request", {
      method: "POST",
      body: JSON.stringify({ reason: "search", dry_run: true }),
    });
    await POST(req, { params: Promise.resolve({ id: "mid-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/media/mid-123/transcript/request"
    );
  });

  it("GET /api/media/[id]/listening-state proxies to /media/{id}/listening-state", async () => {
    const { GET } = await import("./[id]/listening-state/route");
    const req = new Request("http://localhost/api/media/mid-123/listening-state");
    await GET(req, { params: Promise.resolve({ id: "mid-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/media/mid-123/listening-state"
    );
  });

  it("PUT /api/media/[id]/listening-state proxies to /media/{id}/listening-state", async () => {
    const { PUT } = await import("./[id]/listening-state/route");
    const req = new Request("http://localhost/api/media/mid-123/listening-state", {
      method: "PUT",
      body: JSON.stringify({ position_ms: 30_000, playback_speed: 1.5 }),
    });
    await PUT(req, { params: Promise.resolve({ id: "mid-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/media/mid-123/listening-state"
    );
  });

  it("POST /api/media/listening-state/batch proxies to /media/listening-state/batch", async () => {
    const { POST } = await import("./listening-state/batch/route");
    const req = new Request("http://localhost/api/media/listening-state/batch", {
      method: "POST",
      body: JSON.stringify({
        media_ids: ["mid-123", "mid-456"],
        is_completed: true,
      }),
    });
    await POST(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/media/listening-state/batch");
  });

  it("POST /api/media/transcript/forecasts proxies to /media/transcript/forecasts", async () => {
    const { POST } = await import("./transcript/forecasts/route");
    const req = new Request("http://localhost/api/media/transcript/forecasts", {
      method: "POST",
      body: JSON.stringify({
        requests: [{ media_id: "mid-123", reason: "search" }],
      }),
    });
    await POST(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/media/transcript/forecasts");
  });

  it("POST /api/media/transcript/request/batch proxies to /media/transcript/request/batch", async () => {
    const { POST } = await import("./transcript/request/batch/route");
    const req = new Request("http://localhost/api/media/transcript/request/batch", {
      method: "POST",
      body: JSON.stringify({
        media_ids: ["mid-123", "mid-456"],
        reason: "search",
      }),
    });
    await POST(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/media/transcript/request/batch");
  });
});
