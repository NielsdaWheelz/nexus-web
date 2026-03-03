import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const PDF_VIEWER_MODULE_PATH = path.join(
  process.cwd(),
  "node_modules",
  "pdfjs-dist",
  "web",
  "pdf_viewer.mjs"
);

export async function GET() {
  try {
    const source = await readFile(PDF_VIEWER_MODULE_PATH, "utf-8");
    return new Response(source, {
      status: 200,
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response("PDF.js viewer module not available", { status: 404 });
  }
}
