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

export const metadata: Metadata = {
  title: "Nexus",
  description: "A reading and notes platform",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jetbrainsMono.variable} ${ebGaramond.variable} ${imFellEnglish.variable} ${unifrakturMaguntia.variable}`}
    >
      <body>
        <FeedbackProvider>{children}</FeedbackProvider>
      </body>
    </html>
  );
}
