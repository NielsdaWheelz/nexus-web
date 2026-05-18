import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

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
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
  })}`;
}

describe("POST /api/artifacts/[artifactId]/ask", () => {
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

  it("proxies artifact follow-up requests to the canonical artifact backend path", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => Response.json({ data: { message_id: "message-2" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const body = JSON.stringify({ prompt: "Where did this claim come from?" });

    const response = await POST(
      new Request("http://localhost:3000/api/artifacts/artifact-1/ask", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie(),
          origin: "http://localhost:3000",
        },
        body,
      }),
      { params: Promise.resolve({ artifactId: "artifact-1" }) }
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://fastapi.test/artifacts/artifact-1/ask",
      expect.objectContaining({ method: "POST" })
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(body);
  });
});
