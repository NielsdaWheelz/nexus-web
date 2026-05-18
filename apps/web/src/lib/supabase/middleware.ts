import { type NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_AUTH_REDIRECT,
  buildLoginRedirectUrl,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";
import { readSupabaseSessionCookie } from "@/lib/auth/session-cookie";

const REQUEST_PATH_HEADER = "x-nexus-request-path";
const NONCE_HEADER = "x-nonce";
const PREFETCH_HEADER = "Next-Router-Prefetch";
const TEMPORARY_REDIRECT = 307;

// Kill-switch for the `refreshable` → /auth/refresh redirect. When disabled,
// middleware falls back to the pre-cutover behavior — clear the cookie and
// redirect to /login — so a broken refresh path can be neutralized without a
// redeploy. Default enabled; only the explicit string "0" turns it off.
const REFRESH_REDIRECT_ENABLED =
  process.env.AUTH_REFRESH_REDIRECT_ENABLED !== "0";

/**
 * Routes that don't require authentication
 */
const PUBLIC_ROUTES = new Set([
  "/login",
  "/android",
  "/.well-known/assetlinks.json",
  "/privacy",
  "/terms",
  "/auth/callback",
  "/auth/refresh",
  "/auth/signout",
  "/extension/connect/start",
]);

// Clear the auth cookie chunks and redirect to /login — the involuntary-logout
// path for `ended`/`anonymous` and for `refreshable` when the kill-switch is off.
function clearAndRedirectToLogin(
  request: NextRequest,
  cookieNames: string[]
): NextResponse {
  const response = NextResponse.redirect(buildLoginRedirectUrl(request.nextUrl));
  for (const name of cookieNames) {
    response.cookies.set(name, "", { maxAge: 0, path: "/" });
  }
  return response;
}

export function updateSession(
  request: NextRequest,
  nonce: string
): NextResponse {
  const pathname = request.nextUrl.pathname;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  const passThrough = () =>
    NextResponse.next({ request: { headers: requestHeaders } });

  if (pathname === "/login") {
    const session = readSupabaseSessionCookie(request.cookies.getAll());
    if (session.state === "active" || session.state === "refreshable") {
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
    return passThrough();
  }

  if (
    PUBLIC_ROUTES.has(pathname) ||
    pathname.startsWith("/_next") ||
    pathname === "/api" ||
    pathname.startsWith("/api/")
  ) {
    return passThrough();
  }

  // Protected page request.
  requestHeaders.set(
    REQUEST_PATH_HEADER,
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  );

  const session = readSupabaseSessionCookie(request.cookies.getAll());
  switch (session.state) {
    case "active":
      return passThrough();
    case "refreshable": {
      // A prefetch must never drive a token refresh: let a hovered link's
      // prefetch pass and the page gate handles the real navigation.
      if (request.headers.has(PREFETCH_HEADER)) {
        return passThrough();
      }
      if (!REFRESH_REDIRECT_ENABLED) {
        return clearAndRedirectToLogin(request, session.cookieNames);
      }
      // Silent refresh. Do not clear the cookie — the refresh route needs the
      // refresh token it carries.
      const refreshUrl = new URL("/auth/refresh", request.nextUrl.origin);
      refreshUrl.searchParams.set(
        "next",
        `${request.nextUrl.pathname}${request.nextUrl.search}`
      );
      return NextResponse.redirect(refreshUrl, { status: TEMPORARY_REDIRECT });
    }
    case "ended":
    case "anonymous":
      // An involuntary logout — an `ended` transition that did not pass
      // through explicit signout, or a request with no recoverable cookie.
      console.warn("auth_involuntary_logout", {
        state: session.state,
        reason: session.reason,
        path: pathname,
      });
      return clearAndRedirectToLogin(request, session.cookieNames);
  }

  const exhaustive: never = session;
  return exhaustive;
}
