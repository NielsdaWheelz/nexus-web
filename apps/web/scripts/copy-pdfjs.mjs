// The single pdf.js runtime-asset copy owner.
//
// Copies pdf.js runtime assets into a static root so they are served as static
// files. They cannot be served from a route that reads node_modules at
// request time -- Next.js does not trace those files into the deployed function.
//
// Both roots that must carry these bytes call `copyPdfJsRuntime`:
//   - the hosted app's `public/pdfjs` (this module's CLI entry, run by
//     `bun run dev` / `bun run build`);
//   - the packaged APK shelf's `nexus-offline/pdfjs`
//     (scripts/build-offline-reading.mjs).
// There is no second copy list.
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(webDir, "node_modules", "pdfjs-dist");
const expectedVersion = "5.7.284";

/** Single files copied verbatim from `pdfjs-dist` into the runtime root. */
const RUNTIME_FILES = [
  ["build/pdf.mjs", "pdf.mjs"],
  ["build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["web/pdf_viewer.mjs", "pdf_viewer.mjs"],
];

/** Directories `getDocument` resolves at runtime (cMapUrl/standardFontDataUrl/wasmUrl). */
const RUNTIME_DIRECTORIES = ["cmaps", "standard_fonts", "wasm"];

function assertInstalledVersion() {
  const installedVersion = JSON.parse(
    readFileSync(join(sourceDir, "package.json"), "utf8"),
  ).version;
  if (installedVersion !== expectedVersion) {
    throw new Error(
      `Expected pdfjs-dist ${expectedVersion}, found ${String(installedVersion)}.`,
    );
  }
}

/**
 * Every pdf.js path the reader runtime declares, read back from the single
 * declaring owner so the copy list cannot drift from what `PdfReader` requests.
 * `pdfRuntimePath("cmaps/")` style directory declarations become directory
 * requirements; file declarations become file requirements.
 */
export function declaredPdfJsRuntimePaths() {
  const runtimeSource = readFileSync(
    join(webDir, "src/components/pdfReaderRuntime.ts"),
    "utf8",
  );
  const declared = [
    ...runtimeSource.matchAll(/pdfRuntimePath\(\s*"([^"]+)"/gu),
  ].map((match) => match[1]);
  if (declared.length === 0) {
    throw new Error("pdfReaderRuntime.ts declares no pdf.js runtime paths");
  }
  return [...new Set(declared)].sort();
}

/** Fails when a declared runtime path is missing from `root`. */
export function assertPdfJsRuntimeClosure(root, label) {
  const missing = declaredPdfJsRuntimePaths().filter(
    (declared) => !existsSync(join(root, declared)),
  );
  if (missing.length > 0) {
    throw new Error(
      `${label} is missing declared pdf.js runtime assets: ${missing.join(", ")}`,
    );
  }
}

/** Copies the exact worker/viewer/CMaps/standard-fonts/WASM set into `targetDir`. */
export function copyPdfJsRuntime(targetDir) {
  assertInstalledVersion();
  mkdirSync(targetDir, { recursive: true });
  for (const [from, to] of RUNTIME_FILES) {
    copyFileSync(join(sourceDir, from), join(targetDir, to));
  }
  for (const directory of RUNTIME_DIRECTORIES) {
    cpSync(join(sourceDir, directory), join(targetDir, directory), {
      recursive: true,
    });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const hostedRoot = join(webDir, "public", "pdfjs");
  copyPdfJsRuntime(hostedRoot);
  assertPdfJsRuntimeClosure(hostedRoot, "apps/web/public/pdfjs");
}
