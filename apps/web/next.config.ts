import type { NextConfig } from "next";
import { STATIC_SECURITY_HEADERS } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  // `make check` owns lint and type verification. `make build` only verifies buildability.
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    localPatterns: [
      {
        pathname: "/api/media/image",
      },
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
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
