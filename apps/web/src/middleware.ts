import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Middleware for:
 * - Four-state session classification and auth redirects (network-free)
 * - Nonce-based Content-Security-Policy headers
 */
export function middleware(request: NextRequest) {
  // A fresh per-request nonce. updateSession sets it on the request `x-nonce`
  // header; it is also placed in the CSP below so Next.js applies it to
  // framework and page scripts automatically.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const response = updateSession(request, nonce);

  // E2E runner can disable CSP to allow stable Playwright auth/session bootstrapping.
  if (process.env.E2E_DISABLE_CSP === "1") {
    return response;
  }

  // Next.js dev mode requires 'unsafe-eval' for hot module reloading (HMR).
  const isDev = process.env.NODE_ENV === "development";
  const cspHeader = [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${
      isDev ? " 'unsafe-eval'" : ""
    }`,
    `style-src 'self' 'unsafe-inline'`,
    `font-src 'self'`,
    `frame-src https://www.youtube.com https://www.youtube-nocookie.com`,
    `worker-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-ancestors 'none'`,
    `form-action 'self'`,
    `upgrade-insecure-requests`,
  ].join("; ");

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
