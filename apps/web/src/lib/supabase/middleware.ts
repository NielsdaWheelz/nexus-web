import { type NextRequest, NextResponse } from "next/server";
import {
  buildAuthSessionRecoveryUrl,
  buildLoginUrl,
  parseAuthReturnTarget,
} from "@/lib/auth/redirects";
import { noStore } from "@/lib/auth/no-store";
import { readSupabaseSessionCookie } from "@/lib/auth/session-cookie";
import { REQUEST_PATH_HEADER } from "@/lib/auth/requestPath";
import {
  DEVICE_COOKIE_NAME,
  mintDeviceId,
  readDeviceId,
} from "@/lib/auth/deviceCookie";

const NONCE_HEADER = "x-nonce";
const CSP_REQUEST_HEADER = "content-security-policy";
const TEMPORARY_REDIRECT = 307;

/**
 * Routes that don't require authentication
 */
const PUBLIC_ROUTES = new Set([
  "/login",
  "/forgot-password",
  "/android",
  "/.well-known/assetlinks.json",
  "/privacy",
  "/terms",
  "/version",
  "/auth/callback",
  "/auth/confirm/invite",
  "/auth/confirm/recovery",
  "/auth/handoff",
  "/auth/invite",
  "/auth/native/google",
  "/auth/oauth",
  "/auth/password/recovery",
  "/auth/password/sign-in",
  "/auth/password/update",
  "/auth/recovery",
  "/auth/session/recover",
  "/auth/session/resolve",
  "/auth/signout",
  "/extension/connect/start",
  "/share",
  "/s",
]);

export function updateSession(
  request: NextRequest,
  nonce: string,
  contentSecurityPolicy?: string | null,
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
  const privatePassThrough = () => noStore(passThrough());

  const passThroughWithDeviceCookie = () => {
    if (readDeviceId(request.cookies)) {
      return privatePassThrough();
    }
    const { value, options } = mintDeviceId();
    const cookie = requestHeaders.get("cookie");
    requestHeaders.set(
      "cookie",
      cookie
        ? `${cookie}; ${DEVICE_COOKIE_NAME}=${value}`
        : `${DEVICE_COOKIE_NAME}=${value}`,
    );
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    response.cookies.set(DEVICE_COOKIE_NAME, value, options);
    return noStore(response);
  };

  if (pathname === "/login") {
    return passThrough();
  }

  if (
    PUBLIC_ROUTES.has(pathname) ||
    pathname.startsWith("/pdfjs/") ||
    pathname.startsWith("/_next") ||
    pathname === "/api" ||
    pathname.startsWith("/api/")
  ) {
    return passThrough();
  }

  if (request.method !== "GET") {
    return privatePassThrough();
  }

  // Protected page request.
  requestHeaders.set(
    REQUEST_PATH_HEADER,
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );

  const session = readSupabaseSessionCookie(request.cookies.getAll());
  switch (session.state) {
    case "active":
      return passThroughWithDeviceCookie();
    case "refreshable":
      return privatePassThrough();
    case "ended":
      return noStore(
        NextResponse.redirect(
          buildAuthSessionRecoveryUrl(
            request.nextUrl.origin,
            parseAuthReturnTarget(
              `${request.nextUrl.pathname}${request.nextUrl.search}`,
            ),
          ),
          { status: TEMPORARY_REDIRECT },
        ),
      );
    case "anonymous":
      switch (session.reason) {
        case "missing":
          return noStore(
            NextResponse.redirect(
              buildLoginUrl(
                request.nextUrl.origin,
                parseAuthReturnTarget(
                  `${request.nextUrl.pathname}${request.nextUrl.search}`,
                ),
              ),
              { status: TEMPORARY_REDIRECT },
            ),
          );
        case "malformed":
        case "non_bearer":
          return noStore(
            NextResponse.redirect(
              buildAuthSessionRecoveryUrl(
                request.nextUrl.origin,
                parseAuthReturnTarget(
                  `${request.nextUrl.pathname}${request.nextUrl.search}`,
                ),
              ),
              { status: TEMPORARY_REDIRECT },
            ),
          );
        case "bad_config":
          throw new Error("Supabase auth cookie configuration is invalid.");
      }
  }

  const exhaustive: never = session;
  return exhaustive;
}
