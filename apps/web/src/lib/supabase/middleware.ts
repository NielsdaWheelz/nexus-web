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

type AuthGateStatus = "authenticated" | "unauthenticated" | "unknown";

const AUTH_GATE_TIMEOUT_MS = 1500;

/**
 * Routes that don't require authentication
 */
const PUBLIC_ROUTES = new Set([
  "/login",
  "/auth/callback",
  "/auth/signout",
]);

/**
 * Check if a path is a public route (no auth required)
 */
function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.has(pathname) || pathname.startsWith("/_next");
}

function isApiRoute(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

function authErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function supabaseAuthCookiePrefix(): string | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    return null;
  }

  try {
    const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
    return projectRef ? `sb-${projectRef}-auth-token` : null;
  } catch {
    return null;
  }
}

function hasSupabaseAuthCookie(request: NextRequest): boolean {
  const cookiePrefix = supabaseAuthCookiePrefix();
  if (!cookiePrefix) {
    return false;
  }

  return request.cookies
    .getAll()
    .some(
      ({ name, value }) =>
        Boolean(value) &&
        (name === cookiePrefix || name.startsWith(`${cookiePrefix}.`))
    );
}

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
  if (isPublicRoute(pathname)) {
    return NextResponse.next({ request });
  }

  // API route handlers own their auth response shape. Let unauthenticated API
  // requests reach the BFF so callers receive JSON errors instead of login HTML.
  if (isApiRoute(pathname)) {
    return NextResponse.next({ request });
  }

  const hasLocalAuthSession = hasSupabaseAuthCookie(request);

  let supabaseResponse = NextResponse.next({
    request,
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
            request,
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
    }
  );

  // IMPORTANT: Avoid writing any logic between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  const authCheck = supabase.auth
    .getUser()
    .then(({ data: { user }, error }): AuthGateStatus => {
      if (user) {
        return "authenticated";
      }

      // Treat transient Supabase Auth failures as unknown instead of turning a
      // protected page navigation into a Vercel middleware timeout.
      const status = authErrorStatus(error);
      if (status !== null && status >= 500) {
        return "unknown";
      }

      return "unauthenticated";
    })
    .catch((): AuthGateStatus => "unknown");

  const authStatus = await Promise.race<AuthGateStatus>([
    authCheck,
    new Promise<AuthGateStatus>((resolve) => {
      setTimeout(() => resolve("unknown"), AUTH_GATE_TIMEOUT_MS);
    }),
  ]);

  if (authStatus === "unknown" && hasLocalAuthSession) {
    return supabaseResponse;
  }

  // Redirect to login if not authenticated
  if (authStatus !== "authenticated") {
    return NextResponse.redirect(buildLoginRedirectUrl(request.nextUrl));
  }

  return supabaseResponse;
}
