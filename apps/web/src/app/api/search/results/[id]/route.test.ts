import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const SUPABASE_URL = "https://project-ref.supabase.co";
const COOKIE_NAME = "sb-project-ref-auth-token";

function encodeSessionCookie(session: Record<string, unknown>): string {
  return `base64-${Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url"
  )}`;
}

function sessionCookie(): string {
  return `${COOKIE_NAME}=${encodeSessionCookie({
    access_token: "test-access-token",
    expires_at: Math.floor(Date.now() / 1000) + 60,
    token_type: "bearer",
  })}`;
}

describe("GET /api/search/results/[id]", () => {
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

  it("proxies search result detail requests to the canonical backend path", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => Response.json({ data: { id: "result-1" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      new Request("http://localhost:3000/api/search/results/result-1", {
        headers: { cookie: sessionCookie() },
      }),
      { params: Promise.resolve({ id: "result-1" }) }
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://fastapi.test/search/results/result-1",
      expect.objectContaining({ method: "GET" })
    );
  });
});
