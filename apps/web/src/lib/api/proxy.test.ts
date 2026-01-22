/**
 * Unit tests for proxyToFastAPI BFF helper.
 *
 * These tests verify:
 * - X-Request-ID generation and forwarding
 * - Response header allowlist enforcement
 * - Bearer token security (not exposed to browser)
 *
 * Uses Vitest with happy-dom environment for native Web API support.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  proxyToFastAPI,
  REQUEST_ID_HEADER,
  _shouldForwardHeader,
  _getOrGenerateRequestId,
} from "./proxy";
import { createClient } from "@/lib/supabase/server";

// Mock the Supabase server client
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
}));

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => {
      const headers = new Headers(init?.headers);
      return new Response(JSON.stringify(body), {
        status: init?.status || 200,
        headers,
      });
    },
  },
}));

// Get the mocked createClient
const mockCreateClient = vi.mocked(createClient);

// Helper to create a mock Supabase client with session
function mockSupabaseWithSession(accessToken: string | null) {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: {
          session: accessToken ? { access_token: accessToken } : null,
        },
      }),
    },
  } as unknown as Awaited<ReturnType<typeof createClient>>;
}

// Helper to create a mock request
function createMockRequest(
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Request {
  const headers = new Headers(options.headers || {});
  return new Request("http://localhost/test", {
    method: options.method || "GET",
    headers,
    body: options.method !== "GET" ? options.body : undefined,
  });
}

describe("proxyToFastAPI helper functions", () => {
  describe("_getOrGenerateRequestId", () => {
    it("generates request ID when missing", () => {
      const request = createMockRequest();
      const requestId = _getOrGenerateRequestId(request);

      // Should be a valid UUID format
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it("forwards existing request ID when present", () => {
      const existingId = "abc_def-123";
      const request = createMockRequest({
        headers: { [REQUEST_ID_HEADER]: existingId },
      });
      const requestId = _getOrGenerateRequestId(request);

      expect(requestId).toBe(existingId);
    });

    it("generates new ID when existing ID is too long", () => {
      const longId = "a".repeat(200);
      const request = createMockRequest({
        headers: { [REQUEST_ID_HEADER]: longId },
      });
      const requestId = _getOrGenerateRequestId(request);

      expect(requestId).not.toBe(longId);
      expect(requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it("preserves valid UUID request IDs", () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const request = createMockRequest({
        headers: { [REQUEST_ID_HEADER]: uuid },
      });
      const requestId = _getOrGenerateRequestId(request);

      expect(requestId).toBe(uuid);
    });
  });

  describe("_shouldForwardHeader", () => {
    it("allows X-Request-ID", () => {
      expect(_shouldForwardHeader("X-Request-ID")).toBe(true);
      expect(_shouldForwardHeader("x-request-id")).toBe(true);
    });

    it("allows Content-Type", () => {
      expect(_shouldForwardHeader("Content-Type")).toBe(true);
      expect(_shouldForwardHeader("content-type")).toBe(true);
    });

    it("allows Content-Length", () => {
      expect(_shouldForwardHeader("Content-Length")).toBe(true);
      expect(_shouldForwardHeader("content-length")).toBe(true);
    });

    it("blocks Authorization header", () => {
      expect(_shouldForwardHeader("Authorization")).toBe(false);
      expect(_shouldForwardHeader("authorization")).toBe(false);
    });

    it("blocks X-Nexus-Internal header", () => {
      expect(_shouldForwardHeader("X-Nexus-Internal")).toBe(false);
      expect(_shouldForwardHeader("x-nexus-internal")).toBe(false);
    });

    it("blocks Set-Cookie header", () => {
      expect(_shouldForwardHeader("Set-Cookie")).toBe(false);
      expect(_shouldForwardHeader("set-cookie")).toBe(false);
    });

    it("blocks headers starting with X-Internal-", () => {
      expect(_shouldForwardHeader("X-Internal-Secret")).toBe(false);
      expect(_shouldForwardHeader("x-internal-debug")).toBe(false);
    });

    it("blocks unknown headers not on allowlist", () => {
      expect(_shouldForwardHeader("X-Custom-Header")).toBe(false);
      expect(_shouldForwardHeader("X-Unknown")).toBe(false);
    });
  });
});

describe("proxyToFastAPI", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("generates request ID when missing", async () => {
    // Mock session with access token
    mockCreateClient.mockResolvedValueOnce(mockSupabaseWithSession("test-token"));

    // Mock fetch to FastAPI
    global.fetch = vi.fn(async () => {
      return new Response('{"data": "ok"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const request = createMockRequest(); // No X-Request-ID header
    await proxyToFastAPI(request, "/test");

    expect(global.fetch).toHaveBeenCalled();

    // Get the headers from the fetch call
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const fetchOptions = fetchCall[1] as RequestInit;
    const headers = fetchOptions.headers as Record<string, string>;

    // Should have generated a UUID
    expect(headers[REQUEST_ID_HEADER]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("forwards existing request ID", async () => {
    const existingRequestId = "abc_def-123";

    mockCreateClient.mockResolvedValueOnce(mockSupabaseWithSession("test-token"));

    global.fetch = vi.fn(async () => {
      return new Response('{"data": "ok"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const request = createMockRequest({
      headers: { [REQUEST_ID_HEADER]: existingRequestId },
    });
    await proxyToFastAPI(request, "/test");

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const fetchOptions = fetchCall[1] as RequestInit;
    const headers = fetchOptions.headers as Record<string, string>;

    expect(headers[REQUEST_ID_HEADER]).toBe(existingRequestId);
  });

  it("forwards allowed response headers", async () => {
    mockCreateClient.mockResolvedValueOnce(mockSupabaseWithSession("test-token"));

    // FastAPI responds with allowed headers
    global.fetch = vi.fn(async () => {
      return new Response('{"data": "ok"}', {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": "response-request-id",
        },
      });
    });

    const request = createMockRequest();
    const response = await proxyToFastAPI(request, "/test");

    // Both allowed headers should be forwarded
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("X-Request-ID")).toBe("response-request-id");
  });

  it("blocks internal response headers", async () => {
    mockCreateClient.mockResolvedValueOnce(mockSupabaseWithSession("test-token"));

    // FastAPI responds with internal headers that should be blocked
    global.fetch = vi.fn(async () => {
      return new Response('{"data": "ok"}', {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": "resp-id",
          "X-Nexus-Internal": "secret-value",
          "Set-Cookie": "session=abc123",
        },
      });
    });

    const request = createMockRequest();
    const response = await proxyToFastAPI(request, "/test");

    // Blocked headers should not be present
    expect(response.headers.get("X-Nexus-Internal")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();

    // Allowed headers should still be present
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("X-Request-ID")).toBe("resp-id");
  });

  it("does not expose Authorization to browser", async () => {
    mockCreateClient.mockResolvedValueOnce(mockSupabaseWithSession("test-token"));

    // FastAPI responds with Authorization header (should be stripped)
    global.fetch = vi.fn(async () => {
      return new Response('{"data": "ok"}', {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer leaked-token",
        },
      });
    });

    const request = createMockRequest();
    const response = await proxyToFastAPI(request, "/test");

    // Authorization should never be forwarded to browser
    expect(response.headers.get("Authorization")).toBeNull();
  });

  it("returns 401 when no session exists", async () => {
    // Mock no session
    mockCreateClient.mockResolvedValueOnce(mockSupabaseWithSession(null));

    const request = createMockRequest();
    const response = await proxyToFastAPI(request, "/test");

    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error.code).toBe("E_UNAUTHENTICATED");
  });

  it("includes X-Request-ID in 401 error responses", async () => {
    mockCreateClient.mockResolvedValueOnce(mockSupabaseWithSession(null));

    const request = createMockRequest();
    const response = await proxyToFastAPI(request, "/test");

    // Error response should include X-Request-ID header
    expect(response.headers.get("X-Request-ID")).toBeTruthy();

    // Error body should include request_id
    const body = await response.json();
    expect(body.error.request_id).toBeTruthy();
  });
});
