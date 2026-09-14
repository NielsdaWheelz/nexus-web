// The shelf reuses the hosted design-token owner, the pdf.js viewer stylesheet
// and the reader apparatus/highlight sheets so the shared reader core renders
// with the same geometry it has in the workspace. All four are bundled locally
// by Vite; the packaged closure stays hermetic.
//
// Import order is load order: these come before every component module, so
// `offlineReading.module.css` -- reached through `OfflineReadingShelf` below --
// is emitted last and owns every shelf-specific override.
import "@/app/globals.css";
import "pdfjs-dist/web/pdf_viewer.css";
import "@/lib/highlights/highlights.css";
import "@/lib/reader/apparatus.css";

import { ResourceCacheProvider } from "@/lib/api/resourceCache";
import { READER_CAPACITY } from "@/lib/reader/readerCapacity";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import OfflineReadingShelf from "./OfflineReadingShelf";
import { createWebKitOfflineReadingTransport } from "@/lib/offlineReading/transport";
import { OfflineReadingControllerRuntime } from "@/lib/offlineReading/runtime";

const transport = createWebKitOfflineReadingTransport();
if (transport === null)
  throw new Error("Offline reading requires the Nexus Android capability");
const root = document.getElementById("root");
if (root === null) throw new Error("Offline reading root is missing");
// The native handshake and channel belong to this document, outside React replay.
const controller = new OfflineReadingControllerRuntime(transport);
void controller.connect("Offline").catch(() => {
  // justify-ignore-error: connect publishes its retained failure to the shelf.
});

createRoot(root).render(
  <StrictMode>
    <ResourceCacheProvider value={{}} publicationLimits={READER_CAPACITY.cache}>
      <OfflineReadingShelf controller={controller} />
    </ResourceCacheProvider>
  </StrictMode>,
);
