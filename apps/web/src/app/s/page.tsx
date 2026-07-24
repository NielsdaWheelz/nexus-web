import type { Metadata } from "next";
import PublicShareReader from "./PublicShareReader";

export const metadata: Metadata = {
  title: "Shared reading · Nexus",
  description: "A document shared through Nexus.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function PublicSharePage() {
  return <PublicShareReader />;
}
