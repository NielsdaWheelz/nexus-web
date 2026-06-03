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
import { getEnv, isDeployed } from "@/lib/env";
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
 * Response headers forwarded for PUBLIC owned assets (oracle plates).
 * Unlike ALLOWED_RESPONSE_HEADERS this INCLUDES content-length because the
 * public asset proxy streams the upstream body through without recomputing it.
 * set-cookie/authorization/x-internal-* are implicitly blocked because only
 * allowlisted headers are forwarded.
 */
const PUBLIC_ASSET_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "cache-control",
  "etag",
  "x-content-type-options",
  "x-request-id",
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

type TimedFetchController = {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
};

function createTimedFetchController(
  clientSignal: AbortSignal,
  timeoutMs: number
): TimedFetchController {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromClient = () => controller.abort();
  if (clientSignal.aborted) {
    controller.abort();
  } else {
    clientSignal.addEventListener("abort", abortFromClient, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      clientSignal.removeEventListener("abort", abortFromClient);
    },
  };
}

function upstreamTimeoutResponse(requestId: string): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: "E_UPSTREAM_TIMEOUT",
        message: "Backend service timed out",
        request_id: requestId,
      },
    },
    { status: 504, headers: { [REQUEST_ID_HEADER]: requestId } }
  );
}

function upstreamUnavailableResponse(requestId: string): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: "E_UPSTREAM",
        message: "Backend service unavailable",
        request_id: requestId,
      },
    },
    { status: 502, headers: { [REQUEST_ID_HEADER]: requestId } }
  );
}

/**
 * Read the backend response body in the right shape for the request:
 * - null for HEAD/204/205/304 (body forbidden)
 * - text for JSON/text content types (preserves encoding)
 * - ArrayBuffer for everything else (preserves bytes)
 */
async function readProxiedBody(
  response: Response,
  request: Request
): Promise<string | ArrayBuffer | null> {
  if (
    request.method === "HEAD" ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304
  ) {
    return null;
  }
  if (isTextContentType(response.headers.get("content-type"))) {
    return await response.text();
  }
  return await response.arrayBuffer();
}

async function createDefaultDeps(): Promise<ProxyDeps> {
  return {
    readSession: (request) =>
      readSupabaseSessionCookie(
        parseCookieHeader(request.headers.get("cookie"))
      ),
    fetch: globalThis.fetch,
    generateRequestId: createRandomId,
    config: getEnv().internalApi,
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

  // Validate the injected config (the DI seam), not getEnv(): a base URL is required, and a
  // missing internal secret is tolerated only outside deployed envs.
  if (!deps.config.fastApiBaseUrl || (isDeployed() && !deps.config.internalSecret)) {
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

  const ctl = createTimedFetchController(
    request.signal,
    FASTAPI_FETCH_TIMEOUT_MS
  );

  try {
    const response = await deps.fetch(url, {
      method: request.method,
      headers,
      body,
      signal: ctl.signal,
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

    const responseBody = await readProxiedBody(response, request);
    if (responseBody !== null) {
      setBodyContentLength(responseHeaders, responseBody);
    }
    const proxied = new NextResponse(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

    for (const { name, value, options } of rotatedCookies) {
      proxied.cookies.set(name, value, options);
    }
    return proxied;
  } catch (error) {
    if (isAbortError(error)) {
      if (ctl.timedOut()) {
        return upstreamTimeoutResponse(requestId);
      }
      return new Response(null, { status: 499 });
    }

    console.error("FastAPI proxy error:", error);
    return upstreamUnavailableResponse(requestId);
  } finally {
    ctl.cleanup();
  }
}

export async function proxyToFastAPI(
  request: Request,
  path: string
): Promise<Response> {
  const deps = await createDefaultDeps();
  return proxyToFastAPIWithDeps(request, path, deps);
}

export async function proxyPublicToFastAPI(
  request: Request,
  path: string
): Promise<Response> {
  const deps = await createDefaultDeps();
  return proxyPublicToFastAPIWithDeps(request, path, deps);
}

export async function proxyPublicToFastAPIWithDeps(
  request: Request,
  path: string,
  deps: ProxyDeps
): Promise<Response> {
  if (path.includes("?")) {
    throw new Error(
      "Path must not contain query string. Query params are extracted from request URL."
    );
  }

  const requestId = getOrGenerateRequestId(request, deps.generateRequestId);
  const { fastApiBaseUrl, internalSecret } = deps.config;
  if (!fastApiBaseUrl || (isDeployed() && !internalSecret)) {
    return NextResponse.json(
      {
        error: {
          code: "E_INTERNAL",
          message: "Backend service is not configured",
          request_id: requestId,
        },
      },
      { status: 500, headers: { [REQUEST_ID_HEADER]: requestId } }
    );
  }

  const queryString = new URL(request.url).search;
  const headers = new Headers();
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch) {
    headers.set("if-none-match", ifNoneMatch);
  }
  headers.set(REQUEST_ID_HEADER, requestId);
  if (internalSecret) {
    headers.set("X-Nexus-Internal", internalSecret);
  }

  const ctl = createTimedFetchController(request.signal, FASTAPI_FETCH_TIMEOUT_MS);
  try {
    const response = await deps.fetch(`${fastApiBaseUrl}${path}${queryString}`, {
      method: "GET",
      headers,
      signal: ctl.signal,
    });

    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (PUBLIC_ASSET_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });
    const backendRequestId = response.headers.get(REQUEST_ID_HEADER);
    responseHeaders.set(
      REQUEST_ID_HEADER,
      isValidRequestId(backendRequestId) ? backendRequestId : requestId
    );

    // 304 carries no body; everything else streams straight through.
    const body = response.status === 304 ? null : response.body;
    return new NextResponse(body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (isAbortError(error)) {
      if (ctl.timedOut()) {
        return upstreamTimeoutResponse(requestId);
      }
      return new Response(null, { status: 499 });
    }
    console.error("FastAPI public proxy error:", error);
    return upstreamUnavailableResponse(requestId);
  } finally {
    ctl.cleanup();
  }
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

  const { fastApiBaseUrl, internalSecret } = getEnv().internalApi;

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

  const ctl = createTimedFetchController(
    request.signal,
    FASTAPI_FETCH_TIMEOUT_MS
  );

  try {
    const response = await fetch(`${fastApiBaseUrl}${path}`, {
      method: request.method,
      headers,
      body,
      signal: ctl.signal,
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

    return new Response(await readProxiedBody(response, request), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (isAbortError(error)) {
      if (ctl.timedOut()) {
        return upstreamTimeoutResponse(requestId);
      }
      return new Response(null, { status: 499 });
    }

    console.error("Extension proxy error:", error);
    return upstreamUnavailableResponse(requestId);
  } finally {
    ctl.cleanup();
  }
}
