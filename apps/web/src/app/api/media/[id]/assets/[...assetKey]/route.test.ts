import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: {
            access_token: "test-access-token",
          },
        },
      })),
    },
  })),
}));

describe("GET /api/media/:id/assets/:assetKey*", () => {
  beforeEach(() => {
    vi.stubEnv("FASTAPI_BASE_URL", "http://fastapi.test");
    vi.stubEnv("NEXUS_INTERNAL_SECRET", "test-internal-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("proxies asset requests to the matching FastAPI path", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("asset"));
    vi.stubGlobal("fetch", fetchMock);

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
    expect(fetchMock).toHaveBeenCalledWith(
      "http://fastapi.test/media/media-123/assets/OEBPS/images/cover%20image.png",
      expect.objectContaining({
        method: "GET",
      })
    );
  });

  it("forwards EPUB asset response headers required by the reader", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 206,
          headers: {
            "accept-ranges": "bytes",
            "cache-control": "private, max-age=3600",
            "content-length": "3",
            "content-range": "bytes 0-2/10",
            "content-security-policy": "default-src 'none'; img-src 'self'",
            "content-type": "image/svg+xml",
            "set-cookie": "leak=1",
            "x-content-type-options": "nosniff",
            "x-internal-storage-url": "https://storage.example/private",
            "x-request-id": "backend-request-id",
          },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request(
      "http://localhost:3000/api/media/media-123/assets/asset.svg",
      {
        headers: {
          Range: "bytes=0-2",
        },
      }
    );
    const { GET } = await import("./route");

    const response = await GET(req, {
      params: Promise.resolve({
        id: "media-123",
        assetKey: ["asset.svg"],
      }),
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("content-range")).toBe("bytes 0-2/10");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; img-src 'self'"
    );
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toBe("backend-request-id");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-internal-storage-url")).toBeNull();

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init).toBeTruthy();
    expect((init as RequestInit).headers).toBeInstanceOf(Headers);
    const forwardedHeaders = (init as RequestInit).headers as Headers;
    expect(forwardedHeaders.get("range")).toBe("bytes=0-2");
  });

  it("does not synthesize range response headers when FastAPI omits them", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: {
            "content-length": "3",
            "content-type": "image/png",
            "x-content-type-options": "nosniff",
          },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request(
      "http://localhost:3000/api/media/media-123/assets/asset.png"
    );
    const { GET } = await import("./route");

    const response = await GET(req, {
      params: Promise.resolve({
        id: "media-123",
        assetKey: ["asset.png"],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("3");
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("accept-ranges")).toBeNull();
    expect(response.headers.get("content-range")).toBeNull();
  });

  it("recomputes content-length from the rebuilt response body", async () => {
    const body = JSON.stringify({ data: [{ name: "Library A" }] });
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(body, {
          headers: {
            "content-length": "7",
            "content-type": "application/json",
          },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request(
      "http://localhost:3000/api/media/media-123/assets/asset.json"
    );
    const { GET } = await import("./route");

    const response = await GET(req, {
      params: Promise.resolve({
        id: "media-123",
        assetKey: ["asset.json"],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(body).byteLength)
    );
    expect(await response.json()).toEqual({ data: [{ name: "Library A" }] });
  });
});
