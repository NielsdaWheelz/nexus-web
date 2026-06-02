import { type NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_AUTH_REDIRECT,
  buildLoginRedirectUrl,
  buildLoginUrlWithError,
  normalizeAuthRedirect,
} from "@/lib/auth/redirects";
import {
  AUTH_ENDED_FEEDBACK_COOKIE,
  SESSION_ENDED_MESSAGE,
} from "@/lib/auth/messages";
import {
  clearSupabaseAuthCookies,
  readSupabaseSessionCookie,
} from "@/lib/auth/session-cookie";

const REQUEST_PATH_HEADER = "x-nexus-request-path";
const NONCE_HEADER = "x-nonce";
const CSP_REQUEST_HEADER = "content-security-policy";
const PREFETCH_HEADER = "Next-Router-Prefetch";
const TEMPORARY_REDIRECT = 307;

/**
 * Routes that don't require authentication
 */
const PUBLIC_ROUTES = new Set([
  "/login",
  "/android",
  "/.well-known/assetlinks.json",
  "/privacy",
  "/sign-up",
  "/terms",
  "/auth/callback",
  "/auth/handoff",
  "/auth/native/google",
  "/auth/oauth",
  "/auth/password",
  "/auth/refresh",
  "/auth/signout",
  "/extension/connect/start",
  "/share",
]);

// Clear the auth cookie chunks and redirect to /login — the involuntary-logout
// path for `ended` and `anonymous`.
function clearAndRedirectToLogin(
  request: NextRequest,
  cookieNames: string[],
  options?: { sessionEndedFeedback?: boolean }
): NextResponse {
  const response = NextResponse.redirect(
    options?.sessionEndedFeedback
      ? buildLoginUrlWithError(
          request.nextUrl.origin,
          `${request.nextUrl.pathname}${request.nextUrl.search}`,
          SESSION_ENDED_MESSAGE
        )
      : buildLoginRedirectUrl(request.nextUrl)
  );
  clearSupabaseAuthCookies(response, cookieNames);
  if (options?.sessionEndedFeedback) {
    response.cookies.set(AUTH_ENDED_FEEDBACK_COOKIE, "1", {
      httpOnly: true,
      maxAge: 60,
      path: "/",
      sameSite: "lax",
    });
  }
  return response;
}

export function updateSession(
  request: NextRequest,
  nonce: string,
  contentSecurityPolicy?: string | null
): NextResponse {
  const pathname = request.nextUrl.pathname;

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(NONCE_HEADER, nonce);
  // Next.js extracts the script nonce from the *request* Content-Security-Policy header
  // (app-render `parseRequestHeaders`), NOT from `x-nonce`. Forwarding the policy on the
  // request is what makes Next stamp the nonce onto its framework/RSC scripts; without it,
  // `strict-dynamic` (which ignores `'self'`) blocks every Next script. The same policy is
  // set on the response for browser enforcement by the caller (middleware.ts).
  if (contentSecurityPolicy) {
    requestHeaders.set(CSP_REQUEST_HEADER, contentSecurityPolicy);
  }
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
  const hasSessionEndedFeedback =
    request.cookies.get(AUTH_ENDED_FEEDBACK_COOKIE)?.value === "1";

  const session = readSupabaseSessionCookie(request.cookies.getAll());
  switch (session.state) {
    case "active":
      return passThrough();
    case "refreshable": {
      if (hasSessionEndedFeedback) {
        return clearAndRedirectToLogin(request, session.cookieNames, {
          sessionEndedFeedback: true,
        });
      }
      // A prefetch must never drive a token refresh: let a hovered link's
      // prefetch pass and the page gate handles the real navigation.
      if (request.headers.has(PREFETCH_HEADER)) {
        return passThrough();
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
      return clearAndRedirectToLogin(request, session.cookieNames, {
        sessionEndedFeedback:
          hasSessionEndedFeedback ||
          session.state === "ended" ||
          (session.state === "anonymous" && session.cookieNames.length > 0),
      });
  }

  const exhaustive: never = session;
  return exhaustive;
}
