import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyToFastAPIWithDeps } from "./proxy";

describe("proxyToFastAPI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns a JSON 401 when the browser has no Supabase session", async () => {
    const backendFetch = vi.fn();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries"),
      "/libraries",
      {
        getSession: async () => null,
        fetch: backendFetch as unknown as typeof fetch,
        generateRequestId: () => "request-1",
        config: {
          fastApiBaseUrl: "http://api.local",
          internalSecret: "internal-secret",
        },
      }
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "E_UNAUTHENTICATED",
        message: "Authentication required",
        request_id: "request-1",
      },
    });
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("requires the internal secret in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const getSession = vi.fn();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries"),
      "/libraries",
      {
        getSession,
        fetch: vi.fn() as unknown as typeof fetch,
        generateRequestId: () => "request-1",
        config: {
          fastApiBaseUrl: "https://api.example.com",
          internalSecret: "",
        },
      }
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "E_INTERNAL",
        message: "Backend service is not configured",
        request_id: "request-1",
      },
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("requires the FastAPI URL in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const getSession = vi.fn();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries"),
      "/libraries",
      {
        getSession,
        fetch: vi.fn() as unknown as typeof fetch,
        generateRequestId: () => "request-1",
        config: {
          fastApiBaseUrl: "",
          internalSecret: "internal-secret",
        },
      }
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "E_INTERNAL",
        message: "Backend service is not configured",
        request_id: "request-1",
      },
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("returns a controlled error when Supabase session lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const backendFetch = vi.fn();

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries"),
      "/libraries",
      {
        getSession: async () => {
          throw new Error("auth unavailable");
        },
        fetch: backendFetch as unknown as typeof fetch,
        generateRequestId: () => "request-1",
        config: {
          fastApiBaseUrl: "http://api.local",
          internalSecret: "internal-secret",
        },
      }
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "E_INTERNAL",
        message: "Authentication service unavailable",
        request_id: "request-1",
      },
    });
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it("forwards only server-owned auth headers to FastAPI", async () => {
    const backendFetch = vi.fn(async () =>
      Response.json({ data: [] }, { headers: { "x-request-id": "request-1" } })
    );

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries?view=mine", {
        headers: {
          authorization: "Bearer browser-token",
          cookie: "session=browser-cookie",
          "content-type": "application/json",
          "x-nexus-internal": "spoofed",
          "x-request-id": "request-1",
        },
      }),
      "/libraries",
      {
        getSession: async () => ({ access_token: "server-token" }),
        fetch: backendFetch as unknown as typeof fetch,
        generateRequestId: () => "generated-request",
        config: {
          fastApiBaseUrl: "http://api.local",
          internalSecret: "internal-secret",
        },
      }
    );

    expect(response.status).toBe(200);
    expect(backendFetch).toHaveBeenCalledTimes(1);
    const [url, init] = backendFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = new Headers(init.headers);

    expect(url).toBe("http://api.local/libraries?view=mine");
    expect(headers.get("authorization")).toBe("Bearer server-token");
    expect(headers.get("x-nexus-internal")).toBe("internal-secret");
    expect(headers.get("x-request-id")).toBe("request-1");
    expect(headers.get("cookie")).toBeNull();
  });

  it("rejects spoofed request IDs that do not match the request ID grammar", async () => {
    const backendFetch = vi.fn(async () =>
      Response.json({ data: [] }, { headers: { "x-request-id": "generated-request" } })
    );

    await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        headers: {
          "x-request-id": "bad request id",
        },
      }),
      "/libraries",
      {
        getSession: async () => ({ access_token: "server-token" }),
        fetch: backendFetch as unknown as typeof fetch,
        generateRequestId: () => "generated-request",
        config: {
          fastApiBaseUrl: "http://api.local",
          internalSecret: "internal-secret",
        },
      }
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
      Response.json({ data: [] }, { headers: { "x-request-id": "bad request id" } })
    );

    const response = await proxyToFastAPIWithDeps(
      new Request("http://localhost:3000/api/libraries", {
        headers: {
          "x-request-id": "request-1",
        },
      }),
      "/libraries",
      {
        getSession: async () => ({ access_token: "server-token" }),
        fetch: backendFetch as unknown as typeof fetch,
        generateRequestId: () => "generated-request",
        config: {
          fastApiBaseUrl: "http://api.local",
          internalSecret: "internal-secret",
        },
      }
    );

    expect(response.headers.get("x-request-id")).toBe("request-1");
  });
});
