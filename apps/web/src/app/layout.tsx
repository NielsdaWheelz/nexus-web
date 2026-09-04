import localFont from "next/font/local";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import "pdfjs-dist/web/pdf_viewer.css";
import "@/lib/highlights/highlights.css";
import "@/lib/reader/apparatus.css";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { SolarEffects } from "@/components/theme/SolarEffects";
import { readThemeCookie } from "@/lib/theme/cookie";
import { BRAND_BG_DARK, BRAND_BG_LIGHT } from "@/lib/brand";
import { getEnv } from "@/lib/env";
import { PRODUCT_DESCRIPTOR, PRODUCT_NAME } from "@/lib/productIdentity";

export const metadata: Metadata = {
  metadataBase: new URL(getEnv().appPublicOrigin),
  title: PRODUCT_NAME,
  description: PRODUCT_DESCRIPTOR,
  applicationName: PRODUCT_NAME,
  openGraph: {
    title: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTOR,
    siteName: PRODUCT_NAME,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTOR,
  },
};

// --surface-canvas of the [data-theme="elvish"] block in globals.css. It is not
// in the brand module because that module is generated from the asterism SVG.
const SOLAR_BG = "#15201b";

// An explicit theme choice must reach the browser chrome; only "system" (no
// cookie) can defer to the media query, which knows nothing of the Solar.
export async function generateViewport(): Promise<Viewport> {
  const theme = await readThemeCookie();
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    interactiveWidget: "resizes-content",
    themeColor:
      theme === null
        ? [
            { media: "(prefers-color-scheme: light)", color: BRAND_BG_LIGHT },
            { media: "(prefers-color-scheme: dark)", color: BRAND_BG_DARK },
          ]
        : { light: BRAND_BG_LIGHT, dark: BRAND_BG_DARK, elvish: SOLAR_BG }[theme],
  };
}

// Fonts are immutable local build inputs: production builds, the hosted app,
// and the packaged reader never depend on a third-party font CDN. Inter is the
// body/LCP font on every route, so it is the one font we preload. The other
// faces remain demand-loaded through their CSS variables.
const inter = localFont({
  src: "./fonts/inter-latin.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-inter",
});

// Mono backs --font-mono (code blocks, key/keybinding listings, timestamps). It
// is used app-wide but is never the first-paint/LCP text on any route, so we
// opt it out of preload: preloading it competes with Inter for early bandwidth
// without speeding up any initial render.
const jetbrainsMono = localFont({
  src: "./fonts/jetbrains-mono-latin.woff2",
  weight: "400 800",
  style: "normal",
  display: "swap",
  preload: false,
  variable: "--font-jetbrains-mono",
});

const ebGaramond = localFont({
  src: [
    {
      path: "./fonts/eb-garamond-normal-latin.woff2",
      weight: "400 800",
      style: "normal",
    },
    {
      path: "./fonts/eb-garamond-italic-latin.woff2",
      weight: "400 800",
      style: "italic",
    },
  ],
  display: "swap",
  preload: false,
  variable: "--font-eb-garamond",
});

// Cormorant is the Solar's display face, demand-loaded, never first-paint.
const cormorant = localFont({
  src: [
    {
      path: "./fonts/cormorant-normal-latin.woff2",
      weight: "300",
      style: "normal",
    },
    {
      path: "./fonts/cormorant-italic-latin.woff2",
      weight: "300",
      style: "italic",
    },
  ],
  display: "swap",
  preload: false,
  variable: "--font-cormorant",
});

const imFellEnglish = localFont({
  src: [
    {
      path: "./fonts/im-fell-english-normal-latin.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/im-fell-english-italic-latin.woff2",
      weight: "400",
      style: "italic",
    },
  ],
  display: "swap",
  preload: false,
  variable: "--font-im-fell",
});

const unifrakturMaguntia = localFont({
  src: "./fonts/unifraktur-maguntia-latin.woff2",
  weight: "400",
  style: "normal",
  display: "swap",
  preload: false,
  variable: "--font-unifraktur",
});

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const theme = await readThemeCookie();
  return (
    <html
      lang="en"
      data-theme={theme ?? undefined}
      className={`${inter.variable} ${jetbrainsMono.variable} ${ebGaramond.variable} ${cormorant.variable} ${imFellEnglish.variable} ${unifrakturMaguntia.variable}`}
    >
      <body>
        <SolarEffects />
        <FeedbackProvider>{children}</FeedbackProvider>
      </body>
    </html>
  );
}
