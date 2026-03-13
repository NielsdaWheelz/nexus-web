import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Middleware for:
 * - Session refresh (Supabase auth)
 * - Auth redirects (unauthenticated → /login)
 * - CSP headers with nonces
 */
export async function middleware(request: NextRequest) {
  // Handle session and auth redirects
  const response = await updateSession(request);

  // E2E runner can disable CSP to allow stable Playwright auth/session bootstrapping.
  if (process.env.E2E_DISABLE_CSP === "1") {
    return response;
  }

  // Build CSP header
  // Using 'unsafe-inline' for scripts because Next.js injects inline scripts
  // for hydration/RSC that don't carry the middleware nonce on Vercel.
  // TODO: re-introduce nonce-based CSP once Next.js nonce propagation is wired up.
  const isDev = process.env.NODE_ENV === "development";
  const cspHeader = [
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com`,
    `frame-src https://www.youtube.com https://www.youtube-nocookie.com`,
    `worker-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `upgrade-insecure-requests`,
  ].join("; ");

  // Set CSP header
  response.headers.set("Content-Security-Policy", cspHeader);

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public files (public folder)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
