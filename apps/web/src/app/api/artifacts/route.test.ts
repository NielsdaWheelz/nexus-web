import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

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

function authedRequest(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", sessionCookie());
  return new Request(input, { ...init, headers });
}

function lastFetchCall(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.at(-1);
  expect(call).toBeTruthy();
  return call as [string, RequestInit];
}

describe("/api/artifacts", () => {
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

  it("proxies artifact listing to the canonical artifacts backend path", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => Response.json({ data: [] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(
      authedRequest(
        "http://localhost:3000/api/artifacts?message_id=message-1&limit=20"
      )
    );

    expect(response.status).toBe(200);
    const [url, init] = lastFetchCall(fetchMock);
    expect(url).toBe("http://fastapi.test/artifacts?message_id=message-1&limit=20");
    expect(url).not.toContain("/messages/message-1/artifacts");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer test-access-token"
    );
  });

  it("proxies artifact creation to the canonical artifacts backend path", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => Response.json({ data: { id: "artifact-1" } }, { status: 201 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const body = JSON.stringify({
      message_id: "message-1",
      artifact_type: "study_guide",
    });
    const response = await POST(
      authedRequest("http://localhost:3000/api/artifacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    );

    expect(response.status).toBe(201);
    const [url, init] = lastFetchCall(fetchMock);
    expect(url).toBe("http://fastapi.test/artifacts");
    expect(url).not.toContain("/messages/message-1/artifacts");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json"
    );
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(body);
  });
});
