import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensure all routes run in Node.js runtime (not Edge)
  experimental: {
    // Enable server actions for form handling
    serverActions: {
      bodySizeLimit: "1mb",
    },
  },

  // Environment variables validation
  env: {
    // These are exposed to the client - only add truly public vars here
  },

  // Headers for security (CSP with nonces handled in middleware)
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
        ],
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

export default nextConfig;
