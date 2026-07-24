import { type NextRequest } from "next/server";
import {
  buildPublicApiContentSecurityPolicy,
  buildContentSecurityPolicy,
  buildPublicReaderContentSecurityPolicy,
  buildReportingEndpoints,
  generateNonce,
} from "@/lib/security/csp";
import { getEnv, isDevBuild } from "@/lib/env";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Middleware for:
 * - Four-state session classification and auth redirects (network-free)
 * - Nonce-based Content-Security-Policy headers (see lib/security/csp.ts)
 */
export function middleware(request: NextRequest) {
  // A fresh per-request nonce, stamped into the CSP. The policy is set on BOTH the
  // forwarded request headers — Next.js reads the nonce from the request-side CSP
  // (`parseRequestHeaders` in app-render) to stamp its framework/RSC scripts; `x-nonce`
  // alone is not read for that — and the response, for browser enforcement. The E2E runner
  // may disable CSP entirely (null policy); never honored in a deployed env.
  const nonce = generateNonce();
  const env = getEnv();
  const isPublicResourceShareApi =
    request.nextUrl.pathname === "/api/public/resource-share" ||
    request.nextUrl.pathname.startsWith("/api/public/resource-share/");
  const csp = env.disableCspForE2E
    ? null
    : isPublicResourceShareApi
      ? buildPublicApiContentSecurityPolicy()
      : request.nextUrl.pathname === "/s"
      ? buildPublicReaderCsp(request, nonce)
      : buildCsp(request, nonce, env.connectOrigins);

  const response = updateSession(request, nonce, csp);

  if (csp) {
    response.headers.set("Content-Security-Policy", csp);
    response.headers.set(
      "Reporting-Endpoints",
      buildReportingEndpoints(request.nextUrl.origin),
    );
  }
  if (request.nextUrl.pathname === "/s" || isPublicResourceShareApi) {
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
    if (!isPublicResourceShareApi) {
      response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    }
  }

  return response;
}

function buildPublicReaderCsp(request: NextRequest, nonce: string): string {
  const isDev = isDevBuild();
  return buildPublicReaderContentSecurityPolicy({
    nonce,
    isDev,
    isHttpsRequest:
      request.headers.get("x-forwarded-proto") === "https" ||
      request.nextUrl.protocol === "https:",
    devWebSocketOrigins: isDev ? devWebSocketOrigins(request) : undefined,
  });
}

function buildCsp(
  request: NextRequest,
  nonce: string,
  connectOrigins: readonly string[],
): string {
  const isDev = isDevBuild();
  const isHttpsRequest =
    request.headers.get("x-forwarded-proto") === "https" ||
    request.nextUrl.protocol === "https:";

  return buildContentSecurityPolicy({
    nonce,
    isDev,
    isHttpsRequest,
    connectOrigins,
    devWebSocketOrigins: isDev ? devWebSocketOrigins(request) : undefined,
  });
}

// Next dev HMR uses a same-host websocket; allow it in connect-src under `next dev` only.
function devWebSocketOrigins(request: NextRequest): string[] {
  const host = request.nextUrl.host;
  return [`ws://${host}`, `wss://${host}`];
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (public folder)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
