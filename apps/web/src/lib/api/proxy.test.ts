import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@/lib/supabase/server";
import {
  parseCookieHeader,
  readSupabaseSessionCookie,
  type SessionCookieResult,
} from "@/lib/auth/session-cookie";
import { proxyToFastAPI, proxyToFastAPIWithDeps } from "./proxy";

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => {
    throw new Error("BFF proxy must not call Supabase session APIs");
  }),
}));

const SUPABASE_URL = "https://project-ref.supabase.co";
const COOKIE_NAME = "sb-project-ref-auth-token";

function encodeSessionCookie(session: Record<string, unknown>): string {
  return `base64-${Buffer.from(JSON.stringify(session), "utf8").toString(
    "base64url"
  )}`;
}

function sessionCookie(
  overrides: Record<string, unknown> = {},
  options: { chunked?: boolean } = {}
): string {
  const value = encodeSessionCookie({
    access_token: "server-token",
    expires_at: Math.floor(Date.now() / 1000) + 60,
    token_type: "bearer",
    refresh_token: "refresh-token-not-used",
    ...overrides,
  });

  if (!options.chunked) {
    return `${COOKIE_NAME}=${value}`;
  }

  const splitAt = Math.ceil(value.length / 2);
  return `${COOKIE_NAME}.0=${value.slice(0, splitAt)}; ${COOKIE_NAME}.1=${value.slice(splitAt)}`;
}

function readSessionFromCookie(request: Request): SessionCookieResult {
  return readSupabaseSessionCookie(
    parseCookieHeader(request.headers.get("cookie"))
  );
}

function deps({
  readSession = readSessionFromCookie,
  backendFetch = vi.fn(async () =>
    Response.json({ data: [] }, { headers: { "x-request-id": "request-1" } })
  ) as unknown as typeof fetch,
  internalSecret = "internal-secret",
  fastApiBaseUrl = "http://api.local",
}: {
  readSession?: (request: Request) => SessionCookieResult;
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

describe("proxyToFastAPI", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns a JSON 401 when the browser has no Supabase auth cookie", async () => {
    const backendFetch = vi.fn();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries"),
      "/libraries",
      deps({ backendFetch: backendFetch as unknown as typeof fetch })
    );

    await expectUnauthenticated(response);
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("returns a JSON 401 for an expired Supabase auth cookie", async () => {
    const backendFetch = vi.fn();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        headers: {
          cookie: sessionCookie({
            expires_at: Math.floor(Date.now() / 1000) - 60,
          }),
        },
      }),
      "/libraries",
      deps({ backendFetch: backendFetch as unknown as typeof fetch })
    );

    await expectUnauthenticated(response);
    expect(backendFetch).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toContain(`${COOKIE_NAME}=`);
  });

  it("returns a JSON 401 for a malformed Supabase auth cookie", async () => {
    const backendFetch = vi.fn();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        headers: {
          cookie: `${COOKIE_NAME}=not-a-supabase-session`,
        },
      }),
      "/libraries",
      deps({ backendFetch: backendFetch as unknown as typeof fetch })
    );

    await expectUnauthenticated(response);
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("requires the internal secret in production before reading auth cookies", async () => {
    vi.stubEnv("NODE_ENV", "production");
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
    vi.stubEnv("NODE_ENV", "production");
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

  it("forwards only server-owned auth headers to FastAPI", async () => {
    const backendFetch = vi.fn(async () =>
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
      deps({ backendFetch: backendFetch as unknown as typeof fetch })
    );

    expect(response.status).toBe(200);
    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [url, init] = backendFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = new Headers(init.headers);

    expect(url).toBe("http://api.local/libraries?view=mine");
    expect(headers.get("authorization")).toBe("Bearer cookie-token");
    expect(headers.get("x-nexus-internal")).toBe("internal-secret");
    expect(headers.get("x-request-id")).toBe("request-1");
    expect(headers.get("cookie")).toBeNull();
  });

  it("rejects spoofed request IDs that do not match the request ID grammar", async () => {
    const backendFetch = vi.fn(async () =>
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
      deps({ backendFetch: backendFetch as unknown as typeof fetch })
    );

    const [, init] = backendFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(new Headers(init.headers).get("x-request-id")).toBe(
      "generated-request"
    );
  });

  it("does not reflect invalid backend request IDs", async () => {
    const backendFetch = vi.fn(async () =>
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
      deps({ backendFetch: backendFetch as unknown as typeof fetch })
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
        backendFetch: vi.fn(
          (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("aborted", "AbortError"));
              });
            })
        ) as unknown as typeof fetch,
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
    const backendFetch = vi.fn(async () =>
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
    const [, init] = backendFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer default-cookie-token"
    );
  });
});
