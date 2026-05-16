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
    expires_at: Math.floor(Date.now() / 1000) + 60,
    token_type: "bearer",
  })}`;
}

describe("POST /api/artifacts/[artifactId]/export", () => {
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

  it("proxies artifact exports without rewriting response bodies", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response("# Publication Timeline\n", {
          status: 200,
          headers: {
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": 'attachment; filename="publication-timeline.md"',
            "x-nexus-artifact-export-id": "export-1",
          },
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request(
        "http://localhost:3000/api/artifacts/artifact-1/export?format=markdown",
        {
          method: "POST",
          headers: { cookie: sessionCookie() },
        }
      ),
      { params: Promise.resolve({ artifactId: "artifact-1" }) }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://fastapi.test/artifacts/artifact-1/export?format=markdown",
      expect.objectContaining({ method: "POST" })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="publication-timeline.md"'
    );
    expect(response.headers.get("x-nexus-artifact-export-id")).toBe("export-1");
    expect(await response.text()).toBe("# Publication Timeline\n");
  });
});
