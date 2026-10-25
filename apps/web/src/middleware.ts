// response policy and routing metadata. hosted entry owns silent renewal;
// native documents verify only; fixed native routes own credential effects.
import { NextResponse, type NextRequest } from "next/server";
import { assertNever } from "@/lib/assertNever";
import { isAndroidShellUserAgent } from "@/lib/androidShell";
import { resolveDevice } from "@/lib/auth/deviceCookie";
import {
  applyRequestEffect,
  ended,
  finish,
  redirectTo,
  resolveEntry,
  presentedSession,
  type Effect,
} from "@/lib/auth/session";
import {
  loginPath,
  parseReturnTarget,
  REQUEST_METHOD_HEADER,
  REQUEST_PATH_HEADER,
  unavailablePath,
} from "@/lib/auth/urls";
import { getEnv } from "@/lib/env";
import { nativeError } from "@/lib/native/server";
import { appCsp, cspNonce, publicReaderCsp } from "@/lib/security/csp";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
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
const PUBLIC_PREFIXES = ["/auth/", "/pdfjs/", "/_next"];

export async function middleware(request: NextRequest) {
  const { pathname, search, host, protocol } = request.nextUrl;
  // Normal browser startup uses the exact same asset shell as the APK. An
  // expired remote session cannot evict its confirmed local account.
  if ((request.method === "GET" || request.method === "HEAD") &&
      (pathname === "/" || pathname === "/daily" || pathname === "/share" || resolvePaneRouteModel(`${pathname}${search}`).id !== "unsupported")) {
    return NextResponse.rewrite(new URL("/workspace-shell", request.url));
  }
  if (pathname === "/workspace-shell" || pathname === "/workspace-sw.js" || pathname.startsWith("/_nexus/")) {
    const response = NextResponse.next();
    if (pathname === "/_nexus/authored/worker.js") response.headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'");
    return response;
  }
  const native = isAndroidShellUserAgent(request.headers.get("user-agent") ?? "");
  const isAuthSurface =
    pathname === "/login" ||
    pathname === "/forgot-password" ||
    pathname === "/account/password" ||
    pathname === "/account/identities" ||
    pathname === "/extension/connect/start" ||
    pathname === "/auth" ||
    pathname.startsWith("/auth/");
  const fixedNativeAuth = request.method === "POST" && (pathname === "/auth/native/google" || pathname === "/auth/signout");
  const rejectNativeAuth = native && isAuthSurface && !fixedNativeAuth;
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
  const csp =
    pathname === "/s"
      ? publicReaderCsp(policyRequest)
      : appCsp({ ...policyRequest, connect: getEnv().connectOrigins });

  const isNavigation = request.method === "GET" || request.method === "HEAD";
  const isLogin = pathname === "/login";
  const requestPath = parseReturnTarget(`${pathname}${search}`);
  const target = isLogin
    ? parseReturnTarget(request.nextUrl.searchParams.get("next"))
    : requestPath;
  let effect: Effect = { kind: "Preserve" };
  let destination: string | null = null;
  if (!rejectNativeAuth && isNavigation && (isProtected || isLogin)) {
    try {
      const live = await (native ? presentedSession(request.cookies.getAll()) : resolveEntry(request.cookies.getAll()));
      switch (live.kind) {
        case "Live":
          if (!native) effect = { kind: "Write", writes: live.writes };
          if (isLogin && request.nextUrl.searchParams.get("flow") !== "handoff" && request.nextUrl.searchParams.get("switch_account") !== "1") destination = target;
          break;
        case "Ended":
          if (!native) effect = ended(live.cookieNames);
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
  if (rejectNativeAuth) {
    response = nativeError(403, "E_FORBIDDEN", "open authentication in your browser");
  } else if (destination !== null) {
    response = redirectTo(destination, 303);
  } else {
    applyRequestEffect(request.cookies, effect);
    const device = !native && isProtected && isNavigation ? resolveDevice(request.cookies) : null;
    if (device) for (const write of device.writes) request.cookies.set(write.name, write.value);
    // next reads this policy to stamp its scripts with the request nonce.
    // copy headers after applying effects so server rendering sees the successor.
    const forwarded = new Headers(request.headers);
    forwarded.set("content-security-policy", csp);
    if (isProtected) {
      forwarded.set(REQUEST_PATH_HEADER, requestPath);
      forwarded.set(REQUEST_METHOD_HEADER, request.method);
    }
    response = NextResponse.next({ request: { headers: forwarded } });
    if (device) for (const write of device.writes) response.cookies.set(write.name, write.value, write.options);
  }

  if (isProtected || isAuthSurface) finish(response, effect);

  const headers = response.headers;
  headers.set("Content-Security-Policy", csp);
  if (isAuthSurface) headers.set("X-Robots-Tag", "noindex, nofollow");
  // a token_hash in the url must never leave through Referer.
  if (pathname === "/auth/invite" || pathname === "/auth/recovery") {
    headers.set("Referrer-Policy", "no-referrer");
  }
  if (pathname === "/s") {
    headers.set("Cache-Control", "private, no-store");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return response;
}

export const config = {
  runtime: "nodejs",
  // everything except /api/*, static build output, the favicon and public
  // images. /api route handlers own their requests whole: next clones the body
  // of every non-GET request a node middleware matches and finalizes the clone
  // unawaited, so a client leaving mid-body or mid-answer escaped as an
  // unhandled rejection or uncaught exception.
  matcher: [
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
