import type { Metadata } from "next";
import PublicShareReader from "./PublicShareReader";

export const metadata: Metadata = {
  // No title element here: the reader renders the only one, naming the shared document.
  title: null,
  description: "A document shared through Nexus.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function PublicSharePage() {
  return <PublicShareReader />;
}
