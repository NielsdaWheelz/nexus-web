/**
 * Unit tests for proxy helper functions.
 *
 * These tests verify pure, deterministic proxy helper behavior without
 * mocking internal modules or the network stack.
 */

import { describe, it, expect } from "vitest";
import {
  REQUEST_ID_HEADER,
  proxyToFastAPIWithDeps,
  type ProxyDeps,
  _shouldForwardResponseHeader,
  _shouldForwardRequestHeader,
  _getOrGenerateRequestId,
  _isTextContentType,
} from "./proxy";

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

    it("strips content-length (runtime recalculates after potential re-encoding)", () => {
      expect(_shouldForwardResponseHeader("content-length")).toBe(false);
      expect(_shouldForwardResponseHeader("Content-Length")).toBe(false);
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

    it("returns true for text/event-stream now that the BFF no longer proxies streams", () => {
      expect(_isTextContentType("text/event-stream")).toBe(true);
      expect(_isTextContentType("text/event-stream; charset=utf-8")).toBe(true);
    });
  });

  describe("proxyToFastAPIWithDeps", () => {
    it("preserves 204 no-content responses without constructing an invalid body", async () => {
      const request = createMockRequest({
        url: "http://localhost:3000/api/highlights/abc",
        method: "DELETE",
      });
      const deps: ProxyDeps = {
        getSession: async () => ({ access_token: "test-token" }),
        fetch: async () =>
          new Response(null, {
            status: 204,
            headers: {
              "content-type": "application/octet-stream",
            },
          }),
        generateRequestId: () => "request-id-1",
        config: {
          fastApiBaseUrl: "http://localhost:8000",
          internalSecret: "",
        },
      };

      const response = await proxyToFastAPIWithDeps(
        request,
        "/highlights/abc",
        deps
      );

      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    });

    it("treats ResponseAborted as client cancel instead of backend failure", async () => {
      const request = createMockRequest({
        url: "http://localhost:3000/api/media/abc/file",
        method: "GET",
      });
      const deps: ProxyDeps = {
        getSession: async () => ({ access_token: "test-token" }),
        fetch: async () => {
          const err = new Error("aborted by client");
          err.name = "ResponseAborted";
          throw err;
        },
        generateRequestId: () => "request-id-2",
        config: {
          fastApiBaseUrl: "http://localhost:8000",
          internalSecret: "",
        },
      };

      const response = await proxyToFastAPIWithDeps(
        request,
        "/media/abc/file",
        deps
      );

      expect(response.status).toBe(499);
      expect(await response.text()).toBe("");
    });
  });
});
