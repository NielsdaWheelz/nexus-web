import path from "node:path";
import { servePdfjsFile } from "../servePdfjsFile";

export const runtime = "nodejs";

const PDF_WORKER_PATH = path.join(process.cwd(), "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");

export async function GET() {
  return servePdfjsFile(PDF_WORKER_PATH, "PDF.js worker");
}
