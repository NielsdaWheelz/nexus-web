import "@testing-library/jest-dom/vitest";
import "pdfjs-dist/web/pdf_viewer.css";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
