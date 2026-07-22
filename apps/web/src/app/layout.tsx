import { EB_Garamond, IM_Fell_English, Inter, JetBrains_Mono, UnifrakturMaguntia } from "next/font/google";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import "pdfjs-dist/web/pdf_viewer.css";
import "@/lib/highlights/highlights.css";
import "@/lib/reader/apparatus.css";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { readThemeCookie } from "@/lib/theme/cookie";
import { BRAND_BG_DARK, BRAND_BG_LIGHT } from "@/lib/brand";
import { getEnv } from "@/lib/env";

export const metadata: Metadata = {
  metadataBase: new URL(getEnv().appPublicOrigin),
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
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: BRAND_BG_LIGHT },
    { media: "(prefers-color-scheme: dark)", color: BRAND_BG_DARK },
  ],
};

// Inter is the body/LCP font on every route, so it is the one font we preload
// (next/font preloads by default). EB Garamond / IM Fell / Unifraktur back the
// oracle pane theme (--font-oracle-*). preload:false keeps the @font-face CSS
// and font variables in the global sheet without emitting <link rel="preload">
// on non-oracle routes — font files only download when the oracle pane renders.
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

const ebGaramond = EB_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
  preload: false,
  variable: "--font-eb-garamond",
});

const imFellEnglish = IM_Fell_English({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  display: "swap",
  preload: false,
  variable: "--font-im-fell",
});

const unifrakturMaguntia = UnifrakturMaguntia({
  subsets: ["latin"],
  weight: ["400"],
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
      className={`${inter.variable} ${jetbrainsMono.variable} ${ebGaramond.variable} ${imFellEnglish.variable} ${unifrakturMaguntia.variable}`}
    >
      <body>
        <FeedbackProvider>{children}</FeedbackProvider>
      </body>
    </html>
  );
}
