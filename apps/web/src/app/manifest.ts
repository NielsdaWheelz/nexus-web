import type { MetadataRoute } from "next";
import { BRAND_BG_DARK } from "@/lib/brand";
import { PRODUCT_DESCRIPTOR, PRODUCT_NAME } from "@/lib/productIdentity";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: PRODUCT_NAME,
    short_name: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTOR,
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
