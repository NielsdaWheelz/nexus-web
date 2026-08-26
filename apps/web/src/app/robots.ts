import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: [
        "/login",
        "/forgot-password",
        "/account/password",
        "/auth/invite",
        "/auth/recovery",
        "/auth/session/recover",
        "/android",
        "/privacy",
        "/terms",
        "/s$",
      ],
      disallow: "/",
    },
  };
}
