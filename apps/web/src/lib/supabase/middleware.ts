/**
 * Supabase middleware for session refresh and auth redirects.
 *
 * This module handles:
 * - Session refresh on each request
 * - Redirect to /login for unauthenticated users on protected routes
 * - Allow access to public routes without authentication
 */

import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { buildLoginRedirectUrl } from "@/lib/auth/redirects";
import { type CookieToSet } from "./types";

const AUTH_FETCH_TIMEOUT_MS = 2_000;
const REQUEST_PATH_HEADER = "x-nexus-request-path";

/**
 * Routes that don't require authentication
 */
const PUBLIC_ROUTES = new Set([
  "/login",
  "/privacy",
  "/terms",
  "/auth/callback",
  "/auth/signout",
  "/extension/connect/start",
]);

/**
 * Update the Supabase session and handle auth redirects.
 *
 * This function should be called from Next.js middleware to:
 * 1. Refresh the session if needed
 * 2. Redirect unauthenticated users to login
 * 3. Allow authenticated users through
 */
export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Allow public routes without spending middleware time on Supabase Auth.
  if (PUBLIC_ROUTES.has(pathname) || pathname.startsWith("/_next")) {
    return NextResponse.next({ request });
  }

  // API route handlers own their auth response shape. Let unauthenticated API
  // requests reach the BFF so callers receive JSON errors instead of login HTML.
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return NextResponse.next({ request });
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(
    REQUEST_PATH_HEADER,
    `${request.nextUrl.pathname}${request.nextUrl.search}`
  );

  let hasAuthCookie = false;
  try {
    const projectRef = new URL(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""
    ).hostname.split(".")[0];
    const cookieName = `sb-${projectRef}-auth-token`;
    hasAuthCookie = request.cookies
      .getAll()
      .some(
        ({ name, value }) =>
          Boolean(value) &&
          (name === cookieName || name.startsWith(`${cookieName}.`))
      );
  } catch {
    // justify-ignore-error: malformed or missing Supabase URL means there is no
    // trusted auth-cookie prefix for this request, so the protected route must
    // fail closed.
    hasAuthCookie = false;
  }

  if (!hasAuthCookie) {
    return NextResponse.redirect(buildLoginRedirectUrl(request.nextUrl));
  }

  let supabaseResponse = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: CookieToSet[],
          headers?: Record<string, string>
        ) {
          cookiesToSet.forEach(({ name, value }: CookieToSet) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request: {
              headers: requestHeaders,
            },
          });
          cookiesToSet.forEach(({ name, value, options }: CookieToSet) =>
            supabaseResponse.cookies.set(name, value, options)
          );
          // Forward cache-busting headers so CDNs/proxies don't cache
          // responses that carry auth cookies.
          if (headers) {
            Object.entries(headers).forEach(([key, value]) =>
              supabaseResponse.headers.set(key, value)
            );
          }
        },
      },
      global: {
        fetch(input, init) {
          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(),
            AUTH_FETCH_TIMEOUT_MS
          );

          return fetch(input, { ...init, signal: controller.signal }).finally(
            () => clearTimeout(timeout)
          );
        },
      },
    }
  );

  // IMPORTANT: Avoid writing any logic between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  let authenticated = false;
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    authenticated = Boolean(user);
  } catch (error) {
    console.error("Supabase middleware auth check failed:", error);
  }

  // Redirect to login if not authenticated
  if (!authenticated) {
    return NextResponse.redirect(buildLoginRedirectUrl(request.nextUrl));
  }

  return supabaseResponse;
}
