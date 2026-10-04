// Global sheets first: shelf.module.css, reached through Shelf, loads last and
// owns every shelf-specific override.
import "@/app/globals.css";
import "@/app/packagedFonts.css";
import "pdfjs-dist/web/pdf_viewer.css";
import "@/lib/highlights/highlights.css";
import "@/lib/reader/apparatus.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { connectOffline } from "@/lib/offline/bridge";
import Shelf from "./Shelf";

connectOffline();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Shelf />
  </StrictMode>,
);
