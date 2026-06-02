import { Inter, JetBrains_Mono } from "next/font/google";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import "pdfjs-dist/web/pdf_viewer.css";
import "@/lib/highlights/highlights.css";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { readThemeCookie } from "@/lib/theme/cookie";
import { BRAND_BG_DARK, BRAND_BG_LIGHT } from "@/lib/brand";

export const metadata: Metadata = {
  title: "Nexus",
  description: "A reading and notes platform",
  applicationName: "Nexus",
  openGraph: {
    title: "Nexus",
    description: "A reading and notes platform",
    siteName: "Nexus",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Nexus",
    description: "A reading and notes platform",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: BRAND_BG_LIGHT },
    { media: "(prefers-color-scheme: dark)", color: BRAND_BG_DARK },
  ],
};

// Inter is the body/LCP font on every route, so it is the one font we preload
// (next/font preloads by default). EB Garamond / IM Fell / Unifraktur are owned
// by the (oracle) route group and are loaded in its layout, so they only
// preload on /oracle routes where they are actually render-critical.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-inter",
});

// Mono backs --font-mono (code blocks, key/keybinding listings, timestamps). It
// is used app-wide but is never the first-paint/LCP text on any route, so we
// opt it out of preload: preloading it competes with Inter for early bandwidth
// without speeding up any initial render.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  preload: false,
  variable: "--font-jetbrains-mono",
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
      className={`${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <FeedbackProvider>{children}</FeedbackProvider>
      </body>
    </html>
  );
}
