// Global sheets first: shelf.module.css, reached through Shelf, loads last and
// owns every shelf-specific override.
import "@/app/globals.css";
import "@/app/packagedFonts.css";
import "pdfjs-dist/web/pdf_viewer.css";

import { NavigationIdentity } from "@/lib/host/policy";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { connectOffline } from "@/lib/offline/bridge";
import Shelf from "./Shelf";
import { MobileViewportProvider } from "@/lib/mobileShell/viewport";

function ShelfFrame() {
  const [href, setHref] = useState(window.location.href);
  useEffect(() => {
    const update = () => setHref(window.location.href);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return <NavigationIdentity value={href}><Shelf /></NavigationIdentity>;
}

connectOffline();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileViewportProvider><ShelfFrame /></MobileViewportProvider>
  </StrictMode>,
);
