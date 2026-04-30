import { describe, expect, it, vi } from "vitest";

const proxyToFastAPI = vi.fn();

vi.mock("@/lib/api/proxy", () => ({
  proxyToFastAPI,
}));

describe("GET /api/media/:id/assets/:assetKey*", () => {
  it("proxies asset requests to the matching FastAPI path", async () => {
    proxyToFastAPI.mockResolvedValue(new Response("asset"));
    const req = new Request(
      "http://localhost:3000/api/media/media-123/assets/OEBPS/images/cover image.png"
    );
    const { GET } = await import("./route");

    const response = await GET(req, {
      params: Promise.resolve({
        id: "media-123",
        assetKey: ["OEBPS", "images", "cover image.png"],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset");
    expect(proxyToFastAPI).toHaveBeenCalledWith(
      req,
      "/media/media-123/assets/OEBPS/images/cover%20image.png"
    );
  });
});
