// Global sheets first: shelf.module.css, reached through Shelf, loads last and
// owns every shelf-specific override.
import "@/app/globals.css";
import "@/app/packagedFonts.css";
import "pdfjs-dist/web/pdf_viewer.css";

import { NavigationIdentity } from "@/lib/host/policy";
import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { readNativeAuthoredAccount } from "@/lib/authored/native";
import { ShelfAccount, type ShelfAccountState } from "./ShelfReader";
import { createRoot } from "react-dom/client";
import { connectLocalContent } from "@/lib/offline/localContent";
import Shelf from "./Shelf";
import { MobileViewportProvider } from "@/lib/mobileShell/viewport";
import { RenderEnvironmentProvider } from "@/lib/renderEnvironment/provider";
import { NAV_COLLAPSED_COOKIE, type RenderEnvironment } from "@/lib/renderEnvironment/types";

// This entry is the packaged Android shelf, independent of the workspace document.
const environment: RenderEnvironment = {
  androidShell: true,
  platform: "android",
  displayLocale: navigator.language,
  displayTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  currentInstant: new Date().toISOString(),
  navCollapsed: document.cookie.split(";").some(value => value.trim() === `${NAV_COLLAPSED_COOKIE}=1`),
};

function ShelfFrame() {
  const [href, setHref] = useState(window.location.href);
  useEffect(() => {
    const update = () => setHref(window.location.href);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return <NavigationIdentity value={href}><ShelfAccountScope><Shelf /></ShelfAccountScope></NavigationIdentity>;
}

/** The native session names the account; the shelf document never chooses one. Copy
 * reading never waits on it: each reader mounts its annotation layer once it is known. */
function ShelfAccountScope({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<ShelfAccountState>({ kind: "Loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const retry = () => { setState({ kind: "Loading" }); setAttempt(value => value + 1); };
    void readNativeAuthoredAccount().then(id => { if (live) setState({ kind: "Ready", id }); },
      () => { if (live) setState({ kind: "Unavailable", retry }); });
    return () => { live = false; };
  }, [attempt]);
  return <ShelfAccount value={state}>{children}</ShelfAccount>;
}

connectLocalContent({ accountId: null, indexPath: "/shelf/downloads.json" });
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RenderEnvironmentProvider value={environment}>
      <MobileViewportProvider><ShelfFrame /></MobileViewportProvider>
    </RenderEnvironmentProvider>
  </StrictMode>,
);
