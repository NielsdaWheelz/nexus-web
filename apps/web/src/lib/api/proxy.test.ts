/**
 * Unit tests for proxyToFastAPI BFF helper.
 *
 * These tests verify the complete proxy behavior per s2_pr00.md:
 * - Authentication (missing session → 401, session present → header attached)
 * - Internal header (env var set/unset)
 * - Query string forwarding
 * - Request body forwarding (raw bytes)
 * - Request header allowlist/blocklist
 * - Binary response handling
 * - Response header allowlist/blocklist
 * - X-Request-ID generation and propagation
 *
 * Uses the testable proxyToFastAPIWithDeps with injected dependencies.
 */

import { describe, it, expect, vi } from "vitest";
import {
  proxyToFastAPIWithDeps,
  ProxyDeps,
  REQUEST_ID_HEADER,
  _shouldForwardResponseHeader,
  _shouldForwardRequestHeader,
  _getOrGenerateRequestId,
  _isTextContentType,
} from "./proxy";

// Mock next/server - NextResponse.json for error responses
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => {
      const headers = new Headers(init?.headers);
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify(body), {
        status: init?.status || 200,
        headers,
      });
    },
  },
}));

/**
 * Create mock dependencies for testing.
 */
function createMockDeps(overrides: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    getSession: vi.fn().mockResolvedValue({ access_token: "test-token" }),
    fetch: vi.fn().mockResolvedValue(
      new Response('{"data": "ok"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ),
    generateRequestId: vi.fn().mockReturnValue("generated-request-id"),
    config: {
      fastApiBaseUrl: "http://fastapi:8000",
      internalSecret: "test-secret",
    },
    ...overrides,
  };
}

/**
 * Create a mock request with URL and options.
 */
function createMockRequest(
  options: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer;
  } = {}
): Request {
  const url = options.url || "http://localhost:3000/api/test";
  const headers = new Headers(options.headers || {});
  const init: RequestInit = {
    method: options.method || "GET",
    headers,
  };
  if (options.body && options.method !== "GET") {
    init.body = options.body;
  }
  return new Request(url, init);
}

// ============================================================================
// Helper Function Tests
// ============================================================================

describe("proxy helper functions", () => {
  describe("_getOrGenerateRequestId", () => {
    const generateFn = () => "generated-uuid";

    it("generates request ID when missing", () => {
      const request = createMockRequest();
      const requestId = _getOrGenerateRequestId(request, generateFn);
      expect(requestId).toBe("generated-uuid");
    });

    it("forwards existing request ID when present", () => {
      const request = createMockRequest({
        headers: { [REQUEST_ID_HEADER]: "existing-id" },
      });
      const requestId = _getOrGenerateRequestId(request, generateFn);
      expect(requestId).toBe("existing-id");
    });

    it("generates new ID when existing ID is too long (>128 chars)", () => {
      const longId = "a".repeat(200);
      const request = createMockRequest({
        headers: { [REQUEST_ID_HEADER]: longId },
      });
      const requestId = _getOrGenerateRequestId(request, generateFn);
      expect(requestId).toBe("generated-uuid");
    });

    it("preserves valid UUID request IDs", () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const request = createMockRequest({
        headers: { [REQUEST_ID_HEADER]: uuid },
      });
      const requestId = _getOrGenerateRequestId(request, generateFn);
      expect(requestId).toBe(uuid);
    });
  });

  describe("_shouldForwardResponseHeader", () => {
    it("allows x-request-id", () => {
      expect(_shouldForwardResponseHeader("x-request-id")).toBe(true);
      expect(_shouldForwardResponseHeader("X-Request-ID")).toBe(true);
    });

    it("allows content-type", () => {
      expect(_shouldForwardResponseHeader("content-type")).toBe(true);
      expect(_shouldForwardResponseHeader("Content-Type")).toBe(true);
    });

    it("allows content-length", () => {
      expect(_shouldForwardResponseHeader("content-length")).toBe(true);
      expect(_shouldForwardResponseHeader("Content-Length")).toBe(true);
    });

    it("allows cache-control", () => {
      expect(_shouldForwardResponseHeader("cache-control")).toBe(true);
      expect(_shouldForwardResponseHeader("Cache-Control")).toBe(true);
    });

    it("allows etag", () => {
      expect(_shouldForwardResponseHeader("etag")).toBe(true);
      expect(_shouldForwardResponseHeader("ETag")).toBe(true);
    });

    it("allows vary", () => {
      expect(_shouldForwardResponseHeader("vary")).toBe(true);
      expect(_shouldForwardResponseHeader("Vary")).toBe(true);
    });

    it("allows content-disposition", () => {
      expect(_shouldForwardResponseHeader("content-disposition")).toBe(true);
      expect(_shouldForwardResponseHeader("Content-Disposition")).toBe(true);
    });

    it("allows location", () => {
      expect(_shouldForwardResponseHeader("location")).toBe(true);
      expect(_shouldForwardResponseHeader("Location")).toBe(true);
    });

    it("blocks authorization header", () => {
      expect(_shouldForwardResponseHeader("authorization")).toBe(false);
      expect(_shouldForwardResponseHeader("Authorization")).toBe(false);
    });

    it("blocks x-nexus-internal header", () => {
      expect(_shouldForwardResponseHeader("x-nexus-internal")).toBe(false);
      expect(_shouldForwardResponseHeader("X-Nexus-Internal")).toBe(false);
    });

    it("blocks set-cookie header", () => {
      expect(_shouldForwardResponseHeader("set-cookie")).toBe(false);
      expect(_shouldForwardResponseHeader("Set-Cookie")).toBe(false);
    });

    it("blocks headers starting with x-internal-", () => {
      expect(_shouldForwardResponseHeader("x-internal-secret")).toBe(false);
      expect(_shouldForwardResponseHeader("X-Internal-Debug")).toBe(false);
    });

    it("blocks unknown headers not on allowlist", () => {
      expect(_shouldForwardResponseHeader("x-custom-header")).toBe(false);
      expect(_shouldForwardResponseHeader("x-unknown")).toBe(false);
    });
  });

  describe("_shouldForwardRequestHeader", () => {
    it("allows content-type", () => {
      expect(_shouldForwardRequestHeader("content-type")).toBe(true);
      expect(_shouldForwardRequestHeader("Content-Type")).toBe(true);
    });

    it("allows accept", () => {
      expect(_shouldForwardRequestHeader("accept")).toBe(true);
      expect(_shouldForwardRequestHeader("Accept")).toBe(true);
    });

    it("allows range", () => {
      expect(_shouldForwardRequestHeader("range")).toBe(true);
      expect(_shouldForwardRequestHeader("Range")).toBe(true);
    });

    it("allows if-none-match", () => {
      expect(_shouldForwardRequestHeader("if-none-match")).toBe(true);
      expect(_shouldForwardRequestHeader("If-None-Match")).toBe(true);
    });

    it("allows if-modified-since", () => {
      expect(_shouldForwardRequestHeader("if-modified-since")).toBe(true);
      expect(_shouldForwardRequestHeader("If-Modified-Since")).toBe(true);
    });

    it("blocks cookie header", () => {
      expect(_shouldForwardRequestHeader("cookie")).toBe(false);
      expect(_shouldForwardRequestHeader("Cookie")).toBe(false);
    });

    it("blocks authorization header (we override it)", () => {
      expect(_shouldForwardRequestHeader("authorization")).toBe(false);
      expect(_shouldForwardRequestHeader("Authorization")).toBe(false);
    });

    it("blocks x-nexus-internal header (we override it)", () => {
      expect(_shouldForwardRequestHeader("x-nexus-internal")).toBe(false);
      expect(_shouldForwardRequestHeader("X-Nexus-Internal")).toBe(false);
    });

    it("blocks unknown headers not on allowlist", () => {
      expect(_shouldForwardRequestHeader("x-custom-header")).toBe(false);
      expect(_shouldForwardRequestHeader("x-unknown")).toBe(false);
    });
  });

  describe("_isTextContentType", () => {
    it("returns true for application/json", () => {
      expect(_isTextContentType("application/json")).toBe(true);
      expect(_isTextContentType("application/json; charset=utf-8")).toBe(true);
    });

    it("returns true for text/* types", () => {
      expect(_isTextContentType("text/plain")).toBe(true);
      expect(_isTextContentType("text/html")).toBe(true);
      expect(_isTextContentType("text/html; charset=utf-8")).toBe(true);
    });

    it("returns false for binary types", () => {
      expect(_isTextContentType("image/png")).toBe(false);
      expect(_isTextContentType("application/octet-stream")).toBe(false);
      expect(_isTextContentType("application/pdf")).toBe(false);
    });

    it("returns false for null", () => {
      expect(_isTextContentType(null)).toBe(false);
    });
  });
});

// ============================================================================
// Authentication Tests
// ============================================================================

describe("proxyToFastAPIWithDeps - Authentication", () => {
  it("returns 401 when no session exists", async () => {
    const deps = createMockDeps({
      getSession: vi.fn().mockResolvedValue(null),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(response.status).toBe(401);
    expect(deps.fetch).not.toHaveBeenCalled();

    const body = await response.json();
    expect(body.error.code).toBe("E_UNAUTHENTICATED");
    expect(body.error.message).toBe("Authentication required");
    expect(body.error.request_id).toBe("generated-request-id");
  });

  it("returns 401 when session has no access_token", async () => {
    const deps = createMockDeps({
      getSession: vi.fn().mockResolvedValue({ access_token: null }),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(response.status).toBe(401);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("includes x-request-id in 401 response headers", async () => {
    const deps = createMockDeps({
      getSession: vi.fn().mockResolvedValue(null),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("generated-request-id");
  });

  it("attaches Authorization header when session exists", async () => {
    const deps = createMockDeps({
      getSession: vi.fn().mockResolvedValue({ access_token: "my-token" }),
    });

    const request = createMockRequest();
    await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(deps.fetch).toHaveBeenCalledOnce();
    const [, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchInit.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer my-token");
  });
});

// ============================================================================
// Internal Header Tests
// ============================================================================

describe("proxyToFastAPIWithDeps - Internal Header", () => {
  it("attaches X-Nexus-Internal header when env var is set", async () => {
    const deps = createMockDeps({
      config: {
        fastApiBaseUrl: "http://fastapi:8000",
        internalSecret: "secret-value",
      },
    });

    const request = createMockRequest();
    await proxyToFastAPIWithDeps(request, "/test", deps);

    const [, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchInit.headers as Headers;
    expect(headers.get("x-nexus-internal")).toBe("secret-value");
  });

  it("does not attach X-Nexus-Internal header when env var is empty", async () => {
    const deps = createMockDeps({
      config: {
        fastApiBaseUrl: "http://fastapi:8000",
        internalSecret: "",
      },
    });

    const request = createMockRequest();
    await proxyToFastAPIWithDeps(request, "/test", deps);

    const [, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchInit.headers as Headers;
    expect(headers.has("x-nexus-internal")).toBe(false);
  });
});

// ============================================================================
// Query String Tests
// ============================================================================

describe("proxyToFastAPIWithDeps - Query Strings", () => {
  it("forwards query string from request URL", async () => {
    const deps = createMockDeps();

    const request = createMockRequest({
      url: "http://localhost:3000/api/media/image?url=https%3A%2F%2Fexample.com",
    });
    await proxyToFastAPIWithDeps(request, "/media/image", deps);

    const [fetchUrl] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchUrl).toBe(
      "http://fastapi:8000/media/image?url=https%3A%2F%2Fexample.com"
    );
  });

  it("handles complex query strings with multiple params", async () => {
    const deps = createMockDeps();

    const request = createMockRequest({
      url: "http://localhost:3000/api/search?q=test&limit=10&offset=20",
    });
    await proxyToFastAPIWithDeps(request, "/search", deps);

    const [fetchUrl] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchUrl).toBe("http://fastapi:8000/search?q=test&limit=10&offset=20");
  });

  it("handles requests without query string", async () => {
    const deps = createMockDeps();

    const request = createMockRequest({
      url: "http://localhost:3000/api/libraries",
    });
    await proxyToFastAPIWithDeps(request, "/libraries", deps);

    const [fetchUrl] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchUrl).toBe("http://fastapi:8000/libraries");
  });

  it("throws synchronously if path contains query string", async () => {
    const deps = createMockDeps();
    const request = createMockRequest();

    await expect(
      proxyToFastAPIWithDeps(request, "/test?foo=bar", deps)
    ).rejects.toThrow(
      "Path must not contain query string. Query params are extracted from request URL."
    );
  });

  it("preserves encoded characters in query string", async () => {
    const deps = createMockDeps();

    // URL with special characters that need encoding
    const request = createMockRequest({
      url: "http://localhost:3000/api/media/image?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc",
    });
    await proxyToFastAPIWithDeps(request, "/media/image", deps);

    const [fetchUrl] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    // The query string should be preserved (URL API may normalize but semantically equivalent)
    expect(fetchUrl).toContain("url=https%3A%2F%2Fexample.com%2Fa%3Fb%3Dc");
  });
});

// ============================================================================
// Request Body Tests
// ============================================================================

describe("proxyToFastAPIWithDeps - Request Body", () => {
  it("forwards POST request body as raw bytes", async () => {
    const deps = createMockDeps();

    const jsonBody = JSON.stringify({ name: "test" });
    const request = createMockRequest({
      method: "POST",
      body: jsonBody,
      headers: { "content-type": "application/json" },
    });
    await proxyToFastAPIWithDeps(request, "/libraries", deps);

    const [, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];

    // Body should be ArrayBuffer
    expect(fetchInit.body).toBeInstanceOf(ArrayBuffer);

    // Decode to verify content
    const decoder = new TextDecoder();
    const decodedBody = decoder.decode(fetchInit.body);
    expect(decodedBody).toBe(jsonBody);
  });

  it("forwards Content-Type header from allowlist", async () => {
    const deps = createMockDeps();

    const request = createMockRequest({
      method: "POST",
      body: "test body",
      headers: { "content-type": "application/json" },
    });
    await proxyToFastAPIWithDeps(request, "/test", deps);

    const [, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchInit.headers as Headers;
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("does not send body for GET requests", async () => {
    const deps = createMockDeps();

    const request = createMockRequest({ method: "GET" });
    await proxyToFastAPIWithDeps(request, "/test", deps);

    const [, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchInit.body).toBeUndefined();
  });

  it("does not send body for HEAD requests", async () => {
    const deps = createMockDeps();

    const request = createMockRequest({ method: "HEAD" });
    await proxyToFastAPIWithDeps(request, "/test", deps);

    const [, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchInit.body).toBeUndefined();
  });
});

// ============================================================================
// Request Header Tests
// ============================================================================

describe("proxyToFastAPIWithDeps - Request Headers", () => {
  it("forwards allowlisted request headers", async () => {
    const deps = createMockDeps();

    const request = createMockRequest({
      headers: {
        Accept: "application/json",
        Range: "bytes=0-100",
        "If-None-Match": '"abc123"',
        "If-Modified-Since": "Wed, 21 Oct 2015 07:28:00 GMT",
      },
    });
    await proxyToFastAPIWithDeps(request, "/test", deps);

    const [, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchInit.headers as Headers;

    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("range")).toBe("bytes=0-100");
    expect(headers.get("if-none-match")).toBe('"abc123"');
    expect(headers.get("if-modified-since")).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
  });

  it("blocks cookie header from being forwarded", async () => {
    const deps = createMockDeps();

    const request = createMockRequest({
      headers: {
        Cookie: "session=abc123; other=value",
      },
    });
    await proxyToFastAPIWithDeps(request, "/test", deps);

    const [, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchInit.headers as Headers;

    expect(headers.has("cookie")).toBe(false);
  });

  it("overrides Authorization header even if present in request", async () => {
    const deps = createMockDeps({
      getSession: vi.fn().mockResolvedValue({ access_token: "correct-token" }),
    });

    const request = createMockRequest({
      headers: {
        Authorization: "Bearer malicious-token",
      },
    });
    await proxyToFastAPIWithDeps(request, "/test", deps);

    const [, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchInit.headers as Headers;

    expect(headers.get("authorization")).toBe("Bearer correct-token");
  });

  it("overrides X-Nexus-Internal header even if present in request", async () => {
    const deps = createMockDeps({
      config: {
        fastApiBaseUrl: "http://fastapi:8000",
        internalSecret: "correct-secret",
      },
    });

    const request = createMockRequest({
      headers: {
        "X-Nexus-Internal": "malicious-secret",
      },
    });
    await proxyToFastAPIWithDeps(request, "/test", deps);

    const [, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchInit.headers as Headers;

    expect(headers.get("x-nexus-internal")).toBe("correct-secret");
  });
});

// ============================================================================
// Binary Response Tests
// ============================================================================

describe("proxyToFastAPIWithDeps - Binary Response", () => {
  it("returns binary response with correct content-type for image/png", async () => {
    // Create a simple PNG-like binary payload
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const deps = createMockDeps({
      fetch: vi.fn().mockResolvedValue(
        new Response(pngBytes, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": "8",
          },
        })
      ),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(response.headers.get("content-type")).toBe("image/png");

    // Verify the binary bytes are correct
    const buffer = await response.arrayBuffer();
    const resultBytes = new Uint8Array(buffer);

    expect(resultBytes.length).toBe(8);
    expect(resultBytes[0]).toBe(0x89);
    expect(resultBytes[1]).toBe(0x50);
    expect(resultBytes[2]).toBe(0x4e);
    expect(resultBytes[3]).toBe(0x47);
  });

  it("returns text response for application/json", async () => {
    const jsonData = { data: { id: 1, name: "test" } };

    const deps = createMockDeps({
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify(jsonData), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      ),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(response.headers.get("content-type")).toBe("application/json");

    const body = await response.json();
    expect(body).toEqual(jsonData);
  });

  it("handles application/octet-stream as binary", async () => {
    const binaryData = new Uint8Array([0x01, 0x02, 0x03, 0x04]);

    const deps = createMockDeps({
      fetch: vi.fn().mockResolvedValue(
        new Response(binaryData, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        })
      ),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    const buffer = await response.arrayBuffer();
    const resultBytes = new Uint8Array(buffer);

    expect(resultBytes).toEqual(binaryData);
  });
});

// ============================================================================
// Response Header Tests
// ============================================================================

describe("proxyToFastAPIWithDeps - Response Headers", () => {
  it("forwards allowlisted response headers", async () => {
    const deps = createMockDeps({
      fetch: vi.fn().mockResolvedValue(
        new Response('{"data":"ok"}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": "14",
            "cache-control": "max-age=3600",
            etag: '"abc123"',
            vary: "Accept-Encoding",
            "content-disposition": "attachment; filename=test.json",
            location: "http://example.com/redirect",
            "x-request-id": "upstream-id",
          },
        })
      ),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("content-length")).toBe("14");
    expect(response.headers.get("cache-control")).toBe("max-age=3600");
    expect(response.headers.get("etag")).toBe('"abc123"');
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(response.headers.get("content-disposition")).toBe(
      "attachment; filename=test.json"
    );
    expect(response.headers.get("location")).toBe("http://example.com/redirect");
    expect(response.headers.get("x-request-id")).toBe("upstream-id");
  });

  it("strips blocklisted response headers", async () => {
    const deps = createMockDeps({
      fetch: vi.fn().mockResolvedValue(
        new Response('{"data":"ok"}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            authorization: "Bearer leaked-token",
            "x-nexus-internal": "internal-secret",
            "set-cookie": "session=abc123",
          },
        })
      ),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(response.headers.get("authorization")).toBeNull();
    expect(response.headers.get("x-nexus-internal")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("strips headers starting with x-internal-", async () => {
    const deps = createMockDeps({
      fetch: vi.fn().mockResolvedValue(
        new Response('{"data":"ok"}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-internal-debug": "debug-info",
            "x-internal-trace": "trace-id",
          },
        })
      ),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(response.headers.get("x-internal-debug")).toBeNull();
    expect(response.headers.get("x-internal-trace")).toBeNull();
  });

  it("includes x-request-id even if upstream omits it", async () => {
    const deps = createMockDeps({
      fetch: vi.fn().mockResolvedValue(
        new Response('{"data":"ok"}', {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      ),
      generateRequestId: vi.fn().mockReturnValue("local-request-id"),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(response.headers.get("x-request-id")).toBe("local-request-id");
  });

  it("preserves upstream x-request-id when present", async () => {
    const deps = createMockDeps({
      fetch: vi.fn().mockResolvedValue(
        new Response('{"data":"ok"}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "upstream-request-id",
          },
        })
      ),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(response.headers.get("x-request-id")).toBe("upstream-request-id");
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe("proxyToFastAPIWithDeps - Error Handling", () => {
  it("returns 503 when fetch fails", async () => {
    const deps = createMockDeps({
      fetch: vi.fn().mockRejectedValue(new Error("Network error")),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.error.code).toBe("E_INTERNAL");
    expect(body.error.message).toBe("Backend service unavailable");
    expect(body.error.request_id).toBe("generated-request-id");
  });

  it("includes x-request-id in error responses", async () => {
    const deps = createMockDeps({
      fetch: vi.fn().mockRejectedValue(new Error("Network error")),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("generated-request-id");
  });

  it("preserves upstream error status codes", async () => {
    const deps = createMockDeps({
      fetch: vi.fn().mockResolvedValue(
        new Response('{"error":{"code":"E_NOT_FOUND","message":"Not found"}}', {
          status: 404,
          statusText: "Not Found",
          headers: { "content-type": "application/json" },
        })
      ),
    });

    const request = createMockRequest();
    const response = await proxyToFastAPIWithDeps(request, "/test", deps);

    expect(response.status).toBe(404);
    expect(response.statusText).toBe("Not Found");
  });
});

// ============================================================================
// Request ID Propagation Tests
// ============================================================================

describe("proxyToFastAPIWithDeps - Request ID Propagation", () => {
  it("generates new request ID when not provided", async () => {
    const deps = createMockDeps({
      generateRequestId: vi.fn().mockReturnValue("new-uuid-12345"),
    });

    const request = createMockRequest();
    await proxyToFastAPIWithDeps(request, "/test", deps);

    const [, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchInit.headers as Headers;

    expect(headers.get("x-request-id")).toBe("new-uuid-12345");
  });

  it("forwards existing request ID to FastAPI", async () => {
    const deps = createMockDeps();

    const request = createMockRequest({
      headers: { "x-request-id": "existing-trace-id" },
    });
    await proxyToFastAPIWithDeps(request, "/test", deps);

    const [, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = fetchInit.headers as Headers;

    expect(headers.get("x-request-id")).toBe("existing-trace-id");
  });
});

// ============================================================================
// Integration-style Tests
// ============================================================================

describe("proxyToFastAPIWithDeps - Integration", () => {
  it("complete happy path: auth + headers + query string + response", async () => {
    const responseData = { data: { libraries: [] } };

    const deps = createMockDeps({
      getSession: vi.fn().mockResolvedValue({ access_token: "valid-token" }),
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify(responseData), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "response-id",
            "cache-control": "no-cache",
          },
        })
      ),
      config: {
        fastApiBaseUrl: "http://api.example.com",
        internalSecret: "prod-secret",
      },
    });

    const request = createMockRequest({
      url: "http://localhost:3000/api/libraries?limit=10",
      headers: {
        Accept: "application/json",
        Cookie: "session=should-not-forward",
        "x-request-id": "client-trace-id",
      },
    });

    const response = await proxyToFastAPIWithDeps(request, "/libraries", deps);

    // Verify fetch was called with correct URL and headers
    const [fetchUrl, fetchInit] = (deps.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];

    expect(fetchUrl).toBe("http://api.example.com/libraries?limit=10");

    const headers = fetchInit.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer valid-token");
    expect(headers.get("x-nexus-internal")).toBe("prod-secret");
    expect(headers.get("x-request-id")).toBe("client-trace-id");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.has("cookie")).toBe(false);

    // Verify response
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-request-id")).toBe("response-id");
    expect(response.headers.get("cache-control")).toBe("no-cache");

    const body = await response.json();
    expect(body).toEqual(responseData);
  });
});
