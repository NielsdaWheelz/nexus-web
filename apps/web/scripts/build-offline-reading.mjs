// Builds the zero-network offline reader shelf packaged into the APK.
//
// The output tree is a build artifact, not source: it is git-ignored, and
// `apps/android/app/build.gradle.kts` runs this script before merging assets.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import {
  assertPdfJsRuntimeClosure,
  copyPdfJsRuntime,
  declaredPdfJsRuntimePaths,
} from "./copy-pdfjs.mjs";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(webDir, "../android/app/src/main/assets/nexus-offline");
const pdfJsDir = join(webDir, "node_modules/pdfjs-dist");
const packagedPdfJsDir = join(outputDir, "pdfjs");

// Absolute-scheme or protocol-relative references that are inert by
// construction and therefore never a network escape:
//   - XML/SVG namespace identifiers (never fetched by a browser);
//   - the reserved local origin the shelf itself is served from, whose every
//     request is answered by the native interceptor;
//   - React's minified-invariant documentation prefix, which only ever appears
//     inside a thrown Error message.
const INERT_REFERENCE_PREFIXES = [
  "http://www.w3.org/",
  "https://appassets.androidplatform.net/",
  "https://react.dev/errors/",
];
const ABSOLUTE_SCHEME_REFERENCE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)<>\\]*/giu;
const PROTOCOL_RELATIVE_REFERENCE =
  /["'(]\/\/[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}[^\s"'`)<>\\]*/gu;

rmSync(outputDir, { recursive: true, force: true });
await build({ configFile: join(webDir, "vite.offline-reading.config.ts") });
// One copy owner for both the hosted `public/pdfjs` root and this packaged
// root; the version pin and the runtime-declared path list live there.
mkdirSync(packagedPdfJsDir, { recursive: true });
copyPdfJsRuntime(packagedPdfJsDir);

function filesUnder(directory, prefix = "") {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const absolute = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      return statSync(absolute).isDirectory()
        ? filesUnder(absolute, relative)
        : [relative];
    });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function utf8Text(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function externalReferences(text) {
  return [
    ...text.matchAll(ABSOLUTE_SCHEME_REFERENCE),
    ...text.matchAll(PROTOCOL_RELATIVE_REFERENCE),
  ]
    .map((match) => match[0].replace(/^["'(]/u, ""))
    .filter(
      (reference) =>
        !INERT_REFERENCE_PREFIXES.some((prefix) => reference.startsWith(prefix)),
    );
}

// Every pdf.js path `PdfReader` declares must exist in the packaged root. The
// hosted root is asserted by the same owner when `copy-pdfjs.mjs` runs.
assertPdfJsRuntimeClosure(packagedPdfJsDir, "the packaged offline shelf");

// The vendored pdf.js tree is a version-pinned verbatim copy of the installed
// dependency. Its closure guarantee is byte identity with that pinned package,
// which is stronger than scanning third-party sources for URL-shaped strings
// (their comments legitimately cite spec and project URLs). Every non-pdf.js
// emitted text asset gets the strict scan below.
const runtimeFileNames = new Map([
  ["pdf.mjs", "build/pdf.mjs"],
  ["pdf.worker.min.mjs", "build/pdf.worker.min.mjs"],
  ["pdf_viewer.mjs", "web/pdf_viewer.mjs"],
]);
for (const relativePath of filesUnder(packagedPdfJsDir)) {
  const sourcePath = runtimeFileNames.get(relativePath) ?? relativePath;
  if (sha256(join(packagedPdfJsDir, relativePath)) !== sha256(join(pdfJsDir, sourcePath))) {
    throw new Error(`Packaged pdf.js asset diverges from pdfjs-dist: ${relativePath}`);
  }
}

const declaredPdfJsRoots = declaredPdfJsRuntimePaths().map(
  (declared) => `pdfjs/${declared.replace(/\/$/u, "")}`,
);
for (const relativePath of filesUnder(outputDir)) {
  if (
    declaredPdfJsRoots.some(
      (root) => relativePath === root || relativePath.startsWith(`${root}/`),
    )
  ) {
    continue;
  }
  const text = utf8Text(readFileSync(join(outputDir, relativePath)));
  if (text === null) continue;
  const external = externalReferences(text);
  if (external.length > 0) {
    throw new Error(
      `Offline asset references a remote origin: ${relativePath} -> ${external[0]}`,
    );
  }
}
