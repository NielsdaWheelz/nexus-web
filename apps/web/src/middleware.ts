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

  // Generate CSP nonce for inline scripts
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  // Build CSP header
  const cspHeader = [
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'unsafe-inline'`,
    `worker-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `upgrade-insecure-requests`,
  ].join("; ");

  // Set CSP header
  response.headers.set("Content-Security-Policy", cspHeader);

  // Pass nonce to the request for server components
  response.headers.set("x-nonce", nonce);

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
