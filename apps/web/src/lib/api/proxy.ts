/**
 * BFF proxy helper for forwarding requests to FastAPI.
 *
 * This module provides the core proxy functionality for the Next.js BFF pattern.
 * All browser -> FastAPI communication flows through this proxy.
 *
 * Security constraints:
 * - Bearer tokens are never exposed to the browser
 * - Internal header (X-Nexus-Internal) is server-only
 * - Response headers are filtered via allowlist
 * - Request headers are filtered via allowlist/blocklist
 * - X-Request-ID is generated/forwarded for tracing
 * - Cookie and Set-Cookie are never forwarded
 *
 * Streaming (SSE) support (S3):
 * - `expectStream` option enables SSE passthrough without buffering
 * - SSE responses pipe upstream ReadableStream directly to browser
 * - Transport headers (cache-control, x-accel-buffering, connection) set for SSE correctness
 * - Abort propagation: client disconnect cancels upstream fetch
 *
 * @see docs/v1/s2/s2_prs/s2_pr00.md for full specification
 * @see docs/v1/s3/s3_prs/s3_pr07.md §4.1 for SSE streaming spec
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Header name for request correlation.
 */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Options for proxy behavior.
 */
export interface ProxyOptions {
  /** Hint that the upstream response will be SSE. Forces streaming path
      even if upstream content-type is mislabeled. */
  expectStream?: boolean;
}

/**
 * Request headers allowed to be forwarded from browser to FastAPI.
 * These are copied from the incoming request if present.
 */
const ALLOWED_REQUEST_HEADERS = new Set([
  "content-type",
  "accept",
  "range",
  "if-none-match",
  "if-modified-since",
  "idempotency-key",
]);

/**
 * Request headers that must NEVER be forwarded to FastAPI.
 * We override these with our own values.
 */
const BLOCKED_REQUEST_HEADERS = new Set([
  "cookie",
  "authorization",
  "x-nexus-internal",
]);

/**
 * Response headers allowed to be forwarded from FastAPI to browser.
 * All other headers are stripped.
 */
const ALLOWED_RESPONSE_HEADERS = new Set([
  "x-request-id",
  "content-type",
  "content-length",
  "cache-control",
  "etag",
  "vary",
  "content-disposition",
  "location",
]);

/**
 * Response headers that must NEVER be forwarded to the browser.
 * Blocklist always wins over allowlist.
 */
const BLOCKED_RESPONSE_HEADERS = new Set([
  "authorization",
  "x-nexus-internal",
  "set-cookie",
]);

/**
 * Dependencies that can be injected for testing.
 */
export interface ProxyDeps {
  /**
   * Function to get the Supabase session.
   * Returns null if no session exists.
   */
  getSession: () => Promise<{ access_token: string } | null>;

  /**
   * Function to make HTTP requests.
   */
  fetch: typeof fetch;

  /**
   * Function to generate a request ID.
   */
  generateRequestId: () => string;

  /**
   * Environment configuration.
   */
  config: {
    fastApiBaseUrl: string;
    internalSecret: string;
  };
}

/**
 * Generate a UUID v4 string for request correlation.
 */
function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Get the request ID from incoming request or generate a new one.
 */
function getOrGenerateRequestId(
  request: Request,
  generateFn: () => string
): string {
  const existing = request.headers.get(REQUEST_ID_HEADER);
  if (existing && existing.length <= 128) {
    return existing;
  }
  return generateFn();
}

/**
 * Check if a response header should be forwarded to the browser.
 */
function shouldForwardResponseHeader(headerName: string): boolean {
  const lowerName = headerName.toLowerCase();

  // Explicitly blocked headers are never forwarded
  if (BLOCKED_RESPONSE_HEADERS.has(lowerName)) {
    return false;
  }

  // Block any header starting with x-internal-
  if (lowerName.startsWith("x-internal-")) {
    return false;
  }

  // Only forward headers on the allowlist
  return ALLOWED_RESPONSE_HEADERS.has(lowerName);
}

/**
 * Check if a request header should be forwarded to FastAPI.
 */
function shouldForwardRequestHeader(headerName: string): boolean {
  const lowerName = headerName.toLowerCase();

  // Explicitly blocked headers are never forwarded
  if (BLOCKED_REQUEST_HEADERS.has(lowerName)) {
    return false;
  }

  // Only forward headers on the allowlist
  return ALLOWED_REQUEST_HEADERS.has(lowerName);
}

/**
 * Check if a content type represents text/JSON data.
 */
function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  // SSE is text/ but must NOT be buffered — handled separately
  if (lower.startsWith("text/event-stream")) return false;
  return lower.includes("application/json") || lower.includes("text/");
}

/**
 * Check if a response should be treated as SSE streaming.
 */
function isStreamingResponse(
  contentType: string | null,
  expectStream?: boolean
): boolean {
  if (expectStream) return true;
  if (!contentType) return false;
  return contentType.toLowerCase().startsWith("text/event-stream");
}

/**
 * Get default environment configuration.
 */
function getDefaultConfig() {
  const fastApiBaseUrl =
    process.env.FASTAPI_BASE_URL || "http://localhost:8000";
  const internalSecret = process.env.NEXUS_INTERNAL_SECRET || "";

  return { fastApiBaseUrl, internalSecret };
}

/**
 * Create default dependencies using real implementations.
 */
async function createDefaultDeps(): Promise<ProxyDeps> {
  const supabase = await createClient();

  return {
    getSession: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      return session;
    },
    fetch: globalThis.fetch,
    generateRequestId,
    config: getDefaultConfig(),
  };
}

/**
 * Core proxy implementation with injectable dependencies.
 *
 * This function is exported for testing. Production code should use proxyToFastAPI.
 *
 * @param request - The incoming Next.js request
 * @param path - The FastAPI path to proxy to (must not contain query string)
 * @param deps - Injectable dependencies
 * @param options - Proxy options (e.g., streaming hints)
 * @returns Response from FastAPI with filtered headers
 */
export async function proxyToFastAPIWithDeps(
  request: Request,
  path: string,
  deps: ProxyDeps,
  options?: ProxyOptions
): Promise<Response> {
  // Validate path does not contain query string (caller error)
  if (path.includes("?")) {
    throw new Error(
      "Path must not contain query string. Query params are extracted from request URL."
    );
  }

  const requestId = getOrGenerateRequestId(request, deps.generateRequestId);

  // Get session for access token
  const session = await deps.getSession();

  if (!session?.access_token) {
    // No session - return 401 with standard error envelope
    return NextResponse.json(
      {
        error: {
          code: "E_UNAUTHENTICATED",
          message: "Authentication required",
          request_id: requestId,
        },
      },
      {
        status: 401,
        headers: {
          [REQUEST_ID_HEADER]: requestId,
        },
      }
    );
  }

  // Extract query string from request URL
  const requestUrl = new URL(request.url);
  const queryString = requestUrl.search; // includes leading '?' if present

  // Build the FastAPI URL with query string
  const url = `${deps.config.fastApiBaseUrl}${path}${queryString}`;

  // Build headers for FastAPI request
  const headers = new Headers();

  // Forward allowed request headers
  request.headers.forEach((value, key) => {
    if (shouldForwardRequestHeader(key)) {
      headers.set(key, value);
    }
  });

  // Always set/override these headers
  headers.set("Authorization", `Bearer ${session.access_token}`);
  headers.set(REQUEST_ID_HEADER, requestId);

  // Add internal header if configured
  if (deps.config.internalSecret) {
    headers.set("X-Nexus-Internal", deps.config.internalSecret);
  }

  // Forward request body for non-GET/HEAD methods as raw bytes
  // For streaming routes, forward body as-is (do not call request.json())
  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  try {
    // Make request to FastAPI with abort signal propagation
    const response = await deps.fetch(url, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
    });

    // Check if this is an SSE streaming response
    const upstreamContentType = response.headers.get("content-type");
    if (isStreamingResponse(upstreamContentType, options?.expectStream)) {
      return buildStreamingResponse(response, requestId);
    }

    // Build filtered response headers (non-streaming path)
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (shouldForwardResponseHeader(key)) {
        responseHeaders.set(key, value);
      }
    });

    // Always include X-Request-ID (normalize to lowercase)
    if (!responseHeaders.has(REQUEST_ID_HEADER)) {
      responseHeaders.set(REQUEST_ID_HEADER, requestId);
    }

    // Handle response body based on content type
    const contentType = response.headers.get("content-type");

    if (isTextContentType(contentType)) {
      // Text/JSON response - use text() to preserve encoding
      const text = await response.text();
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } else {
      // Binary response - use arrayBuffer() to preserve bytes
      const buffer = await response.arrayBuffer();
      return new Response(buffer, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }
  } catch (error) {
    // Abort errors are expected on client disconnect — do not log as server errors
    if (error instanceof DOMException && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }

    // Network error or FastAPI unavailable
    console.error("FastAPI proxy error:", error);
    return NextResponse.json(
      {
        error: {
          code: "E_INTERNAL",
          message: "Backend service unavailable",
          request_id: requestId,
        },
      },
      {
        status: 503,
        headers: {
          [REQUEST_ID_HEADER]: requestId,
        },
      }
    );
  }
}

/**
 * Build a streaming SSE response that pipes upstream bytes directly to the browser.
 *
 * Transport headers are set directly for SSE correctness per §4.1.3 / §4.1.7.
 * These are NOT added to ALLOWED_RESPONSE_HEADERS; they apply only to the SSE code path.
 */
function buildStreamingResponse(
  upstream: Response,
  requestId: string
): Response {
  // Preserve upstream content-type or default to event-stream
  const ct =
    upstream.headers.get("content-type") ||
    "text/event-stream; charset=utf-8";

  const sseHeaders = new Headers({
    "content-type": ct,
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    [REQUEST_ID_HEADER]: requestId,
  });

  // If upstream has no body (e.g., error before stream starts), return as-is
  if (!upstream.body) {
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: sseHeaders,
    });
  }

  // Pipe the upstream ReadableStream directly — no transformation, no buffering
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: sseHeaders,
  });
}

/**
 * Proxy a request to FastAPI with proper authentication and headers.
 *
 * This function:
 * 1. Extracts the Supabase access token from the session
 * 2. Generates or forwards X-Request-ID for tracing
 * 3. Attaches Authorization and X-Nexus-Internal headers
 * 4. Forwards the request to FastAPI
 * 5. Filters response headers via allowlist
 * 6. For SSE: pipes upstream body directly (no buffering)
 *
 * @param request - The incoming Next.js request
 * @param path - The FastAPI path to proxy to (e.g., "/me", "/libraries/123")
 *               Must NOT contain query string - those are extracted from request URL
 * @param options - Optional proxy options (e.g., `{ expectStream: true }` for SSE)
 * @returns Response from FastAPI with filtered headers
 */
export async function proxyToFastAPI(
  request: Request,
  path: string,
  options?: ProxyOptions
): Promise<Response> {
  const deps = await createDefaultDeps();
  return proxyToFastAPIWithDeps(request, path, deps, options);
}

// Exports for testing
export {
  shouldForwardResponseHeader as _shouldForwardResponseHeader,
  shouldForwardRequestHeader as _shouldForwardRequestHeader,
  getOrGenerateRequestId as _getOrGenerateRequestId,
  isTextContentType as _isTextContentType,
  isStreamingResponse as _isStreamingResponse,
  buildStreamingResponse as _buildStreamingResponse,
  ALLOWED_REQUEST_HEADERS as _ALLOWED_REQUEST_HEADERS,
  BLOCKED_REQUEST_HEADERS as _BLOCKED_REQUEST_HEADERS,
  ALLOWED_RESPONSE_HEADERS as _ALLOWED_RESPONSE_HEADERS,
  BLOCKED_RESPONSE_HEADERS as _BLOCKED_RESPONSE_HEADERS,
};
