import type { Metadata } from "next";
import "./globals.css";
import "pdfjs-dist/web/pdf_viewer.css";

export const metadata: Metadata = {
  title: "Nexus",
  description: "A reading and annotation platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
