// Copies pdf.js runtime assets into public/ so they are served as static
// files. They cannot be served from a route that reads node_modules at
// request time -- Next.js does not trace those files into the deployed function.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(webDir, "node_modules", "pdfjs-dist");
const targetDir = join(webDir, "public", "pdfjs");

mkdirSync(targetDir, { recursive: true });
for (const [from, to] of [
  ["build/pdf.mjs", "pdf.mjs"],
  ["build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["web/pdf_viewer.mjs", "pdf_viewer.mjs"],
]) {
  copyFileSync(join(sourceDir, from), join(targetDir, to));
}
