// per request: the content policy and its nonce, the network-free session gate
// for protected page GETs, the device cookie, and the headers a path class
// needs beyond the static suite (lib/security/headers.ts via next.config). it
// imports the edge-safe cookie classifier only: never lib/supabase/auth or
// lib/auth/session, which would pull the sdk into the edge bundle.
import { NextResponse, type NextRequest } from "next/server";
import { DEVICE_COOKIE_NAME, readDeviceId } from "@/lib/auth/deviceCookie";
import {
  loginPath,
  parseReturnTarget,
  recoverPath,
  REQUEST_PATH_HEADER,
} from "@/lib/auth/urls";
import { isDevBuild } from "@/lib/build-mode";
import { createRandomId } from "@/lib/createRandomId";
import { getEnv } from "@/lib/env";
import {
  appCsp,
  cspNonce,
  PUBLIC_API_CSP,
  publicReaderCsp,
} from "@/lib/security/csp";
import { readSession } from "@/lib/supabase/cookie";

// no session gate: public pages, every auth surface, and every route handler
// under /api (the bff resolves its own session).
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
]);
const PUBLIC_PREFIXES = ["/api/", "/auth/", "/pdfjs/", "/_next"];

const DEVICE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10;

export function middleware(request: NextRequest) {
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

  const dev = isDevBuild();
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
          media: getEnv().mediaOrigins,
        });

  // next reads the script nonce from the request-side policy and stamps it on
  // its own scripts; without it 'strict-dynamic' blocks every next script.
  const forwarded = new Headers(request.headers);
  forwarded.set("content-security-policy", csp);
  let response: NextResponse | null = null;
  if (isProtected) {
    // server components cannot see the url: the session gate and the
    // workspace bootstrap read it here.
    forwarded.set(REQUEST_PATH_HEADER, `${pathname}${search}`);
    // non-GETs (server actions) pass: their response owners resolve the
    // session.
    const session =
      request.method === "GET" ? readSession(request.cookies.getAll()) : null;
    const target = parseReturnTarget(`${pathname}${search}`);
    if (session?.state === "anonymous") {
      response = NextResponse.redirect(new URL(loginPath(target), request.url));
    } else if (session?.state === "ended") {
      response = NextResponse.redirect(
        new URL(recoverPath(target), request.url),
      );
    } else if (session?.state === "active" && !readDeviceId(request.cookies)) {
      // minted on the request too, so this request's server code sees it.
      const device = createRandomId();
      const cookie = request.headers.get("cookie");
      forwarded.set(
        "cookie",
        cookie
          ? `${cookie}; ${DEVICE_COOKIE_NAME}=${device}`
          : `${DEVICE_COOKIE_NAME}=${device}`,
      );
      response = NextResponse.next({ request: { headers: forwarded } });
      response.cookies.set(DEVICE_COOKIE_NAME, device, {
        httpOnly: true,
        sameSite: "lax",
        secure: getEnv().appPublicOrigin.startsWith("https:"),
        path: "/",
        maxAge: DEVICE_MAX_AGE_SECONDS,
      });
    }
  }
  response ??= NextResponse.next({ request: { headers: forwarded } });

  const headers = response.headers;
  headers.set("Content-Security-Policy", csp);
  if (isProtected || isAuthSurface) {
    headers.set("Cache-Control", "private, no-store");
    headers.set("Vary", "Cookie");
  }
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
  // everything except static build output, the favicon and public images.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
