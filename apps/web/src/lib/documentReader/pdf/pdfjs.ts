// pdf.js and its viewer, loaded once from the vendored runtime root: the
// hosted app serves /pdfjs, a packaged shell injects its own root at build.
import type * as PdfJs from "pdfjs-dist";
import type * as PdfJsViewer from "pdfjs-dist/web/pdf_viewer.mjs";

declare const __NEXUS_PDF_RUNTIME_ROOT__: string | undefined;

const ROOT =
  typeof __NEXUS_PDF_RUNTIME_ROOT__ === "string"
    ? __NEXUS_PDF_RUNTIME_ROOT__
    : "/pdfjs";

/** scripts/copy-pdfjs.mjs reads these calls as the runtime's asset list. */
function pdfRuntimePath(file: string): string {
  return `${ROOT}/${file}`;
}

export const PDF_ASSETS = {
  cMapUrl: pdfRuntimePath("cmaps/"),
  cMapPacked: true,
  standardFontDataUrl: pdfRuntimePath("standard_fonts/"),
  wasmUrl: pdfRuntimePath("wasm/"),
};

let loaded: Promise<{
  readonly pdfjs: typeof PdfJs;
  readonly viewer: typeof PdfJsViewer;
}> | null = null;

export function loadPdfJs() {
  loaded ??= (async () => {
    // justify-type-assertion: the vendored runtime is the pinned pdfjs-dist build.
    const pdfjs = (await import(
      /* @vite-ignore */ /* webpackIgnore: true */ pdfRuntimePath("pdf.mjs")
    )) as typeof PdfJs;
    pdfjs.GlobalWorkerOptions.workerSrc = pdfRuntimePath("pdf.worker.min.mjs");
    const viewer = (await import(
      /* @vite-ignore */ /* webpackIgnore: true */ pdfRuntimePath(
        "pdf_viewer.mjs",
      )
    )) as typeof PdfJsViewer;
    return { pdfjs, viewer };
  })().catch((error: unknown) => {
    loaded = null;
    throw error;
  });
  return loaded;
}
