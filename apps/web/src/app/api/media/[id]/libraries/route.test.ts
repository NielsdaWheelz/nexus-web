import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUPABASE_URL = "https://project-ref.supabase.co";
const COOKIE_NAME = "sb-project-ref-auth-token";

function encodeSessionCookie(session: Record<string, unknown>): string {
  return `base64-${Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url",
  )}`;
}

function sessionCookie(): string {
  return `${COOKIE_NAME}=${encodeSessionCookie({
    access_token: "test-access-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
  })}`;
}

describe("/api/media/:id/libraries", () => {
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

  it("proxies GET requests to the FastAPI media libraries path", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request(
      "http://localhost:3000/api/media/media-123/libraries",
      { headers: { cookie: sessionCookie() } },
    );
    const { GET } = await import("./route");

    const response = await GET(req, {
      params: Promise.resolve({ id: "media-123" }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://fastapi.test/media/media-123/libraries",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("proxies POST requests with the JSON body to the FastAPI media libraries path", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: { media_id: "media-123", library_ids_added: ["library-1"] },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const req = new Request(
      "http://localhost:3000/api/media/media-123/libraries",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie(),
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({ library_ids: ["library-1"] }),
      },
    );
    const { POST } = await import("./route");

    const response = await POST(req, {
      params: Promise.resolve({ id: "media-123" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { media_id: "media-123", library_ids_added: ["library-1"] },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://fastapi.test/media/media-123/libraries",
      expect.objectContaining({ method: "POST" }),
    );
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit];
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer test-access-token",
    );
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(
      JSON.stringify({ library_ids: ["library-1"] }),
    );
  });
});
