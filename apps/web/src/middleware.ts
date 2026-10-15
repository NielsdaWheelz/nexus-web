// per request: content policy, routing metadata and silent navigation renewal.
// node middleware owns entry cookie effects; bff/routes/actions own theirs.
import { NextResponse, type NextRequest } from "next/server";
import { assertNever } from "@/lib/assertNever";
import { DEVICE_COOKIE_NAME, readDeviceId } from "@/lib/auth/deviceCookie";
import {
  applyRequestEffect,
  ended,
  finish,
  redirectTo,
  resolveEntry,
  type Effect,
} from "@/lib/auth/session";
import {
  loginPath,
  parseReturnTarget,
  REQUEST_METHOD_HEADER,
  REQUEST_PATH_HEADER,
  unavailablePath,
} from "@/lib/auth/urls";
import { createRandomId } from "@/lib/createRandomId";
import { getEnv } from "@/lib/env";
import {
  appCsp,
  cspNonce,
  PUBLIC_API_CSP,
  publicReaderCsp,
} from "@/lib/security/csp";
import { AuthUnavailable } from "@/lib/supabase/auth";

// public paths bypass the protected gate. login handles its own continuation
// below; auth routes and the bff resolve their own sessions.
const PUBLIC_PATHS = new Set([
  "/robots.txt",
  "/manifest.webmanifest",
  "/opengraph-image",
  "/apple-icon",
  "/login",
  "/forgot-password",
  "/android",
  "/.well-known/assetlinks.json",
  "/privacy",
  "/terms",
  "/version",
  "/extension/connect/start",
  "/share",
  "/s",
  "/api",
  "/auth",
]);
const PUBLIC_PREFIXES = ["/api/", "/auth/", "/pdfjs/", "/_next"];

const DEVICE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10;

export async function middleware(request: NextRequest) {
  const { pathname, search, host, protocol } = request.nextUrl;
  const isShareApi =
    pathname === "/api/public/resource-share" ||
    pathname.startsWith("/api/public/resource-share/");
  const isAuthSurface =
    pathname === "/login" ||
    pathname === "/forgot-password" ||
    pathname === "/account/password" ||
    pathname === "/auth" ||
    pathname.startsWith("/auth/");
  const isProtected =
    !PUBLIC_PATHS.has(pathname) &&
    !PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  const dev = process.env.NODE_ENV === "development";
  const policyRequest = {
    nonce: cspNonce(),
    dev,
    https:
      request.headers.get("x-forwarded-proto") === "https" ||
      protocol === "https:",
    // next dev's hmr socket
    ws: dev ? [`ws://${host}`, `wss://${host}`] : [],
  };
  const csp = isShareApi
    ? PUBLIC_API_CSP
    : pathname === "/s"
      ? publicReaderCsp(policyRequest)
      : appCsp({
          ...policyRequest,
          connect: getEnv().connectOrigins,
        });

  const isNavigation = request.method === "GET" || request.method === "HEAD";
  const isLogin = pathname === "/login";
  const requestPath = parseReturnTarget(`${pathname}${search}`);
  const target = isLogin
    ? parseReturnTarget(request.nextUrl.searchParams.get("next"))
    : requestPath;
  let effect: Effect = { kind: "Preserve" };
  let destination: string | null = null;
  if (isNavigation && (isProtected || isLogin)) {
    try {
      const live = await resolveEntry(request.cookies.getAll());
      switch (live.kind) {
        case "Live":
          effect = { kind: "Write", writes: live.writes };
          if (isLogin) destination = target;
          break;
        case "Ended":
          effect = ended(live.cookieNames);
          if (isProtected) destination = loginPath(target);
          break;
        case "Anonymous":
          if (isProtected) destination = loginPath(target);
          break;
        default:
          assertNever(live);
      }
    } catch (error) {
      if (!(error instanceof AuthUnavailable)) throw error;
      destination = unavailablePath(target);
    }
  }

  let response: NextResponse;
  if (destination !== null) {
    response = redirectTo(destination, 303);
  } else {
    applyRequestEffect(request.cookies, effect);
    let device: string | null = null;
    if (isProtected && isNavigation && !readDeviceId(request.cookies)) {
      device = createRandomId();
      request.cookies.set(DEVICE_COOKIE_NAME, device);
    }
    // next reads this policy to stamp its scripts with the request nonce.
    // copy headers after applying effects so server rendering sees the successor.
    const forwarded = new Headers(request.headers);
    forwarded.set("content-security-policy", csp);
    if (isProtected) {
      forwarded.set(REQUEST_PATH_HEADER, requestPath);
      forwarded.set(REQUEST_METHOD_HEADER, request.method);
    }
    response = NextResponse.next({ request: { headers: forwarded } });
    if (device !== null) {
      response.cookies.set(DEVICE_COOKIE_NAME, device, {
        httpOnly: true,
        sameSite: "lax",
        secure: getEnv().appPublicOrigin.startsWith("https:"),
        path: "/",
        maxAge: DEVICE_MAX_AGE_SECONDS,
      });
    }
  }

  if (isProtected || isAuthSurface) finish(response, effect);

  const headers = response.headers;
  headers.set("Content-Security-Policy", csp);
  if (isAuthSurface) headers.set("X-Robots-Tag", "noindex, nofollow");
  // a token_hash in the url must never leave through Referer.
  if (pathname === "/auth/invite" || pathname === "/auth/recovery") {
    headers.set("Referrer-Policy", "no-referrer");
  }
  if (pathname === "/s" || isShareApi) {
    headers.set("Cache-Control", "private, no-store");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return response;
}

export const config = {
  runtime: "nodejs",
  // everything except static build output, the favicon and public images.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
