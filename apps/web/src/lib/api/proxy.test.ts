/**
 * Unit tests for proxy helper functions.
 *
 * These tests verify pure, deterministic proxy helper behavior without
 * mocking internal modules or the network stack.
 */

import { describe, it, expect } from "vitest";
import {
  REQUEST_ID_HEADER,
  _shouldForwardResponseHeader,
  _shouldForwardRequestHeader,
  _getOrGenerateRequestId,
  _isTextContentType,
  _isStreamingResponse,
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

    it("returns false for text/event-stream (handled by streaming path)", () => {
      expect(_isTextContentType("text/event-stream")).toBe(false);
      expect(_isTextContentType("text/event-stream; charset=utf-8")).toBe(false);
    });
  });

  describe("_isStreamingResponse", () => {
    it("returns true when expectStream is true", () => {
      expect(_isStreamingResponse(null, true)).toBe(true);
      expect(_isStreamingResponse("application/json", true)).toBe(true);
    });

    it("returns true for text/event-stream content type", () => {
      expect(_isStreamingResponse("text/event-stream", false)).toBe(true);
      expect(_isStreamingResponse("text/event-stream; charset=utf-8", false)).toBe(true);
    });

    it("returns false for non-SSE content types without hint", () => {
      expect(_isStreamingResponse("application/json", false)).toBe(false);
      expect(_isStreamingResponse("text/plain", false)).toBe(false);
      expect(_isStreamingResponse(null, false)).toBe(false);
    });
  });
});
