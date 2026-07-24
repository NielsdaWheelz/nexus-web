import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/server";
import {
  parseCookieHeader,
  readSupabaseSessionCookie,
  type SessionState,
} from "@/lib/auth/session-cookie";
import { __resetEnvForTests } from "@/lib/env";
import { PUBLIC_API_CONTENT_SECURITY_POLICY } from "@/lib/security/csp";
import {
  proxyExtensionToFastAPI,
  proxyPublicToFastAPIWithDeps,
  proxyResourceShareToFastAPIWithDeps,
  proxyToFastAPI,
  proxyToFastAPIWithDeps,
} from "./proxy";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => {
    throw new Error("BFF proxy must not call Supabase session APIs");
  }),
}));

// The refresh module reads the request cookies through next/headers; the proxy
// itself never does. Mock only that true external boundary so the inline-refresh
// tests exercise the real refresh.ts and the real boundary parser.
const cookieStore = {
  getAll: vi.fn((): { name: string; value: string }[] => []),
  set: vi.fn(),
};
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
}));

// Mock only the Supabase SDK edge — the real external boundary refresh.ts calls.
// One scripted refresh outcome is consumed per refreshSession() call.
type RotatedCookie = { name: string; value: string; options?: object };
type RefreshOutcome = {
  cookiesToSet?: RotatedCookie[];
  error?: { code: string | null; message: string };
};
const refreshOutcomes: RefreshOutcome[] = [];
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(
    (
      _supabaseUrl: string,
      _supabaseAnonKey: string,
      options: {
        cookies: { setAll: (cookies: RotatedCookie[]) => void };
      }
    ) => ({
      auth: {
        refreshSession: async () => {
          const outcome = refreshOutcomes.shift() ?? {};
          if (outcome.error) {
            return { data: { user: null, session: null }, error: outcome.error };
          }
          if (outcome.cookiesToSet) {
            options.cookies.setAll(outcome.cookiesToSet);
          }
          return {
            data: { user: { id: "u1" }, session: { access_token: "rotated" } },
            error: null,
          };
        },
      },
    })
  ),
}));

const SUPABASE_URL = "https://project-ref.supabase.co";
const COOKIE_NAME = "sb-project-ref-auth-token";
const APP_ORIGIN = "http://localhost:3000";

function encodeSessionCookie(session: Record<string, unknown>): string {
  return `base64-${Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url"
  )}`;
}

function sessionCookieValue(overrides: Record<string, unknown> = {}): string {
  return encodeSessionCookie({
    access_token: "server-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: "bearer",
    refresh_token: "refresh-token",
    ...overrides,
  });
}

function sessionCookie(
  overrides: Record<string, unknown> = {},
  options: { chunked?: boolean } = {}
): string {
  const value = sessionCookieValue(overrides);

  if (!options.chunked) {
    return `${COOKIE_NAME}=${value}`;
  }

  const splitAt = Math.ceil(value.length / 2);
  return `${COOKIE_NAME}.0=${value.slice(0, splitAt)}; ${COOKIE_NAME}.1=${value.slice(splitAt)}`;
}

// A rotated auth cookie carrying a live, parseable access token. refresh.ts
// writes it; the proxy re-parses it to extract the new bearer token.
function rotatedAuthCookie(accessToken: string): RotatedCookie[] {
  return [
    {
      name: COOKIE_NAME,
      value: sessionCookieValue({ access_token: accessToken }),
      options: { path: "/", httpOnly: true, maxAge: 31_536_000 },
    },
  ];
}

function readSessionFromCookie(request: Request): SessionState {
  return readSupabaseSessionCookie(
    parseCookieHeader(request.headers.get("cookie"))
  );
}

function mockBackendFetch(
  implementation: typeof fetch = async () =>
    Response.json({ data: [] }, { headers: { "x-request-id": "request-1" } })
) {
  return vi.fn<typeof fetch>(implementation);
}

function firstFetchCall(
  fetchMock: ReturnType<typeof mockBackendFetch>
): [RequestInfo | URL, RequestInit] {
  const call = fetchMock.mock.calls[0];
  if (!call) {
    throw new Error("Expected backend fetch to be called");
  }
  const [url, init] = call;
  if (!init) {
    throw new Error("Expected backend fetch options");
  }
  return [url, init];
}

function deps({
  readSession = readSessionFromCookie,
  backendFetch = mockBackendFetch(),
  internalSecret = "internal-secret",
  fastApiBaseUrl = "http://api.local",
}: {
  readSession?: (request: Request) => SessionState;
  backendFetch?: typeof fetch;
  internalSecret?: string;
  fastApiBaseUrl?: string;
} = {}) {
  return {
    readSession,
    fetch: backendFetch,
    generateRequestId: () => "generated-request",
    config: { fastApiBaseUrl, internalSecret },
  };
}

async function expectUnauthenticated(
  response: Response,
  requestId = "generated-request"
) {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({
    error: {
      code: "E_UNAUTHENTICATED",
      message: "Authentication required",
      request_id: requestId,
    },
  });
}

function expectPublicResourceSecurityHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cross-origin-resource-policy")).toBe(
    "same-origin"
  );
  expect(response.headers.get("content-security-policy")).toBe(
    PUBLIC_API_CONTENT_SECURITY_POLICY
  );
  expect(response.headers.get("set-cookie")).toBeNull();
}

describe("proxyToFastAPI", () => {
  beforeEach(() => {
    __resetEnvForTests();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    cookieStore.getAll.mockReturnValue([]);
    refreshOutcomes.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns a JSON 401 when the browser has no Supabase auth cookie", async () => {
    const backendFetch = mockBackendFetch();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries"),
      "/libraries",
      deps({ backendFetch })
    );

    await expectUnauthenticated(response);
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("returns a JSON 401 and clears cookies for an ended session", async () => {
    const backendFetch = mockBackendFetch();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        headers: {
          cookie: sessionCookie({
            expires_at: Math.floor(Date.now() / 1000) - 60,
            refresh_token: "",
          }),
        },
      }),
      "/libraries",
      deps({ backendFetch })
    );

    await expectUnauthenticated(response);
    expect(backendFetch).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain(`${COOKIE_NAME}=`);
  });

  it("returns a JSON 401 for a malformed Supabase auth cookie", async () => {
    const backendFetch = mockBackendFetch();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        headers: {
          cookie: `${COOKIE_NAME}=not-a-supabase-session`,
        },
      }),
      "/libraries",
      deps({ backendFetch })
    );

    await expectUnauthenticated(response);
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("requires the internal secret in production before reading auth cookies", async () => {
    vi.stubEnv("NEXUS_ENV", "prod");
    const readSession = vi.fn(readSessionFromCookie);

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        headers: {
          cookie: sessionCookie(),
        },
      }),
      "/libraries",
      deps({
        readSession,
        internalSecret: "",
        fastApiBaseUrl: "https://api.example.com",
      })
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "E_INTERNAL",
        message: "Backend service is not configured",
        request_id: "generated-request",
      },
    });
    expect(readSession).not.toHaveBeenCalled();
  });

  it("requires the FastAPI URL in production before reading auth cookies", async () => {
    vi.stubEnv("NEXUS_ENV", "prod");
    const readSession = vi.fn(readSessionFromCookie);

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        headers: {
          cookie: sessionCookie(),
        },
      }),
      "/libraries",
      deps({
        readSession,
        fastApiBaseUrl: "",
      })
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "E_INTERNAL",
        message: "Backend service is not configured",
        request_id: "generated-request",
      },
    });
    expect(readSession).not.toHaveBeenCalled();
  });

  it("forwards an active session to FastAPI with the server-read bearer token", async () => {
    const backendFetch = mockBackendFetch(async () =>
      Response.json({ data: [] }, { headers: { "x-request-id": "request-1" } })
    );

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries?view=mine", {
        headers: {
          cookie: sessionCookie({ access_token: "cookie-token" }),
        },
      }),
      "/libraries",
      deps({ backendFetch })
    );

    expect(response.status).toBe(200);
    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [url, init] = firstFetchCall(backendFetch);
    expect(url).toBe("http://api.local/libraries?view=mine");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer cookie-token"
    );
  });

  it("forwards only server-owned auth headers to FastAPI", async () => {
    const backendFetch = mockBackendFetch(async () =>
      Response.json({ data: [] }, { headers: { "x-request-id": "request-1" } })
    );

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries?view=mine", {
        headers: {
          authorization: "Bearer browser-token",
          cookie: `${sessionCookie(
            { access_token: "cookie-token" },
            { chunked: true }
          )}; session=browser-cookie`,
          "content-type": "application/json",
          "x-nexus-internal": "spoofed",
          "x-request-id": "request-1",
        },
      }),
      "/libraries",
      deps({ backendFetch })
    );

    expect(response.status).toBe(200);
    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [url, init] = firstFetchCall(backendFetch);
    const headers = new Headers(init.headers);

    expect(url).toBe("http://api.local/libraries?view=mine");
    expect(headers.get("authorization")).toBe("Bearer cookie-token");
    expect(headers.get("x-nexus-internal")).toBe("internal-secret");
    expect(headers.get("x-request-id")).toBe("request-1");
    expect(headers.get("cookie")).toBeNull();
  });

  it("rejects spoofed request IDs that do not match the request ID grammar", async () => {
    const backendFetch = mockBackendFetch(async () =>
      Response.json(
        { data: [] },
        { headers: { "x-request-id": "generated-request" } }
      )
    );

    await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        headers: {
          cookie: sessionCookie(),
          "x-request-id": "bad request id",
        },
      }),
      "/libraries",
      deps({ backendFetch })
    );

    const [, init] = firstFetchCall(backendFetch);
    expect(new Headers(init.headers).get("x-request-id")).toBe(
      "generated-request"
    );
  });

  it("does not reflect invalid backend request IDs", async () => {
    const backendFetch = mockBackendFetch(async () =>
      Response.json(
        { data: [] },
        { headers: { "x-request-id": "bad request id" } }
      )
    );

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        headers: {
          cookie: sessionCookie(),
          "x-request-id": "request-1",
        },
      }),
      "/libraries",
      deps({ backendFetch })
    );

    expect(response.headers.get("x-request-id")).toBe("request-1");
  });

  it("returns JSON 504 when FastAPI exceeds the BFF deadline", async () => {
    vi.useFakeTimers();
    const responsePromise = proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        headers: {
          cookie: sessionCookie(),
        },
      }),
      "/libraries",
      deps({
        backendFetch: mockBackendFetch(
          (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"));
              });
            })
        ),
      })
    );

    await vi.advanceTimersByTimeAsync(30_000);
    const response = await responsePromise;

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: {
        code: "E_UPSTREAM_TIMEOUT",
        message: "Backend service timed out",
        request_id: "generated-request",
      },
    });
  });

  it("does not call Supabase session APIs on the default BFF path", async () => {
    vi.stubEnv("FASTAPI_BASE_URL", "http://api.local");
    vi.stubEnv("NEXUS_INTERNAL_SECRET", "internal-secret");
    const backendFetch = mockBackendFetch(async () =>
      Response.json({ data: [] }, { headers: { "x-request-id": "request-1" } })
    );
    vi.stubGlobal("fetch", backendFetch);

    const response = await proxyToFastAPI(
      new Request("http://localhost:3000/api/libraries", {
        headers: {
          cookie: sessionCookie({ access_token: "default-cookie-token" }),
        },
      }),
      "/libraries"
    );

    expect(response.status).toBe(200);
    expect(createClient).not.toHaveBeenCalled();
    const [, init] = firstFetchCall(backendFetch);
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer default-cookie-token"
    );
  });

  it("refreshes a refreshable session inline and forwards the rotated bearer token", async () => {
    const refreshableCookie = sessionCookie({
      access_token: "stale-token",
      expires_at: Math.floor(Date.now() / 1000) - 30,
      refresh_token: "rotate-me",
    });
    cookieStore.getAll.mockReturnValue(parseCookieHeader(refreshableCookie));
    refreshOutcomes.push({ cookiesToSet: rotatedAuthCookie("fresh-token") });

    const backendFetch = mockBackendFetch(async () =>
      Response.json({ data: [] }, { headers: { "x-request-id": "request-1" } })
    );

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        headers: { cookie: refreshableCookie },
      }),
      "/libraries",
      deps({ backendFetch })
    );

    expect(response.status).toBe(200);
    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [, init] = firstFetchCall(backendFetch);
    // The forwarded bearer token is the rotated one parsed from the new cookie.
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer fresh-token"
    );
    // The rotated cookie is carried back on the proxied response, uncacheable.
    expect(response.headers.get("set-cookie")).toContain(`${COOKIE_NAME}=`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a JSON 401 when an inline refresh fails", async () => {
    const refreshableCookie = sessionCookie({
      expires_at: Math.floor(Date.now() / 1000) - 30,
      refresh_token: "revoked-token",
    });
    cookieStore.getAll.mockReturnValue(parseCookieHeader(refreshableCookie));
    refreshOutcomes.push({
      error: { code: "refresh_token_not_found", message: "Not Found" },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const backendFetch = mockBackendFetch();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        headers: { cookie: refreshableCookie },
      }),
      "/libraries",
      deps({ backendFetch })
    );

    await expectUnauthenticated(response);
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("rejects a state-changing request from a disallowed Origin", async () => {
    const backendFetch = mockBackendFetch();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        method: "POST",
        headers: {
          cookie: sessionCookie(),
          origin: "https://evil.example.com",
        },
      }),
      "/libraries",
      deps({ backendFetch })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "E_FORBIDDEN",
        message: "Cross-origin request rejected",
        request_id: "generated-request",
      },
    });
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("rejects a state-changing request with no Origin header", async () => {
    const backendFetch = mockBackendFetch();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        method: "POST",
        headers: { cookie: sessionCookie() },
      }),
      "/libraries",
      deps({ backendFetch })
    );

    expect(response.status).toBe(403);
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("forwards a state-changing request from the app's own Origin", async () => {
    const backendFetch = mockBackendFetch(async () =>
      Response.json({ ok: true }, { headers: { "x-request-id": "request-1" } })
    );

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        method: "POST",
        headers: {
          cookie: sessionCookie({ access_token: "cookie-token" }),
          origin: APP_ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "lib" }),
      }),
      "/libraries",
      deps({ backendFetch })
    );

    expect(response.status).toBe(200);
    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [, init] = firstFetchCall(backendFetch);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer cookie-token"
    );
  });
});

describe("proxyPublicToFastAPI", () => {
  beforeEach(() => {
    __resetEnvForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("forwards only public asset request headers and server-owned internal auth", async () => {
    const backendFetch = mockBackendFetch(
      async () =>
        new Response("plate", {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": "5",
            "cache-control": "public, max-age=31536000, immutable",
            etag: '"plate"',
            "x-content-type-options": "nosniff",
            "x-request-id": "backend-request",
            "set-cookie": "secret=value",
            authorization: "Bearer backend",
            "x-internal-debug": "hidden",
          },
        })
    );

    const response = await proxyPublicToFastAPIWithDeps(
      new Request("http://localhost:3000/api/oracle/plates/id?size=256", {
        headers: {
          authorization: "Bearer browser-token",
          cookie: "session=browser-cookie",
          "if-none-match": '"old"',
          "x-nexus-internal": "spoofed",
          "x-request-id": "request-1",
        },
      }),
      "/oracle/plates/id",
      deps({ backendFetch })
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("plate");
    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [url, init] = firstFetchCall(backendFetch);
    const headers = new Headers(init.headers);

    expect(url).toBe("http://api.local/oracle/plates/id?size=256");
    expect(init.method).toBe("GET");
    expect(headers.get("x-nexus-internal")).toBe("internal-secret");
    expect(headers.get("if-none-match")).toBe('"old"');
    expect(headers.get("x-request-id")).toBe("request-1");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();

    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-length")).toBe("5");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(response.headers.get("etag")).toBe('"plate"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toBe("backend-request");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("authorization")).toBeNull();
    expect(response.headers.get("x-internal-debug")).toBeNull();
  });

  it("returns a 304 with no response body", async () => {
    const backendFetch = mockBackendFetch(
      async () =>
        new Response(null, {
          status: 304,
          headers: {
            etag: '"plate"',
            "x-request-id": "backend-request",
          },
        })
    );

    const response = await proxyPublicToFastAPIWithDeps(
      new Request("http://localhost:3000/api/oracle/plates/id", {
        headers: { "if-none-match": '"plate"' },
      }),
      "/oracle/plates/id",
      deps({ backendFetch })
    );

    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get("etag")).toBe('"plate"');
    expect(response.headers.get("x-request-id")).toBe("backend-request");
  });

  it("requires deployed FastAPI config before fetching", async () => {
    vi.stubEnv("NEXUS_ENV", "prod");
    const backendFetch = mockBackendFetch();
    const readSession = vi.fn(readSessionFromCookie);

    const response = await proxyPublicToFastAPIWithDeps(
      new Request("http://localhost:3000/api/oracle/plates/id"),
      "/oracle/plates/id",
      deps({ backendFetch, readSession, internalSecret: "" })
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "E_INTERNAL",
        message: "Backend service is not configured",
        request_id: "generated-request",
      },
    });
    expect(backendFetch).not.toHaveBeenCalled();
    expect(readSession).not.toHaveBeenCalled();
  });
});

describe("proxyResourceShareToFastAPI", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([404, 416, 422, 500])(
    "applies the complete public header suite to upstream %s responses",
    async (status) => {
      const backendFetch = mockBackendFetch(async () =>
        Response.json(
          {
            error: {
              code: status === 422 ? "E_INVALID_REQUEST" : "E_NOT_FOUND",
              message: status === 422 ? "Invalid pagination query" : "Share unavailable",
            },
          },
          {
            status,
            headers: {
              "content-security-policy": "default-src https:",
              "set-cookie": "private=leak",
            },
          }
        )
      );

      const response = await proxyResourceShareToFastAPIWithDeps(
        new Request(
          "http://localhost:3000/api/public/resource-share/fragments?limit=bad",
          { headers: { "x-nexus-share-token": "opaque" } }
        ),
        "/public/resource-share/fragments",
        deps({ backendFetch })
      );

      expect(response.status).toBe(status);
      expectPublicResourceSecurityHeaders(response);
      if (status === 422) {
        expect(await response.json()).toEqual({
          error: {
            code: "E_INVALID_REQUEST",
            message: "Invalid pagination query",
          },
        });
      }
    }
  );

  it("applies the complete public header suite to local method errors", async () => {
    const response = await proxyResourceShareToFastAPIWithDeps(
      new Request("http://localhost:3000/api/public/resource-share", {
        method: "POST",
      }),
      "/public/resource-share",
      deps()
    );

    expect(response.status).toBe(405);
    expectPublicResourceSecurityHeaders(response);
  });

  it("applies the complete public header suite when the upstream is unavailable", async () => {
    const backendFetch = mockBackendFetch(async () => {
      throw new TypeError("connection refused");
    });

    const response = await proxyResourceShareToFastAPIWithDeps(
      new Request("http://localhost:3000/api/public/resource-share"),
      "/public/resource-share",
      deps({ backendFetch })
    );

    expect(response.status).toBe(502);
    expectPublicResourceSecurityHeaders(response);
  });
});

describe("proxyExtensionToFastAPI", () => {
  beforeEach(() => {
    __resetEnvForTests();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("forwards the query string to FastAPI", async () => {
    vi.stubEnv("FASTAPI_BASE_URL", "http://api.local");
    vi.stubEnv("NEXUS_INTERNAL_SECRET", "internal-secret");
    const backendFetch = mockBackendFetch();
    vi.stubGlobal("fetch", backendFetch);

    const response = await proxyExtensionToFastAPI(
      new Request("http://localhost:3000/api/extension/sync?cursor=abc&limit=20", {
        headers: { authorization: "Bearer ext-token" },
      }),
      "/extension/sync"
    );

    expect(response.status).toBe(200);
    const [url] = firstFetchCall(backendFetch);
    expect(url).toBe("http://api.local/extension/sync?cursor=abc&limit=20");
  });
});
