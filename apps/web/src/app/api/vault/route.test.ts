import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProxyToFastAPI = vi.fn().mockResolvedValue(new Response("ok"));
vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI: (...args: unknown[]) => mockProxyToFastAPI(...args),
}));

describe("vault BFF proxy route", () => {
  beforeEach(() => {
    mockProxyToFastAPI.mockClear();
  });

  it("GET /api/vault proxies to /vault", async () => {
    const { GET } = await import("./route");
    const req = new Request("http://localhost/api/vault");
    await GET(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/vault");
  });

  it("POST /api/vault proxies to /vault", async () => {
    const { POST } = await import("./route");
    const req = new Request("http://localhost/api/vault", {
      method: "POST",
      body: JSON.stringify({ files: [] }),
    });
    await POST(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/vault");
  });
});
