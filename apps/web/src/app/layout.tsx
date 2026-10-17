import localFont from "next/font/local";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import "pdfjs-dist/web/pdf_viewer.css";
import { SolarEffects } from "@/components/theme/SolarEffects";
import { readThemeCookie } from "@/lib/theme/cookie";
import { ROOM_CHROME } from "@/lib/theme/room";
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

// The chosen room must reach the browser chrome.
export async function generateViewport(): Promise<Viewport> {
  return {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    interactiveWidget: "resizes-content",
    themeColor: ROOM_CHROME[await readThemeCookie()],
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
      data-theme={theme}
      className={`${inter.variable} ${jetbrainsMono.variable} ${ebGaramond.variable} ${cormorant.variable} ${imFellEnglish.variable} ${unifrakturMaguntia.variable}`}
    >
      <body>
        <SolarEffects />
        <div className="app-viewport">{children}</div>
      </body>
    </html>
  );
}
