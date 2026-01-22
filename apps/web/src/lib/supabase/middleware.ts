/**
 * Supabase middleware for session refresh and auth redirects.
 *
 * This module handles:
 * - Session refresh on each request
 * - Redirect to /login for unauthenticated users on protected routes
 * - Allow access to public routes without authentication
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

interface CookieToSet {
  name: string;
  value: string;
  options?: CookieOptions;
}

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

/**
 * Update the Supabase session and handle auth redirects.
 *
 * This function should be called from Next.js middleware to:
 * 1. Refresh the session if needed
 * 2. Redirect unauthenticated users to login
 * 3. Allow authenticated users through
 */
export async function updateSession(request: NextRequest) {
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
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }: CookieToSet) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }: CookieToSet) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: Avoid writing any logic between createServerClient and
  // supabase.auth.getUser(). A simple mistake could make it very hard to debug
  // issues with users being randomly logged out.

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Allow public routes without auth
  const pathname = request.nextUrl.pathname;
  if (isPublicRoute(pathname)) {
    return supabaseResponse;
  }

  // Redirect to login if not authenticated
  if (!user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
