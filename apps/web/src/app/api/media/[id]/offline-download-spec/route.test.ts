import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const SUPABASE_URL = "https://project-ref.supabase.co";
const COOKIE_NAME = "sb-project-ref-auth-token";

function sessionCookie(): string {
  const encoded = Buffer.from(
    JSON.stringify({
      access_token: "test-access-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
    }),
    "utf8"
  ).toString("base64url");
  return `${COOKIE_NAME}=base64-${encoded}`;
}

describe("GET /api/media/:id/offline-download-spec", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("FASTAPI_BASE_URL", "http://fastapi.test");
    vi.stubEnv("NEXUS_INTERNAL_SECRET", "test-internal-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("proxies the exact authenticated path and makes every response private/no-store", async () => {
    const body = {
      error: {
        code: "E_OFFLINE_MEDIA_UNAVAILABLE",
        message: "Offline media is unavailable",
      },
    };
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify(body), {
          status: 409,
          headers: {
            "cache-control": "public, max-age=300",
            "content-type": "application/json",
          },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request(
      "http://localhost:3000/api/media/episode-123/offline-download-spec",
      { headers: { cookie: sessionCookie() } }
    );
    const { GET } = await import("./route");

    const response = await GET(request, {
      params: Promise.resolve({ id: "episode-123" }),
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://fastapi.test/media/episode-123/offline-download-spec",
      expect.objectContaining({ method: "GET" })
    );
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer test-access-token"
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual(body);
  });
});
