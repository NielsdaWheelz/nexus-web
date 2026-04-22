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
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const REQUEST_ID_HEADER = "x-request-id";

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

interface ProxyDeps {
  getSession: () => Promise<{ access_token: string } | null>;
  fetch: typeof fetch;
  generateRequestId: () => string;
  config: {
    fastApiBaseUrl: string;
    internalSecret: string;
  };
}

function generateRequestId(): string {
  return crypto.randomUUID();
}

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

function shouldForwardRequestHeader(headerName: string): boolean {
  const lowerName = headerName.toLowerCase();

  // Explicitly blocked headers are never forwarded
  if (BLOCKED_REQUEST_HEADERS.has(lowerName)) {
    return false;
  }

  // Only forward headers on the allowlist
  return ALLOWED_REQUEST_HEADERS.has(lowerName);
}

function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("application/json") || lower.includes("text/");
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name?: unknown }).name;
    return name === "AbortError" || name === "ResponseAborted";
  }
  return false;
}

function getDefaultConfig() {
  const fastApiBaseUrl =
    process.env.FASTAPI_BASE_URL || "http://localhost:8000";
  const internalSecret = process.env.NEXUS_INTERNAL_SECRET || "";

  return { fastApiBaseUrl, internalSecret };
}

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

async function proxyToFastAPIWithDeps(
  request: Request,
  path: string,
  deps: ProxyDeps
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

  // Forward request body for non-GET/HEAD methods as raw bytes.
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

    // 204/205/304 and HEAD responses must not include a body.
    // Creating a Response with body bytes for these statuses throws.
    if (
      request.method === "HEAD" ||
      response.status === 204 ||
      response.status === 205 ||
      response.status === 304
    ) {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
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
    if (isAbortLikeError(error)) {
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

export async function proxyToFastAPI(
  request: Request,
  path: string
): Promise<Response> {
  const deps = await createDefaultDeps();
  return proxyToFastAPIWithDeps(request, path, deps);
}
