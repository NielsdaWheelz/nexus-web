import { type NextRequest } from "next/server";
import {
  buildContentSecurityPolicy,
  buildReportingEndpoints,
  generateNonce,
  getConnectOriginsFromEnv,
  shouldDisableCspForE2E,
} from "@/lib/security/csp";
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
  // may disable CSP entirely (null policy); never honored in production.
  const nonce = generateNonce();
  const csp = shouldDisableCspForE2E() ? null : buildCsp(request, nonce);

  const response = updateSession(request, nonce, csp);

  if (csp) {
    response.headers.set("Content-Security-Policy", csp);
    response.headers.set(
      "Reporting-Endpoints",
      buildReportingEndpoints(request.nextUrl.origin),
    );
  }

  return response;
}

// A missing/invalid CSP connect-origins env must never take down the whole site. If
// getConnectOriginsFromEnv throws (it is strict in production), log loudly and serve the
// request WITHOUT the dynamic CSP — the static header suite from next.config still applies —
// instead of throwing MIDDLEWARE_INVOCATION_FAILED on every route. The fix is then to set
// the env (CSP returns automatically); availability is never traded for a header.
function buildCsp(request: NextRequest, nonce: string): string | null {
  let connectOrigins: readonly string[];
  try {
    connectOrigins = getConnectOriginsFromEnv();
  } catch (error) {
    console.error("csp_connect_origins_misconfigured", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  const isDev = process.env.NODE_ENV === "development";
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
