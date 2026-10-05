// The single pdf.js runtime-asset copy owner.
//
// Copies pdf.js runtime assets into a static root so they are served as static
// files. They cannot be served from a route that reads node_modules at
// request time -- Next.js does not trace those files into the deployed function.
//
// Both roots that must carry these bytes call `copyPdfJsRuntime`:
//   - the hosted app's `public/pdfjs` (this module's CLI entry, run by
//     `bun run dev` / `bun run build`);
//   - the packaged APK shelf's `shelf/pdfjs` (vite.shelf.config.ts).
// There is no second copy list.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(webDir, "node_modules", "pdfjs-dist");
const expectedVersion = "5.7.284";

/** Upstream's legacy build supports the packaged Android WebView as well as
 * hosted browsers. Keep core, worker, and viewer on the same build and version. */
export const PDF_JS_RUNTIME_FILES = [
  ["legacy/build/pdf.mjs", "pdf.mjs"],
  ["legacy/build/pdf.worker.min.mjs", "pdf.worker.min.mjs"],
  ["legacy/web/pdf_viewer.mjs", "pdf_viewer.mjs"],
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

/** The document reader is the one loader of the runtime. */
const RUNTIME_DECLARERS = ["src/lib/documentReader/pdf/pdfjs.ts"];

/**
 * Every pdf.js path the reader runtime declares, read back from the single
 * declaring owner so the copy list cannot drift from what the reader requests.
 * `pdfRuntimePath("cmaps/")` style directory declarations become directory
 * requirements; file declarations become file requirements.
 */
export function declaredPdfJsRuntimePaths() {
  const declared = RUNTIME_DECLARERS.flatMap((file) => {
    const runtimeSource = readFileSync(join(webDir, file), "utf8");
    const paths = [
      ...runtimeSource.matchAll(/pdfRuntimePath\(\s*"([^"]+)"/gu),
    ].map((match) => match[1]);
    if (paths.length === 0) {
      throw new Error(`${file} declares no pdf.js runtime paths`);
    }
    return paths;
  });
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

function removeGeneratedTree(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) removeGeneratedTree(path);
    else unlinkSync(path);
  }
  rmdirSync(root);
}

function copyGeneratedTree(source, target) {
  mkdirSync(target);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyGeneratedTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error(`Unsupported pdf.js runtime asset: ${from}`);
  }
}

function removeGeneratedEntry(path) {
  const entry = readdirSync(dirname(path), { withFileTypes: true }).find(
    (candidate) => candidate.name === basename(path),
  );
  if (entry === undefined) return;
  if (entry.isDirectory()) removeGeneratedTree(path);
  else unlinkSync(path);
}

/** Copies the exact worker/viewer/CMaps/standard-fonts/WASM set into `targetDir`. */
export function copyPdfJsRuntime(targetDir) {
  assertInstalledVersion();
  const parent = dirname(targetDir);
  mkdirSync(parent, { recursive: true });
  // Dirents avoid statting unreadable generated leaves. Symlinks and other
  // non-directory entries are unlinked without traversing outside this root.
  removeGeneratedEntry(targetDir);
  mkdirSync(targetDir);
  for (const [from, to] of PDF_JS_RUNTIME_FILES) {
    copyFileSync(join(sourceDir, from), join(targetDir, to));
  }
  for (const directory of RUNTIME_DIRECTORIES) {
    copyGeneratedTree(join(sourceDir, directory), join(targetDir, directory));
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const hostedRoot = join(webDir, "public", "pdfjs");
  copyPdfJsRuntime(hostedRoot);
  assertPdfJsRuntimeClosure(hostedRoot, "apps/web/public/pdfjs");
}
