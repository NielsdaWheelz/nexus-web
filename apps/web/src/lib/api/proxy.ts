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
  parseCookieHeader,
  readSupabaseSessionCookie,
  type SessionState,
} from "@/lib/auth/session-cookie";
import { refreshSession } from "@/lib/auth/refresh";
import {
  AuthDependencyError,
  finalizeSessionResponse,
  type SessionEffect,
} from "@/lib/auth/session-response";
import { isAbortError } from "@/lib/errors";
import { PUBLIC_API_CONTENT_SECURITY_POLICY } from "@/lib/security/csp";

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
  "server-timing",
]);

// Private EPUB assets are the one authenticated byte-serving lane. It may
// forward representation length because its upstream request explicitly
// requires identity encoding; structured API responses never forward length.
const MEDIA_ASSET_RESPONSE_HEADERS = new Set([
  ...ALLOWED_RESPONSE_HEADERS,
  "content-length",
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
 * public asset proxy requires identity encoding upstream and streams those
 * exact representation bytes through without recomputing them.
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

const PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-disposition",
  "accept-ranges",
  "content-range",
  "cache-control",
  "referrer-policy",
  "x-robots-tag",
  "x-content-type-options",
  "cross-origin-resource-policy",
  "content-security-policy",
  "x-request-id",
]);

const PUBLIC_RESOURCE_SHARE_SECURITY_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": PUBLIC_API_CONTENT_SECURITY_POLICY,
} as const;

interface ProxyDeps {
  readSession: (request: Request) => SessionState;
  refreshSession: typeof refreshSession;
  fetch: typeof fetch;
  generateRequestId: () => string;
  appPublicOrigin: string;
  config: {
    fastApiBaseUrl: string;
    internalSecret: string;
  };
}

interface AuthenticatedProxyResponsePolicy {
  readonly allowedHeaders: ReadonlySet<string>;
  readonly requireIdentityEncoding: boolean;
}

const STRUCTURED_RESPONSE_POLICY: AuthenticatedProxyResponsePolicy = {
  allowedHeaders: ALLOWED_RESPONSE_HEADERS,
  requireIdentityEncoding: false,
};

const MEDIA_ASSET_RESPONSE_POLICY: AuthenticatedProxyResponsePolicy = {
  allowedHeaders: MEDIA_ASSET_RESPONSE_HEADERS,
  requireIdentityEncoding: true,
};

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

function shouldForwardResponseHeader(
  headerName: string,
  allowedHeaders: ReadonlySet<string>,
): boolean {
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
  return allowedHeaders.has(lowerName);
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

async function createDefaultDeps(): Promise<ProxyDeps> {
  const env = getEnv();
  return {
    readSession: (request) =>
      readSupabaseSessionCookie(
        parseCookieHeader(request.headers.get("cookie"))
      ),
    refreshSession,
    fetch: globalThis.fetch,
    generateRequestId: createRandomId,
    appPublicOrigin: env.appPublicOrigin,
    config: env.internalApi,
  };
}

async function proxyAuthenticatedToFastAPIWithDeps(
  request: Request,
  path: string,
  deps: ProxyDeps,
  responsePolicy: AuthenticatedProxyResponsePolicy,
): Promise<Response> {
  const proxyStartedAt = performance.now();
  // Validate path does not contain query string (caller error)
  if (path.includes("?")) {
    throw new Error(
      "Path must not contain query string. Query params are extracted from request URL."
    );
  }

  const requestId = getOrGenerateRequestId(request, deps.generateRequestId);

  const finalize = (response: NextResponse, effect: SessionEffect) =>
    finalizeSessionResponse(response, effect);

  const errorResponse = (
    status: number,
    code: string,
    message: string,
    effect: SessionEffect,
  ): NextResponse =>
    finalize(
      NextResponse.json(
        {
          error: {
            code,
            message,
            request_id: requestId,
          },
        },
        { status, headers: { [REQUEST_ID_HEADER]: requestId } },
      ),
      effect,
    );

  // Validate the injected config (the DI seam), not getEnv(): a base URL is required, and a
  // missing internal secret is tolerated only outside deployed envs.
  if (!deps.config.fastApiBaseUrl || (isDeployed() && !deps.config.internalSecret)) {
    return errorResponse(
      500,
      "E_INTERNAL",
      "Backend service is not configured",
      { kind: "Preserve" },
    );
  }

  // Extract query string from request URL
  const requestUrl = new URL(request.url);
  const queryString = requestUrl.search; // includes leading '?' if present

  // CSRF defense for state-changing methods: a same-origin browser request and
  // the Android WebView shell (which hosts the web origin) both send the
  // configured public Origin; request.url may reflect an internal proxy host.
  if (
    STATE_CHANGING_METHODS.has(request.method) &&
    request.headers.get("origin") !== deps.appPublicOrigin
  ) {
    return errorResponse(
      403,
      "E_FORBIDDEN",
      "Cross-origin request rejected",
      { kind: "Preserve" },
    );
  }

  const session = deps.readSession(request);

  let accessToken: string;
  let sessionEffect: SessionEffect = { kind: "Preserve" };
  switch (session.state) {
    case "active":
      accessToken = session.accessToken;
      break;
    case "refreshable": {
      let refreshed;
      try {
        refreshed = await deps.refreshSession();
      } catch (error) {
        if (error instanceof AuthDependencyError) {
          return errorResponse(
            503,
            "E_AUTH_UNAVAILABLE",
            "Authentication service unavailable",
            { kind: "Preserve" },
          );
        }
        return errorResponse(
          500,
          "E_INTERNAL",
          "Session resolution failed",
          { kind: "Preserve" },
        );
      }
      switch (refreshed.kind) {
        case "SessionEnded":
          return errorResponse(
            401,
            "E_UNAUTHENTICATED",
            "Authentication required",
            {
              kind: "Clear",
              cookieNames: [...new Set([...session.cookieNames, ...refreshed.cookieNames])],
              feedback: true,
            },
          );
        case "Refreshed": {
          const rotated = readSupabaseSessionCookie(refreshed.cookiesToSet);
          if (rotated.state !== "active") {
            return errorResponse(
              500,
              "E_INTERNAL",
              "Session resolution failed",
              { kind: "Preserve" },
            );
          }
          accessToken = rotated.accessToken;
          sessionEffect = {
            kind: "Rotate",
            cookiesToSet: refreshed.cookiesToSet,
          };
          break;
        }
      }
      break;
    }
    case "ended":
      return errorResponse(
        401,
        "E_UNAUTHENTICATED",
        "Authentication required",
        {
          kind: "Clear",
          cookieNames: session.cookieNames,
          feedback: true,
        },
      );
    case "anonymous":
      switch (session.reason) {
        case "missing":
          return errorResponse(
            401,
            "E_UNAUTHENTICATED",
            "Authentication required",
            { kind: "Preserve" },
          );
        case "malformed":
        case "non_bearer":
          return errorResponse(
            401,
            "E_UNAUTHENTICATED",
            "Authentication required",
            {
              kind: "Clear",
              cookieNames: session.cookieNames,
              feedback: true,
            },
          );
        case "bad_config":
          return errorResponse(
            500,
            "E_INTERNAL",
            "Session configuration is invalid",
            { kind: "Preserve" },
          );
      }
      throw new Error("unreachable session reason");
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
  if (responsePolicy.requireIdentityEncoding) {
    // The lane forwards byte-count and range metadata, so the upstream
    // representation must not be compressed and transparently decoded by
    // fetch before it reaches the browser-facing response.
    headers.set("Accept-Encoding", "identity");
  }

  const ctl = createTimedFetchController(
    request.signal,
    FASTAPI_FETCH_TIMEOUT_MS
  );

  try {
    // Read the body only after session resolution, and keep the read inside the
    // same response-owning boundary so a client abort or stream defect cannot
    // drop a successor cookie set produced above.
    let body: ArrayBuffer | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      body = await request.arrayBuffer();
    }

    const response = await deps.fetch(url, {
      method: request.method,
      headers,
      body,
      signal: ctl.signal,
    });

    // Each caller supplies one explicit representation policy. Structured API
    // responses exclude hop-specific Content-Length and let the browser-facing
    // runtime frame the body. The byte-serving asset policy can preserve it
    // only because that lane requires identity encoding upstream.
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (shouldForwardResponseHeader(key, responsePolicy.allowedHeaders)) {
        responseHeaders.set(key, value);
      }
    });

    const backendRequestId = response.headers.get(REQUEST_ID_HEADER);
    responseHeaders.set(
      REQUEST_ID_HEADER,
      isValidRequestId(backendRequestId) ? backendRequestId : requestId
    );
    responseHeaders.append(
      "server-timing",
      `nexus_bff;dur=${(performance.now() - proxyStartedAt).toFixed(2)}`
    );

    if (response.status === 401) {
      const cookieNames = [
        ...new Set([
          ...session.cookieNames,
          ...(sessionEffect.kind === "Rotate"
            ? sessionEffect.cookiesToSet.map(({ name }) => name)
            : []),
        ]),
      ];
      return errorResponse(
        401,
        "E_UNAUTHENTICATED",
        "Authentication required",
        { kind: "Clear", cookieNames, feedback: true },
      );
    }

    const responseBody =
      request.method === "HEAD" ||
      response.status === 204 ||
      response.status === 205 ||
      response.status === 304
        ? null
        : response.body;
    const proxied = new NextResponse(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

    return finalize(proxied, sessionEffect);
  } catch (error) {
    if (isAbortError(error)) {
      if (ctl.timedOut()) {
        return finalize(upstreamTimeoutResponse(requestId), sessionEffect);
      }
      return finalize(
        new NextResponse(null, {
          status: 499,
          headers: { [REQUEST_ID_HEADER]: requestId },
        }),
        sessionEffect,
      );
    }

    return finalize(upstreamUnavailableResponse(requestId), sessionEffect);
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

export async function proxyToFastAPIWithDeps(
  request: Request,
  path: string,
  deps: ProxyDeps,
): Promise<Response> {
  return proxyAuthenticatedToFastAPIWithDeps(
    request,
    path,
    deps,
    STRUCTURED_RESPONSE_POLICY,
  );
}

export async function proxyMediaAssetToFastAPI(
  request: Request,
  path: string,
): Promise<Response> {
  const deps = await createDefaultDeps();
  return proxyAuthenticatedToFastAPIWithDeps(
    request,
    path,
    deps,
    MEDIA_ASSET_RESPONSE_POLICY,
  );
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
  headers.set("Accept-Encoding", "identity");
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

function securePublicResourceShareResponse(response: Response): Response {
  for (const [name, value] of Object.entries(
    PUBLIC_RESOURCE_SHARE_SECURITY_HEADERS
  )) {
    response.headers.set(name, value);
  }
  response.headers.delete("set-cookie");
  return response;
}

export async function proxyResourceShareToFastAPI(
  request: Request,
  path: string
): Promise<Response> {
  const deps = await createDefaultDeps();
  return proxyResourceShareToFastAPIWithDeps(request, path, deps);
}

export async function proxyResourceShareToFastAPIWithDeps(
  request: Request,
  path: string,
  deps: ProxyDeps
): Promise<Response> {
  if (
    path.includes("?") ||
    (path !== "/public/resource-share" &&
      !path.startsWith("/public/resource-share/"))
  ) {
    throw new Error("Public resource-share proxy received an invalid path");
  }
  const requestId = getOrGenerateRequestId(request, deps.generateRequestId);
  if (request.method !== "GET") {
    return securePublicResourceShareResponse(
      NextResponse.json(
      {
        error: {
          code: "E_INVALID_REQUEST",
          message: "Method not allowed",
          request_id: requestId,
        },
      },
      {
        status: 405,
        headers: {
          Allow: "GET",
          [REQUEST_ID_HEADER]: requestId,
          "Cache-Control": "private, no-store",
        },
      }
      )
    );
  }

  const { fastApiBaseUrl, internalSecret } = deps.config;
  if (!fastApiBaseUrl || (isDeployed() && !internalSecret)) {
    return securePublicResourceShareResponse(
      NextResponse.json(
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
          "Cache-Control": "private, no-store",
        },
      }
      )
    );
  }

  const headers = new Headers({ [REQUEST_ID_HEADER]: requestId });
  headers.set("Accept-Encoding", "identity");
  const shareToken = request.headers.get("x-nexus-share-token");
  if (shareToken) {
    headers.set("X-Nexus-Share-Token", shareToken);
  }
  if (path === "/public/resource-share/file") {
    const range = request.headers.get("range");
    if (range) {
      headers.set("Range", range);
    }
  }
  if (internalSecret) {
    headers.set("X-Nexus-Internal", internalSecret);
  }

  const queryString = new URL(request.url).search;
  const ctl = createTimedFetchController(request.signal, FASTAPI_FETCH_TIMEOUT_MS);
  try {
    const response = await deps.fetch(
      `${fastApiBaseUrl}${path}${queryString}`,
      {
        method: "GET",
        headers,
        signal: ctl.signal,
      }
    );
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (PUBLIC_RESOURCE_SHARE_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });
    const backendRequestId = response.headers.get(REQUEST_ID_HEADER);
    responseHeaders.set(
      REQUEST_ID_HEADER,
      isValidRequestId(backendRequestId) ? backendRequestId : requestId
    );
    const body =
      response.status === 204 ||
      response.status === 205 ||
      response.status === 304
        ? null
        : response.body;
    return securePublicResourceShareResponse(
      new NextResponse(body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    );
  } catch (error) {
    if (isAbortError(error)) {
      if (ctl.timedOut()) {
        return securePublicResourceShareResponse(
          upstreamTimeoutResponse(requestId)
        );
      }
      return securePublicResourceShareResponse(
        new Response(null, {
          status: 499,
          headers: { [REQUEST_ID_HEADER]: requestId },
        })
      );
    }
    console.error("FastAPI public resource-share proxy error:", error);
    return securePublicResourceShareResponse(
      upstreamUnavailableResponse(requestId)
    );
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
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey) {
    headers.set("Idempotency-Key", idempotencyKey);
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
  headers.set("Accept-Encoding", "identity");

  let body: ArrayBuffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.arrayBuffer();
  }

  const ctl = createTimedFetchController(
    request.signal,
    FASTAPI_FETCH_TIMEOUT_MS
  );

  const queryString = new URL(request.url).search; // includes leading '?' if present

  try {
    const response = await fetch(`${fastApiBaseUrl}${path}${queryString}`, {
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

    const responseBody =
      request.method === "HEAD" ||
      response.status === 204 ||
      response.status === 205 ||
      response.status === 304
        ? null
        : response.body;
    return new Response(responseBody, {
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
