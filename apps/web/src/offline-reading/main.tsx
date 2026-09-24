// The shelf reuses the hosted design-token owner, the packaged font map, the
// pdf.js viewer stylesheet and the reader apparatus/highlight sheets so the
// shared reader core renders with the same geometry it has in the workspace.
// All five are bundled locally by Vite; the packaged closure stays hermetic.
//
// Import order is load order: these come before every component module, so
// `offlineReading.module.css` -- reached through `OfflineReadingShelf` below --
// is emitted last and owns every shelf-specific override.
import "@/app/globals.css";
import "@/app/packagedFonts.css";
import "pdfjs-dist/web/pdf_viewer.css";
import "@/lib/highlights/highlights.css";
import "@/lib/reader/apparatus.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import OfflineReadingShelf from "./OfflineReadingShelf";
import { OfflineReadingControllerRuntime } from "@/lib/offlineReading/runtime";
import { createWebKitOfflineReadingTransport } from "@/lib/offlineReading/transport";

const transport = createWebKitOfflineReadingTransport();
if (transport === null) throw new Error("Offline reading requires the Nexus Android capability");
const root = document.getElementById("root");
if (root === null) throw new Error("Offline reading root is missing");

createRoot(root).render(
  <StrictMode>
    <OfflineReadingShelf controller={new OfflineReadingControllerRuntime(transport)} />
  </StrictMode>,
);
