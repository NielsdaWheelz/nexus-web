import {
  EB_Garamond,
  IM_Fell_English,
  Inter,
  JetBrains_Mono,
  UnifrakturMaguntia,
} from "next/font/google";
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

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains-mono",
});

const ebGaramond = EB_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-eb-garamond",
});

const imFellEnglish = IM_Fell_English({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-im-fell",
});

const unifrakturMaguntia = UnifrakturMaguntia({
  subsets: ["latin"],
  weight: ["400"],
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
