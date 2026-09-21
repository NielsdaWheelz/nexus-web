import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { createRandomId } from "@/lib/createRandomId";
import {
  parseCookieHeader,
  readSupabaseSessionCookie,
} from "@/lib/auth/session-cookie";
import {
  AuthDependencyError,
  finalizeSessionResponse,
  type SessionEffect,
} from "@/lib/auth/session-response";
import { isAbortError } from "@/lib/errors";
import { PUBLIC_API_CONTENT_SECURITY_POLICY } from "@/lib/security/csp";

const REQUEST_HEADERS = [
  "content-type", "accept", "range", "if-none-match", "if-modified-since",
  "idempotency-key", "x-nexus-tool-projection",
];
const RESPONSE_HEADERS = [
  "content-type", "cache-control", "etag", "vary", "content-disposition",
  "x-content-type-options", "content-security-policy", "accept-ranges",
  "content-range", "location", "server-timing",
];
const SHARE_SECURITY_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": PUBLIC_API_CONTENT_SECURITY_POLICY,
};

function requestId(value: string | null): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : createRandomId();
}

function pickHeaders(
  source: Headers,
  names: readonly string[],
  allowEmpty = false,
): Headers {
  const headers = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null && (allowEmpty || value !== "")) headers.set(name, value);
  }
  return headers;
}

function proxyError(
  id: string,
  status: number,
  code: string,
  message: string,
): NextResponse {
  return NextResponse.json(
    { error: { code, message, request_id: id } },
    { status, headers: { "x-request-id": id } },
  );
}

// One transport owner. Callers supply only the headers their trust lane owns;
// upstream credentials and cookies are never copied to the outgoing response.
async function forward({
  request, path, id, headers, responseHeaderNames,
  method = request.method, body,
}: {
  request: Request;
  path: string;
  id: string;
  headers: Headers;
  responseHeaderNames: readonly string[];
  method?: string;
  body?: ArrayBuffer;
}): Promise<NextResponse> {
  const { fastApiBaseUrl, internalSecret } = getEnv().internalApi;
  headers.set("x-request-id", id);
  if (internalSecret) headers.set("x-nexus-internal", internalSecret);

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 30_000);
  const abort = () => controller.abort();
  if (request.signal.aborted) abort();
  else request.signal.addEventListener("abort", abort, { once: true });

  try {
    if (body === undefined && method !== "GET" && method !== "HEAD") {
      body = await request.arrayBuffer();
    }
    const upstream = await fetch(`${fastApiBaseUrl}${path}${new URL(request.url).search}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const responseHeaders = pickHeaders(upstream.headers, responseHeaderNames, true);
    const upstreamId = upstream.headers.get("x-request-id");
    responseHeaders.set(
      "x-request-id",
      upstreamId && /^[A-Za-z0-9._:-]{1,128}$/.test(upstreamId) ? upstreamId : id,
    );
    return new NextResponse(
      method === "HEAD" || [204, 205, 304].includes(upstream.status) ? null : upstream.body,
      { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders },
    );
  } catch (error) {
    if (isAbortError(error)) {
      return timedOut
        ? proxyError(id, 504, "E_UPSTREAM_TIMEOUT", "Backend service timed out")
        : new NextResponse(null, { status: 499, headers: { "x-request-id": id } });
    }
    console.error("FastAPI proxy error:", error);
    return proxyError(id, 502, "E_UPSTREAM", "Backend service unavailable");
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abort);
  }
}

type SessionLane = "Structured" | "MediaAsset" | "OfflineReaderProgress";

async function proxySession(
  request: Request,
  path: string,
  lane: SessionLane,
): Promise<Response> {
  const startedAt = performance.now();
  if (path.includes("?")) {
    throw new Error("Path must not contain query string. Query params are extracted from request URL.");
  }
  const id = requestId(request.headers.get("x-request-id"));
  const fail = (
    status: number,
    code: string,
    message: string,
    effect: SessionEffect = { kind: "Preserve" },
  ) => finalizeSessionResponse(proxyError(id, status, code, message), effect);
  const endSession = (cookieNames: readonly string[]) =>
    fail(401, "E_UNAUTHENTICATED", "Authentication required", {
      kind: "Clear", cookieNames, feedback: true,
    });

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
    request.headers.get("origin") !== getEnv().appPublicOrigin
  ) {
    return fail(403, "E_FORBIDDEN", "Cross-origin request rejected");
  }
  const session = readSupabaseSessionCookie(parseCookieHeader(request.headers.get("cookie")));
  let accessToken: string;
  let effect: SessionEffect = { kind: "Preserve" };
  switch (session.state) {
    case "active":
      accessToken = session.accessToken;
      break;
    case "refreshable": {
      const { refreshSession } = await import("@/lib/auth/refresh");
      let refreshed;
      try {
        refreshed = await refreshSession();
      } catch (error) {
        return error instanceof AuthDependencyError
          ? fail(503, "E_AUTH_UNAVAILABLE", "Authentication service unavailable")
          : fail(500, "E_INTERNAL", "Session resolution failed");
      }
      if (refreshed.kind === "SessionEnded") {
        return endSession([...new Set([...session.cookieNames, ...refreshed.cookieNames])]);
      }
      const rotated = readSupabaseSessionCookie(refreshed.cookiesToSet);
      if (rotated.state !== "active") {
        return fail(500, "E_INTERNAL", "Session resolution failed");
      }
      accessToken = rotated.accessToken;
      effect = { kind: "Rotate", cookiesToSet: refreshed.cookiesToSet };
      break;
    }
    case "ended":
      return endSession(session.cookieNames);
    case "anonymous":
      switch (session.reason) {
        case "missing":
          return fail(401, "E_UNAUTHENTICATED", "Authentication required");
        case "malformed":
        case "non_bearer":
          return endSession(session.cookieNames);
        case "bad_config":
          return fail(500, "E_INTERNAL", "Session configuration is invalid");
      }
      session satisfies never;
      // justify-defect: every parsed cookie reason is handled above.
      throw new Error("unreachable session reason");
  }

  const headers = pickHeaders(
    request.headers,
    lane === "OfflineReaderProgress"
      ? [...REQUEST_HEADERS, "x-nexus-expected-account-id"] : REQUEST_HEADERS,
    true,
  );
  headers.set("authorization", `Bearer ${accessToken}`);
  if (lane === "MediaAsset") headers.set("accept-encoding", "identity");
  let responseHeaderNames = RESPONSE_HEADERS;
  if (lane === "MediaAsset") {
    responseHeaderNames = [...RESPONSE_HEADERS, "content-length"];
  } else if (lane === "OfflineReaderProgress") {
    responseHeaderNames = [...RESPONSE_HEADERS, "nexus-account-id", "nexus-reader-generation"];
  }
  const response = await forward({ request, path, id, headers, responseHeaderNames });
  if (response.status === 401) {
    return endSession([...new Set([
      ...session.cookieNames,
      ...(effect.kind === "Rotate" ? effect.cookiesToSet.map(({ name }) => name) : []),
    ])]);
  }
  response.headers.append(
    "server-timing", `nexus_bff;dur=${(performance.now() - startedAt).toFixed(2)}`,
  );
  // The response owner publishes a refreshed session even on transport failure.
  return finalizeSessionResponse(response, effect);
}

export async function proxyToFastAPI(
  request: Request, path: string,
): Promise<Response> {
  return proxySession(request, path, "Structured");
}

export async function proxyMediaAssetToFastAPI(
  request: Request, path: string,
): Promise<Response> {
  return proxySession(request, path, "MediaAsset");
}

export async function proxyOfflineReaderProgressToFastAPI(
  request: Request, path: string,
): Promise<Response> {
  return proxySession(request, path, "OfflineReaderProgress");
}

export async function proxyPublicToFastAPI(
  request: Request, path: string,
): Promise<Response> {
  if (path.includes("?")) {
    throw new Error("Path must not contain query string. Query params are extracted from request URL.");
  }
  const headers = pickHeaders(request.headers, ["if-none-match"]);
  headers.set("accept-encoding", "identity");
  return forward({
    request, path, headers,
    id: requestId(request.headers.get("x-request-id")),
    responseHeaderNames: [
      "content-type", "content-length", "cache-control", "etag", "x-content-type-options",
    ],
    method: "GET",
  });
}

export async function proxyResourceShareToFastAPI(
  request: Request, path: string,
): Promise<Response> {
  if (
    path.includes("?") ||
    (path !== "/public/resource-share" && !path.startsWith("/public/resource-share/"))
  ) {
    throw new Error("Public resource-share proxy received an invalid path");
  }
  const id = requestId(request.headers.get("x-request-id"));
  let response: NextResponse;
  if (request.method !== "GET") {
    response = proxyError(id, 405, "E_INVALID_REQUEST", "Method not allowed");
    response.headers.set("Allow", "GET");
  } else {
    const headers = pickHeaders(
      request.headers,
      path === "/public/resource-share/file"
        ? ["x-nexus-share-token", "range"] : ["x-nexus-share-token"],
    );
    headers.set("accept-encoding", "identity");
    response = await forward({
      request, path, id, headers,
      responseHeaderNames: [
        "content-type", "content-length", "content-disposition", "accept-ranges", "content-range",
        "cache-control", "referrer-policy", "x-robots-tag", "x-content-type-options",
        "cross-origin-resource-policy", "content-security-policy",
      ],
    });
  }
  for (const [name, value] of Object.entries(SHARE_SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export async function proxyExtensionToFastAPI(
  request: Request,
  path: string,
  options: {
    defaultAccept?: string;
    defaultContentType?: string;
    forwardHeaders?: readonly string[];
  } = {},
): Promise<Response> {
  const id = requestId(request.headers.get("x-request-id"));
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return proxyError(id, 401, "E_UNAUTHENTICATED", "Extension token required");
  }
  const headers = pickHeaders(request.headers, [
    "idempotency-key", ...(options.forwardHeaders ?? []),
  ]);
  headers.set("authorization", authorization);
  headers.set("accept-encoding", "identity");
  const contentType = request.headers.get("content-type") ?? options.defaultContentType;
  const accept = request.headers.get("accept") ?? options.defaultAccept;
  if (contentType) headers.set("content-type", contentType);
  if (accept) headers.set("accept", accept);
  // Extension uploads finish arriving before the upstream deadline starts.
  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined : await request.arrayBuffer();
  return forward({
    request, path, id, headers, body, responseHeaderNames: ["content-type"],
  });
}
