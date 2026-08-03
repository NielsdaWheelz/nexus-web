import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security/headers";
import { getEnv } from "./src/lib/env";

// Fail the deploy, not the request: a staging/prod build with missing/invalid env aborts
// `next build`, so Vercel never promotes the bad artifact and the last-good deployment keeps
// serving. Local/test builds keep local defaults.
const env = getEnv();

const nextConfig: NextConfig = {
  output: "standalone",
  // Client-safe build constant derived from the already validated canonical
  // public origin. Share links must never inherit a preview or Host origin.
  env: {
    NEXT_PUBLIC_APP_PUBLIC_ORIGIN: env.appPublicOrigin,
  },
  // The typed static capability owns lint. `next build` enforces TypeScript validation.
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    localPatterns: [
      {
        pathname: "/api/oracle/plates/**",
      },
    ],
  },
  // Ensure all routes run in Node.js runtime (not Edge)
  experimental: {
    // Reduce peak Webpack memory during production builds. This keeps the
    // ordinary build path viable on the bounded-memory self-hosted environment
    // without weakening type checks or changing runtime behavior.
    webpackMemoryOptimizations: true,
    // Enable server actions for form handling
    serverActions: {
      bodySizeLimit: "1mb",
      ...(env.serverActionAllowedOrigins.length > 0
        ? { allowedOrigins: [...env.serverActionAllowedOrigins] }
        : {}),
    },
  },

  // Static security headers (dynamic CSP + Reporting-Endpoints are set in middleware).
  // Single source of truth: src/lib/security/headers.ts.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...STATIC_SECURITY_HEADERS],
      },
    ];
  },
};

export default nextConfig;
