import type { MetadataRoute } from "next";
import { BRAND_BG_DARK } from "@/lib/brand";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Nexus",
    short_name: "Nexus",
    description: "A reading and notes platform",
    start_url: "/",
    display: "standalone",
    background_color: BRAND_BG_DARK,
    theme_color: BRAND_BG_DARK,
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
