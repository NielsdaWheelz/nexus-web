import type { Metadata } from "next";
import PublicShareReader from "./PublicShareReader";

export const metadata: Metadata = {
  // The shared document names this tab, and only the reader knows it. Resolving
  // the title to null emits no <title> element here at all, so the reader's own
  // rendered title is the single one: streamed metadata can no longer land after
  // hydration and rename an open share back to the app.
  title: null,
  description: "A document shared through Nexus.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function PublicSharePage() {
  return <PublicShareReader />;
}
