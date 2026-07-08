/**
 * Static HTTP security headers for the Next.js frontend.
 *
 * Applied to every response (`/:path*`, incl. `_next/static`) by `next.config.ts`'s
 * `headers()`. These carry no per-request data — the dynamic CSP and Reporting-Endpoints
 * live in `middleware.ts` via `./csp.ts`. Dependency-free so `next.config.ts` can import
 * it directly. See docs/cutovers/csp-and-security-headers-hardening.md.
 *
 * `X-Frame-Options` is intentionally absent: clickjacking is owned solely by the CSP
 * `frame-ancestors 'none'` directive, which cannot be disabled in production.
 */

import { YOUTUBE_EMBED_ORIGINS } from "./youtube";

export interface SecurityHeader {
  key: string;
  value: string;
}

// Permissions-Policy quotes each allowed origin: `"https://www.youtube.com" …`.
const YOUTUBE_ORIGINS = YOUTUBE_EMBED_ORIGINS.map((o) => `"${o}"`).join(" ");

/**
 * Deny-by-default powerful features. The media features the YouTube embed delegates via
 * its iframe `allow=""` are granted to `self` + the YouTube origins; `web-share` is
 * delegated to YouTube only (the app does not use it). Everything sensitive the app never
 * uses is disabled with an empty allowlist.
 */
const PERMISSIONS_POLICY = [
  `accelerometer=(self ${YOUTUBE_ORIGINS})`,
  `autoplay=(self ${YOUTUBE_ORIGINS})`,
  `clipboard-write=(self ${YOUTUBE_ORIGINS})`,
  `encrypted-media=(self ${YOUTUBE_ORIGINS})`,
  `fullscreen=(self ${YOUTUBE_ORIGINS})`,
  `gyroscope=(self ${YOUTUBE_ORIGINS})`,
  `picture-in-picture=(self ${YOUTUBE_ORIGINS})`,
  `web-share=(${YOUTUBE_ORIGINS})`,
  "camera=()",
  "microphone=(self)",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "bluetooth=()",
  "hid=()",
  "midi=()",
  "magnetometer=()",
].join(", ");

export const STATIC_SECURITY_HEADERS: readonly SecurityHeader[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
];
