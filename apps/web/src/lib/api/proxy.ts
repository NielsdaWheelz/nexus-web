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
import {
  getInternalApiConfig,
  isInternalApiConfigured,
} from "@/lib/api/internal-config";
import { createRandomId } from "@/lib/createRandomId";
import {
  clearSupabaseAuthCookies,
  parseCookieHeader,
  readSupabaseSessionCookie,
  type SessionState,
} from "@/lib/auth/session-cookie";
import { refreshSession } from "@/lib/auth/refresh";
import { isAbortError } from "@/lib/errors";
import { type CookieToSet } from "@/lib/supabase/types";

const REQUEST_ID_HEADER = "x-request-id";
const FASTAPI_FETCH_TIMEOUT_MS = 30_000;

// Browsers send Origin on every cross-origin request and on same-origin
// state-changing requests, so a state-changing request whose Origin does not
// match the app's own origin is a cross-site forgery. SameSite alone is not a
// complete CSRF defense.
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
  "x-content-type-options",
  "content-security-policy",
  "accept-ranges",
  "content-range",
  "location",
  "x-nexus-artifact-export-id",
  "x-nexus-artifact-version",
  "x-nexus-artifact-content-sha256",
  "x-nexus-artifact-manifest-sha256",
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
  readSession: (request: Request) => SessionState;
  fetch: typeof fetch;
  generateRequestId: () => string;
  config: {
    fastApiBaseUrl: string;
    internalSecret: string;
  };
}

interface ExtensionProxyOptions {
  defaultAccept?: string;
  defaultContentType?: string;
  forwardHeaders?: readonly string[];
}

function isValidRequestId(value: string | null): value is string {
  return Boolean(value && /^[A-Za-z0-9._:-]{1,128}$/.test(value));
}

function getOrGenerateRequestId(
  request: Request,
  generateFn: () => string
): string {
  const existing = request.headers.get(REQUEST_ID_HEADER);
  if (isValidRequestId(existing)) {
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

function setBodyContentLength(headers: Headers, body: string | ArrayBuffer) {
  const byteLength =
    typeof body === "string"
      ? new TextEncoder().encode(body).byteLength
      : body.byteLength;
  headers.set("content-length", String(byteLength));
}

async function createDefaultDeps(): Promise<ProxyDeps> {
  return {
    readSession: (request) =>
      readSupabaseSessionCookie(
        parseCookieHeader(request.headers.get("cookie"))
      ),
    fetch: globalThis.fetch,
    generateRequestId: createRandomId,
    config: getInternalApiConfig(),
  };
}

export async function proxyToFastAPIWithDeps(
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

  if (!isInternalApiConfigured(deps.config)) {
    return NextResponse.json(
      {
        error: {
          code: "E_INTERNAL",
          message: "Backend service is not configured",
          request_id: requestId,
        },
      },
      {
        status: 500,
        headers: {
          [REQUEST_ID_HEADER]: requestId,
        },
      }
    );
  }

  // Extract query string from request URL
  const requestUrl = new URL(request.url);
  const queryString = requestUrl.search; // includes leading '?' if present

  // CSRF defense for state-changing methods: a same-origin browser request and
  // the Android WebView shell (which hosts the web origin) both send the app's
  // own Origin; any other Origin is a cross-site forgery.
  if (
    STATE_CHANGING_METHODS.has(request.method) &&
    request.headers.get("origin") !== requestUrl.origin
  ) {
    return NextResponse.json(
      {
        error: {
          code: "E_FORBIDDEN",
          message: "Cross-origin request rejected",
          request_id: requestId,
        },
      },
      {
        status: 403,
        headers: {
          [REQUEST_ID_HEADER]: requestId,
        },
      }
    );
  }

  const session = deps.readSession(request);

  // Resolve the bearer token to forward, refreshing inline when the session is
  // within the access-token expiry margin. `refreshable` is the only state that
  // produces rotated cookies for the proxied response.
  let accessToken: string;
  let rotatedCookies: CookieToSet[] = [];
  switch (session.state) {
    case "active":
      accessToken = session.accessToken;
      break;
    case "refreshable": {
      const refreshed = await refreshSession();
      if (refreshed.status === "failed") {
        return NextResponse.json(
          {
            error: {
              code: "E_UNAUTHENTICATED",
              message: "Authentication required",
              request_id: requestId,
            },
          },
          { status: 401, headers: { [REQUEST_ID_HEADER]: requestId } }
        );
      }
      refreshed.status satisfies "refreshed";
      // The rotated access token is inside the freshly written cookie; the
      // boundary parser is the one interpreter of that cookie shape.
      const rotated = readSupabaseSessionCookie(refreshed.cookiesToSet);
      if (rotated.state !== "active") {
        // justify-defect: a successful refresh must write a live access token;
        // a rotated cookie that does not parse as `active` is internal
        // corruption, not a recoverable auth outcome.
        console.error("auth_refresh_rotated_cookie_not_active", {
          state: rotated.state,
        });
        return NextResponse.json(
          {
            error: {
              code: "E_INTERNAL",
              message: "Session refresh failed",
              request_id: requestId,
            },
          },
          { status: 500, headers: { [REQUEST_ID_HEADER]: requestId } }
        );
      }
      accessToken = rotated.accessToken;
      rotatedCookies = refreshed.cookiesToSet;
      break;
    }
    case "ended":
    case "anonymous": {
      const response = NextResponse.json(
        {
          error: {
            code: "E_UNAUTHENTICATED",
            message: "Authentication required",
            request_id: requestId,
          },
        },
        { status: 401, headers: { [REQUEST_ID_HEADER]: requestId } }
      );
      clearSupabaseAuthCookies(response, session.cookieNames);
      return response;
    }
    default:
      session satisfies never;
      throw new Error(`Unhandled session state: ${JSON.stringify(session)}`);
  }

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
  headers.set("Authorization", `Bearer ${accessToken}`);
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

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FASTAPI_FETCH_TIMEOUT_MS);
  const abortFromClient = () => controller.abort();
  if (request.signal.aborted) {
    controller.abort();
  } else {
    request.signal.addEventListener("abort", abortFromClient, { once: true });
  }

  try {
    const response = await deps.fetch(url, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
    });

    // Build filtered response headers (non-streaming path)
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (shouldForwardResponseHeader(key)) {
        responseHeaders.set(key, value);
      }
    });

    const backendRequestId = response.headers.get(REQUEST_ID_HEADER);
    responseHeaders.set(
      REQUEST_ID_HEADER,
      isValidRequestId(backendRequestId) ? backendRequestId : requestId
    );

    // A response carrying rotated auth cookies must never be cached: a cached
    // Set-Cookie would hand one user another user's session.
    if (rotatedCookies.length > 0) {
      responseHeaders.set("cache-control", "no-store");
    }

    // 204/205/304 and HEAD responses must not include a body.
    // Creating a Response with body bytes for these statuses throws.
    let proxied: NextResponse;
    if (
      request.method === "HEAD" ||
      response.status === 204 ||
      response.status === 205 ||
      response.status === 304
    ) {
      proxied = new NextResponse(null, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } else if (isTextContentType(response.headers.get("content-type"))) {
      // Text/JSON response - use text() to preserve encoding
      const text = await response.text();
      setBodyContentLength(responseHeaders, text);
      proxied = new NextResponse(text, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } else {
      // Binary response - use arrayBuffer() to preserve bytes
      const buffer = await response.arrayBuffer();
      setBodyContentLength(responseHeaders, buffer);
      proxied = new NextResponse(buffer, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    for (const { name, value, options } of rotatedCookies) {
      proxied.cookies.set(name, value, options);
    }
    return proxied;
  } catch (error) {
    if (isAbortError(error)) {
      if (timedOut) {
        return NextResponse.json(
          {
            error: {
              code: "E_UPSTREAM_TIMEOUT",
              message: "Backend service timed out",
              request_id: requestId,
            },
          },
          {
            status: 504,
            headers: {
              [REQUEST_ID_HEADER]: requestId,
            },
          }
        );
      }
      return new Response(null, { status: 499 });
    }

    console.error("FastAPI proxy error:", error);
    return NextResponse.json(
      {
        error: {
          code: "E_UPSTREAM",
          message: "Backend service unavailable",
          request_id: requestId,
        },
      },
      {
        status: 502,
        headers: {
          [REQUEST_ID_HEADER]: requestId,
        },
      }
    );
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromClient);
  }
}

export async function proxyToFastAPI(
  request: Request,
  path: string
): Promise<Response> {
  const deps = await createDefaultDeps();
  return proxyToFastAPIWithDeps(request, path, deps);
}

export async function proxyExtensionToFastAPI(
  request: Request,
  path: string,
  options: ExtensionProxyOptions = {}
): Promise<Response> {
  const requestId = getOrGenerateRequestId(request, createRandomId);
  const authorization = request.headers.get("authorization") || "";

  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return NextResponse.json(
      {
        error: {
          code: "E_UNAUTHENTICATED",
          message: "Extension token required",
          request_id: requestId,
        },
      },
      {
        status: 401,
        headers: { [REQUEST_ID_HEADER]: requestId },
      }
    );
  }

  const config = getInternalApiConfig();
  const { fastApiBaseUrl, internalSecret } = config;
  if (!isInternalApiConfigured(config)) {
    return NextResponse.json(
      {
        error: {
          code: "E_INTERNAL",
          message: "Backend service is not configured",
          request_id: requestId,
        },
      },
      {
        status: 500,
        headers: { [REQUEST_ID_HEADER]: requestId },
      }
    );
  }

  const headers = new Headers({
    Authorization: authorization,
    [REQUEST_ID_HEADER]: requestId,
  });
  const contentType =
    request.headers.get("content-type") ?? options.defaultContentType;
  const accept = request.headers.get("accept") ?? options.defaultAccept;

  if (contentType) {
    headers.set("Content-Type", contentType);
  }
  if (accept) {
    headers.set("Accept", accept);
  }
  for (const headerName of options.forwardHeaders ?? []) {
    const value = request.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }
  if (internalSecret) {
    headers.set("X-Nexus-Internal", internalSecret);
  }

  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FASTAPI_FETCH_TIMEOUT_MS);
  const abortFromClient = () => controller.abort();
  if (request.signal.aborted) {
    controller.abort();
  } else {
    request.signal.addEventListener("abort", abortFromClient, { once: true });
  }

  try {
    const response = await fetch(`${fastApiBaseUrl}${path}`, {
      method: request.method,
      headers,
      body,
      signal: controller.signal,
    });
    const backendRequestId = response.headers.get(REQUEST_ID_HEADER);
    const responseHeaders = new Headers({
      [REQUEST_ID_HEADER]: isValidRequestId(backendRequestId)
        ? backendRequestId
        : requestId,
    });
    const responseContentType = response.headers.get("content-type");

    if (responseContentType) {
      responseHeaders.set("Content-Type", responseContentType);
    }

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

    if (isTextContentType(responseContentType)) {
      return new Response(await response.text(), {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    return new Response(await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (isAbortError(error)) {
      if (timedOut) {
        return NextResponse.json(
          {
            error: {
              code: "E_UPSTREAM_TIMEOUT",
              message: "Backend service timed out",
              request_id: requestId,
            },
          },
          {
            status: 504,
            headers: { [REQUEST_ID_HEADER]: requestId },
          }
        );
      }
      return new Response(null, { status: 499 });
    }

    console.error("Extension proxy error:", error);
    return NextResponse.json(
      {
        error: {
          code: "E_UPSTREAM",
          message: "Backend service unavailable",
          request_id: requestId,
        },
      },
      {
        status: 502,
        headers: { [REQUEST_ID_HEADER]: requestId },
      }
    );
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromClient);
  }
}
