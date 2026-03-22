import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProxyToFastAPI = vi.fn().mockResolvedValue(new Response("ok"));
vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI: (...args: unknown[]) => mockProxyToFastAPI(...args),
}));

describe("playback queue bff proxy routes", () => {
  beforeEach(() => {
    mockProxyToFastAPI.mockClear();
  });

  it("GET /api/playback/queue proxies to /playback/queue", async () => {
    const { GET } = await import("./queue/route");
    const req = new Request("http://localhost/api/playback/queue");
    await GET(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/playback/queue");
  });

  it("POST /api/playback/queue/items proxies to /playback/queue/items", async () => {
    const { POST } = await import("./queue/items/route");
    const req = new Request("http://localhost/api/playback/queue/items", {
      method: "POST",
      body: JSON.stringify({ media_ids: ["media-1"], insert_position: "last" }),
    });
    await POST(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/playback/queue/items");
  });

  it("DELETE /api/playback/queue/items/[itemId] proxies to /playback/queue/items/{itemId}", async () => {
    const { DELETE } = await import("./queue/items/[itemId]/route");
    const req = new Request("http://localhost/api/playback/queue/items/item-123", {
      method: "DELETE",
    });
    await DELETE(req, { params: Promise.resolve({ itemId: "item-123" }) });
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/playback/queue/items/item-123");
  });

  it("PUT /api/playback/queue/order proxies to /playback/queue/order", async () => {
    const { PUT } = await import("./queue/order/route");
    const req = new Request("http://localhost/api/playback/queue/order", {
      method: "PUT",
      body: JSON.stringify({ item_ids: ["item-1", "item-2"] }),
    });
    await PUT(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/playback/queue/order");
  });

  it("POST /api/playback/queue/clear proxies to /playback/queue/clear", async () => {
    const { POST } = await import("./queue/clear/route");
    const req = new Request("http://localhost/api/playback/queue/clear", {
      method: "POST",
    });
    await POST(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/playback/queue/clear");
  });

  it("GET /api/playback/queue/next proxies to /playback/queue/next", async () => {
    const { GET } = await import("./queue/next/route");
    const req = new Request(
      "http://localhost/api/playback/queue/next?current_media_id=media-123"
    );
    await GET(req);
    expect(mockProxyToFastAPI).toHaveBeenCalledOnce();
    expect(mockProxyToFastAPI).toHaveBeenCalledWith(req, "/playback/queue/next");
  });
});
