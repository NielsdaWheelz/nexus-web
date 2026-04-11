import path from "node:path";
import { servePdfjsFile } from "../servePdfjsFile";

export const runtime = "nodejs";

const PDF_VIEWER_PATH = path.join(process.cwd(), "node_modules", "pdfjs-dist", "web", "pdf_viewer.mjs");

export async function GET() {
  return servePdfjsFile(PDF_VIEWER_PATH, "PDF.js viewer module");
}
