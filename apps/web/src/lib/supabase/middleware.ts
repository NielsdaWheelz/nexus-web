import { type NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_AUTH_REDIRECT,
  buildLoginRedirectUrl,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";
import { readSupabaseSessionCookie } from "@/lib/auth/session-cookie";

const REQUEST_PATH_HEADER = "x-nexus-request-path";

/**
 * Routes that don't require authentication
 */
const PUBLIC_ROUTES = new Set([
  "/login",
  "/android",
  "/privacy",
  "/terms",
  "/auth/callback",
  "/auth/signout",
  "/extension/connect/start",
]);

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (pathname === "/login") {
    const session = readSupabaseSessionCookie(request.cookies.getAll());
    if (session.ok) {
      return NextResponse.redirect(
        new URL(
          normalizeAuthRedirect(
            request.nextUrl.searchParams.get("next"),
            DEFAULT_AUTH_REDIRECT
          ),
          request.nextUrl.origin
        )
      );
    }
    return NextResponse.next({ request });
  }

  if (PUBLIC_ROUTES.has(pathname) || pathname.startsWith("/_next")) {
    return NextResponse.next({ request });
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return NextResponse.next({ request });
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(
    REQUEST_PATH_HEADER,
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  );

  const session = readSupabaseSessionCookie(request.cookies.getAll());
  if (!session.ok) {
    const response = NextResponse.redirect(buildLoginRedirectUrl(request.nextUrl));
    for (const name of session.cookieNames) {
      response.cookies.set(name, "", { maxAge: 0, path: "/" });
    }
    return response;
  }

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });
}
