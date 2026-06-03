import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security/headers";
import { assertDeploymentEnv } from "./src/lib/env";

// Fail the deploy, not the request: a staging/prod build with missing/invalid connect-origin
// or internal-secret env aborts `next build`, so Vercel never promotes the bad artifact and the
// last-good deployment keeps serving. No-op for local/test builds.
assertDeploymentEnv();

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

  // Redirect root to /libraries
  async redirects() {
    return [
      {
        source: "/",
        destination: "/libraries",
        permanent: false,
      },
    ];
  },
};

if (process.env.E2E_DISABLE_NEXT_DEV_INDICATOR === "1") {
  nextConfig.devIndicators = false;
}

export default nextConfig;
