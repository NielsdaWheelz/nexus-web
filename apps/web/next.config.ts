import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security/headers";
import { getEnv } from "./src/lib/env";
import { APP_AUTHENTICATED_HOME_HREF } from "./src/lib/routes/defaults";

// Fail the deploy, not the request: a staging/prod build with missing/invalid env aborts
// `next build`, so Vercel never promotes the bad artifact and the last-good deployment keeps
// serving. Local/test builds keep local defaults.
const env = getEnv();

const nextConfig: NextConfig = {
  // `make check` owns lint. `next build` enforces build-time TypeScript validation.
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

  // Redirect root to the authenticated app home.
  async redirects() {
    return [
      {
        source: "/",
        destination: APP_AUTHENTICATED_HOME_HREF,
        permanent: false,
      },
    ];
  },
};

if (process.env.E2E_DISABLE_NEXT_DEV_INDICATOR === "1") {
  nextConfig.devIndicators = false;
}

export default nextConfig;
