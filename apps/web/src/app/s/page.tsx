import type { Metadata } from "next";
import PublicShareReader from "./PublicShareReader";
import { loadRenderEnvironment } from "@/lib/renderEnvironment/server";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import { MobileViewportProvider } from "@/lib/mobileShell/viewport";

export const metadata: Metadata = {
  // No title element here: the reader renders the only one, naming the shared document.
  title: null,
  description: "A document shared through Nexus.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function PublicSharePage() {
  const environment = await loadRenderEnvironment();
  return <RenderEnvironmentProvider value={environment}><MobileViewportProvider><PublicShareReader /></MobileViewportProvider></RenderEnvironmentProvider>;
}
