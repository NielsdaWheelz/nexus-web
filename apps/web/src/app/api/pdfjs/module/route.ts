import path from "node:path";
import { servePdfjsFile } from "../servePdfjsFile";

export const runtime = "nodejs";

const PDF_MODULE_PATH = path.join(process.cwd(), "node_modules", "pdfjs-dist", "build", "pdf.mjs");

export async function GET() {
  return servePdfjsFile(PDF_MODULE_PATH, "PDF.js module");
}
