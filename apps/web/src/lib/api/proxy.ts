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
 * - X-Request-ID is generated/forwarded for tracing
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Header name for request correlation
 */
export const REQUEST_ID_HEADER = "X-Request-ID";

/**
 * Headers allowed to be forwarded from FastAPI response to browser.
 * All other headers are stripped.
 */
const ALLOWED_RESPONSE_HEADERS = new Set([
  "x-request-id",
  "content-type",
  "content-length",
]);

/**
 * Headers that must NEVER be forwarded to the browser.
 */
const BLOCKED_RESPONSE_HEADERS = new Set([
  "authorization",
  "x-nexus-internal",
  "set-cookie",
]);

/**
 * Generate a UUID v4 string for request correlation.
 */
function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Get the request ID from incoming request or generate a new one.
 */
function getOrGenerateRequestId(request: Request): string {
  const existing = request.headers.get(REQUEST_ID_HEADER);
  if (existing && existing.length <= 128) {
    return existing;
  }
  return generateRequestId();
}

/**
 * Check if a header should be forwarded to the browser.
 */
function shouldForwardHeader(headerName: string): boolean {
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
 * Get environment configuration for the proxy.
 */
function getConfig() {
  const fastApiBaseUrl = process.env.FASTAPI_BASE_URL || "http://localhost:8000";
  const internalSecret = process.env.NEXUS_INTERNAL_SECRET || "";
  const nexusEnv = process.env.NEXUS_ENV || "local";

  return { fastApiBaseUrl, internalSecret, nexusEnv };
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
 *
 * @param request - The incoming Next.js request
 * @param path - The FastAPI path to proxy to (e.g., "/me", "/libraries/123")
 * @returns Response from FastAPI with filtered headers
 */
export async function proxyToFastAPI(
  request: Request,
  path: string
): Promise<Response> {
  const config = getConfig();
  const requestId = getOrGenerateRequestId(request);

  // Get Supabase session for access token
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    // No session - return 401
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

  // Build the FastAPI URL
  const url = `${config.fastApiBaseUrl}${path}`;

  // Build headers for FastAPI request
  const headers: HeadersInit = {
    "Content-Type": request.headers.get("Content-Type") || "application/json",
    Authorization: `Bearer ${session.access_token}`,
    [REQUEST_ID_HEADER]: requestId,
  };

  // Add internal header if configured
  if (config.internalSecret) {
    headers["X-Nexus-Internal"] = config.internalSecret;
  }

  // Forward request body for non-GET methods
  let body: BodyInit | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.text();
  }

  try {
    // Make request to FastAPI
    const response = await fetch(url, {
      method: request.method,
      headers,
      body,
    });

    // Get response body
    const responseBody = await response.text();

    // Build filtered response headers
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (shouldForwardHeader(key)) {
        responseHeaders.set(key, value);
      }
    });

    // Always include X-Request-ID
    if (!responseHeaders.has(REQUEST_ID_HEADER)) {
      responseHeaders.set(REQUEST_ID_HEADER, requestId);
    }

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
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
 * Export for testing - check if a header should be forwarded
 */
export { shouldForwardHeader as _shouldForwardHeader };
export { getOrGenerateRequestId as _getOrGenerateRequestId };
