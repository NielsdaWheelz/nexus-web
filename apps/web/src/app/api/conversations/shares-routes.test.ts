import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock proxyToFastAPI before importing route modules
const mockProxyToFastAPI = vi.fn().mockResolvedValue(new Response("ok"));
vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI: (...args: unknown[]) => mockProxyToFastAPI(...args),
}));

describe("conversation shares BFF proxy routes", () => {
  beforeEach(() => {
    mockProxyToFastAPI.mockClear();
  });

  it("GET /api/conversations/[id]/shares proxies to /conversations/{id}/shares", async () => {
    const { GET } = await import("./[id]/shares/route");
    const req = new Request(
      "http://localhost/api/conversations/conv-123/shares",
      { method: "GET" }
    );
    await GET(req, { params: Promise.resolve({ id: "conv-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/conversations/conv-123/shares"
    );
  });

  it("PUT /api/conversations/[id]/shares proxies to /conversations/{id}/shares", async () => {
    const { PUT } = await import("./[id]/shares/route");
    const req = new Request(
      "http://localhost/api/conversations/conv-456/shares",
      { method: "PUT" }
    );
    await PUT(req, { params: Promise.resolve({ id: "conv-456" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/conversations/conv-456/shares"
    );
  });
});
