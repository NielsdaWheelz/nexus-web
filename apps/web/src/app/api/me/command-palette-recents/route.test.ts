import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProxyToFastAPI = vi.fn().mockResolvedValue(new Response("ok"));

vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI: (...args: unknown[]) => mockProxyToFastAPI(...args),
}));

describe("command palette recents BFF route", () => {
  beforeEach(() => {
    mockProxyToFastAPI.mockClear();
  });

  it("GET /api/me/command-palette-recents proxies to /me/command-palette-recents", async () => {
    const { GET } = await import("./route");
    const req = new Request("http://localhost/api/me/command-palette-recents");

    await GET(req);

    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/me/command-palette-recents");
  });

  it("POST /api/me/command-palette-recents proxies to /me/command-palette-recents", async () => {
    const { POST } = await import("./route");
    const req = new Request("http://localhost/api/me/command-palette-recents", {
      method: "POST",
      body: JSON.stringify({ href: "/media/media-1", title_snapshot: "Deep Work" }),
    });

    await POST(req);

    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/me/command-palette-recents");
  });
});
