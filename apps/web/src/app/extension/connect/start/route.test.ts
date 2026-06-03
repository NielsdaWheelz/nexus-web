import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_OPERATION_DEADLINE_MS } from "@/lib/auth/internal-fetch";

const fetchSpy = vi.spyOn(globalThis, "fetch");
const SUPABASE_URL = "https://project-ref.supabase.co";
const AUTH_COOKIE_NAME = "sb-project-ref-auth-token";
const NOW_SECONDS = 1_900_000_000;
const previousFastApiBaseUrl = process.env.FASTAPI_BASE_URL;
const previousInternalSecret = process.env.NEXUS_INTERNAL_SECRET;
const previousRedirectOrigins = process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS;
const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

function encodeSessionCookie(session: Record<string, unknown>): string {
  return `base64-${Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url"
  )}`;
}

function authCookie(overrides: Record<string, unknown> = {}): string {
  return `${AUTH_COOKIE_NAME}=${encodeSessionCookie({
    access_token: "web-session-token",
    expires_at: NOW_SECONDS + 3600,
    token_type: "bearer",
    ...overrides,
  })}`;
}

describe("GET /extension/connect/start", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
    fetchSpy.mockReset();
    process.env.FASTAPI_BASE_URL = "http://api.local";
    process.env.NEXUS_INTERNAL_SECRET = "test-internal-secret";
    process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS = "https://extension.chromiumapp.org";
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects missing redirect_uri", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost:3000/extension/connect/start"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "E_INVALID_REQUEST", message: "redirect_uri is required" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects redirect origins that are not explicitly allowed", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/extension/connect/start?redirect_uri=https%3A%2F%2Fevil.example%2F"
      )
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "E_FORBIDDEN", message: "Extension redirect origin is not allowed" },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("redirects unauthenticated users through login", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/extension/connect/start?redirect_uri=https%3A%2F%2Fextension.chromiumapp.org%2F"
      )
    );

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") || "").pathname).toBe("/login");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("normalizes configured extension redirect origins", async () => {
    process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS =
      "https://EXTENSION.chromiumapp.org/";

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/extension/connect/start?redirect_uri=https%3A%2F%2Fextension.chromiumapp.org%2F"
      )
    );

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") || "").pathname).toBe("/login");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed when a configured extension redirect origin is invalid", async () => {
    process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS =
      "https://extension.chromiumapp.org/path";

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/extension/connect/start?redirect_uri=https%3A%2F%2Fextension.chromiumapp.org%2F"
      )
    );

    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("redirects users with a malformed session cookie through login", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/extension/connect/start?redirect_uri=https%3A%2F%2Fextension.chromiumapp.org%2F",
        { headers: { cookie: `${AUTH_COOKIE_NAME}=not-a-supabase-session` } }
      )
    );

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") || "").pathname).toBe("/login");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("redirects users whose access token has expired without a refresh token through login", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/extension/connect/start?redirect_uri=https%3A%2F%2Fextension.chromiumapp.org%2F",
        {
          headers: {
            cookie: authCookie({ expires_at: NOW_SECONDS - 10 }),
          },
        }
      )
    );

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") || "").pathname).toBe("/login");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("redirects a refreshable session through /auth/refresh and back to itself", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/extension/connect/start?redirect_uri=https%3A%2F%2Fextension.chromiumapp.org%2Fcallback",
        {
          headers: {
            cookie: authCookie({
              expires_at: NOW_SECONDS - 10,
              refresh_token: "web-refresh-token",
            }),
          },
        }
      )
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") || "");
    expect(location.pathname).toBe("/auth/refresh");
    expect(location.searchParams.get("next")).toBe(
      "/extension/connect/start?redirect_uri=https%3A%2F%2Fextension.chromiumapp.org%2Fcallback"
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("mints an extension session and redirects the token to the extension", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ data: { token: "nx_ext_session" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })
    );

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost:3000/extension/connect/start?redirect_uri=https%3A%2F%2Fextension.chromiumapp.org%2Fcallback",
        { headers: { cookie: authCookie() } }
      )
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [RequestInfo, RequestInit];
    expect(String(url)).toBe("http://api.local/auth/extension-sessions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer web-session-token");
    expect(new Headers(init?.headers).get("x-nexus-internal")).toBe(
      "test-internal-secret"
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") || "");
    expect(location.origin).toBe("https://extension.chromiumapp.org");
    expect(location.pathname).toBe("/callback");
    expect(new URLSearchParams(location.hash.slice(1)).get("token")).toBe("nx_ext_session");
  });

  it("redirects to the extension with an error when the FastAPI request exceeds its deadline", async () => {
    fetchSpy.mockImplementation((_input, init) => {
      const signal = (init as RequestInit | undefined)?.signal;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    });

    const { GET } = await import("./route");
    const responsePromise = GET(
      new Request(
        "http://localhost:3000/extension/connect/start?redirect_uri=https%3A%2F%2Fextension.chromiumapp.org%2Fcallback",
        { headers: { cookie: authCookie() } }
      )
    );

    await vi.advanceTimersByTimeAsync(AUTH_OPERATION_DEADLINE_MS);

    const response = await responsePromise;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") || "");
    expect(location.origin).toBe("https://extension.chromiumapp.org");
    expect(location.pathname).toBe("/callback");
    expect(new URLSearchParams(location.hash.slice(1)).get("error")).toBe(
      "session_failed"
    );
  });
});

afterEach(() => {
  if (previousFastApiBaseUrl === undefined) {
    delete process.env.FASTAPI_BASE_URL;
  } else {
    process.env.FASTAPI_BASE_URL = previousFastApiBaseUrl;
  }

  if (previousInternalSecret === undefined) {
    delete process.env.NEXUS_INTERNAL_SECRET;
  } else {
    process.env.NEXUS_INTERNAL_SECRET = previousInternalSecret;
  }

  if (previousRedirectOrigins === undefined) {
    delete process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS;
  } else {
    process.env.NEXUS_EXTENSION_REDIRECT_ORIGINS = previousRedirectOrigins;
  }

  if (previousSupabaseUrl === undefined) {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  } else {
    process.env.NEXT_PUBLIC_SUPABASE_URL = previousSupabaseUrl;
  }
});
