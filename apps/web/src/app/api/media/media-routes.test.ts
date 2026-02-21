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
});
