import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProxyToFastAPI = vi.fn().mockResolvedValue(new Response("ok"));
vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI: (...args: unknown[]) => mockProxyToFastAPI(...args),
}));

describe("billing BFF proxy routes", () => {
  beforeEach(() => {
    mockProxyToFastAPI.mockClear();
  });

  it("GET /api/billing/account proxies to /billing/account", async () => {
    const { GET } = await import("./account/route");
    const req = new Request("http://localhost/api/billing/account");
    await GET(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/billing/account");
  });

  it("POST /api/billing/checkout proxies to /billing/checkout", async () => {
    const { POST } = await import("./checkout/route");
    const req = new Request("http://localhost/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ plan_tier: "ai_plus" }),
    });
    await POST(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/billing/checkout");
  });

  it("POST /api/billing/portal proxies to /billing/portal", async () => {
    const { POST } = await import("./portal/route");
    const req = new Request("http://localhost/api/billing/portal", {
      method: "POST",
    });
    await POST(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/billing/portal");
  });
});
