/**
 * BFF proxy route tests for EPUB chapter and TOC endpoints (S5 PR-04).
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
});
