import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(webDir, "src");

const COLOR_LITERAL_PATTERN =
  /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|\boklch\s*\(/g;

const allowedFiles = new Set([
  "src/app/globals.css",
  "src/app/brand.css",
  "src/app/(authenticated)/media/[id]/page.module.css",
  // The shared reader leaf owns the reader-scoped find-highlight palette that
  // moved out of the media route stylesheet with the reader-core extraction.
  "src/components/reader/textDocumentReader.module.css",
]);

// The packaged APK shelf is its own CSS closure: it never loads a hosted
// stylesheet at runtime, so every custom property its bundled CSS consumes
// without an inline fallback must be declared inside that bundle (or installed
// at runtime by an owner below). The committed bundle is kept current by
// `scripts/build-offline-reading.mjs` and the Gradle staleness check.
const offlineBundleCssDir = join(
  webDir,
  "../android/app/src/main/assets/nexus-offline/assets",
);

// pdfjs-dist/web/pdf_viewer.css consumes variables that pdf.js's full
// `viewer.css` declares for its own toolbar/sidebar/editor chrome. Nexus mounts
// the viewer components without that chrome and deliberately does not ship
// `viewer.css`, hosted or packaged, so these are inert third-party leftovers
// rather than Nexus tokens.
const pdfJsViewerChromeProperties = new Set([
  "--comment-edit-button-icon",
  "--dir-factor",
  "--doorhanger-height",
  "--editor-toolbar-min-width",
  "--icon-size",
  "--main-color",
  "--menuitem-height",
  "--sidebar-transition-duration",
  "--sidebar-transition-timing-function",
  "--toolbar-icon-bg-color",
]);

const runtimeCustomPropertyOwners = new Map([
  // next/font publishes these variables on the root layout class.
  ["--font-eb-garamond", "src/app/layout.tsx"],
  ["--font-im-fell", "src/app/layout.tsx"],
  ["--font-inter", "src/app/layout.tsx"],
  ["--font-jetbrains-mono", "src/app/layout.tsx"],
  ["--font-unifraktur", "src/app/layout.tsx"],
  // Component geometry is measured or derived and installed inline at runtime.
  ["--depth", "src/components/chat/ForkNodeRow.tsx"],
  [
    "--floating-action-caret-inline-offset",
    "src/components/ui/FloatingActionSurface.tsx",
  ],
  [
    "--floating-action-content-max-height",
    "src/components/ui/FloatingActionSurface.tsx",
  ],
  [
    "--floating-action-content-max-width",
    "src/components/ui/FloatingActionSurface.tsx",
  ],
  [
    "--marker-color",
    "src/components/reader/ReaderDocumentMapOverviewRail.tsx",
  ],
  ["--pane-refresh-offset", "src/components/workspace/PaneShell.tsx"],
  [
    "--position",
    "src/components/reader/ReaderDocumentMapOverviewRail.tsx",
  ],
]);

function toPosix(path) {
  return path.split(sep).join("/");
}

function isAllowedPath(relativePath) {
  return (
    allowedFiles.has(relativePath) ||
    relativePath.startsWith("src/app/(authenticated)/oracle/") ||
    // The grand atlas is the manuscript register's escape from the Oracle: it
    // renders under [data-theme="oracle"] and owns a documented scoped palette
    // (the --atlas-* edge tokens) alongside the --oracle-* variables.
    relativePath.startsWith("src/app/(authenticated)/atlas/")
  );
}

function stripCssComments(source) {
  let output = "";
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        output += "  ";
        index += 1;
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      output += "  ";
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function collectCssFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const absolutePath = join(dir, entry);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      collectCssFiles(absolutePath, files);
      continue;
    }
    if (entry.endsWith(".css")) {
      files.push(absolutePath);
    }
  }
  return files;
}

function hasInlineFallback(source, referenceIndex) {
  const openParenthesis = source.indexOf("(", referenceIndex);
  let depth = 0;
  for (let index = openParenthesis; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return false;
    } else if (char === "," && depth === 1) {
      return true;
    }
  }
  return false;
}

function lineNumberAt(source, index) {
  return (source.slice(0, index).match(/\n/g)?.length ?? 0) + 1;
}

for (const [property, owner] of runtimeCustomPropertyOwners) {
  if (!readFileSync(join(webDir, owner), "utf8").includes(property)) {
    throw new Error(`${property} runtime owner missing from ${owner}`);
  }
}

const cssSources = collectCssFiles(srcDir)
  .sort()
  .map((file) => ({
    path: toPosix(relative(webDir, file)),
    source: stripCssComments(readFileSync(file, "utf8")),
  }));
const declaredCustomProperties = new Set();
for (const { source } of cssSources) {
  const declarations = source.matchAll(
    /(?:^|[;{])\s*(--[A-Za-z0-9_-]+)\s*:/gm,
  );
  for (const declaration of declarations) {
    declaredCustomProperties.add(declaration[1]);
  }
}

const colorViolations = [];
const customPropertyViolations = [];

for (const { path, source } of cssSources) {
  const lines = source.split("\n");

  if (!isAllowedPath(path)) {
    lines.forEach((line, lineIndex) => {
      const matches = [...line.matchAll(COLOR_LITERAL_PATTERN)];
      for (const match of matches) {
        colorViolations.push({
          path,
          line: lineIndex + 1,
          token: match[0],
        });
      }
    });
  }

  for (const reference of source.matchAll(
    /var\(\s*(--[A-Za-z0-9_-]+)/g,
  )) {
    const property = reference[1];
    if (
      declaredCustomProperties.has(property) ||
      runtimeCustomPropertyOwners.has(property) ||
      hasInlineFallback(source, reference.index)
    ) {
      continue;
    }
    customPropertyViolations.push({
      path,
      line: lineNumberAt(source, reference.index),
      token: property,
    });
  }
}

const offlineBundleViolations = [];
for (const entry of readdirSync(offlineBundleCssDir)) {
  if (!entry.endsWith(".css")) continue;
  const path = `assets/nexus-offline/assets/${entry}`;
  const source = stripCssComments(
    readFileSync(join(offlineBundleCssDir, entry), "utf8"),
  );
  const bundleDeclared = new Set(
    [...source.matchAll(/(?:^|[;{])\s*(--[A-Za-z0-9_-]+)\s*:/g)].map(
      (declaration) => declaration[1],
    ),
  );
  for (const reference of source.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
    const property = reference[1];
    if (
      bundleDeclared.has(property) ||
      runtimeCustomPropertyOwners.has(property) ||
      pdfJsViewerChromeProperties.has(property) ||
      hasInlineFallback(source, reference.index)
    ) {
      continue;
    }
    if (offlineBundleViolations.some((violation) => violation.token === property)) {
      continue;
    }
    offlineBundleViolations.push({
      path,
      line: lineNumberAt(source, reference.index),
      token: property,
    });
  }
}

if (colorViolations.length > 0) {
  console.error("Raw CSS color literals must live in the theme owner or a documented scoped palette.");
  console.error("Use semantic custom properties from src/app/globals.css in ordinary CSS modules.");
  console.error("");
  for (const violation of colorViolations) {
    console.error(`${violation.path}:${violation.line}: ${violation.token}`);
  }
}

if (customPropertyViolations.length > 0) {
  if (colorViolations.length > 0) console.error("");
  console.error("Undefined CSS custom properties:");
  for (const violation of customPropertyViolations) {
    console.error(`${violation.path}:${violation.line}: ${violation.token}`);
  }
}

if (offlineBundleViolations.length > 0) {
  if (colorViolations.length > 0 || customPropertyViolations.length > 0) {
    console.error("");
  }
  console.error(
    "CSS custom properties consumed by the packaged offline shelf but never declared inside its bundle:",
  );
  for (const violation of offlineBundleViolations) {
    console.error(`${violation.path}:${violation.line}: ${violation.token}`);
  }
  console.error(
    "Declare them in src/offline-reading/offlineReading.module.css or give the consumer an inline fallback.",
  );
}

if (
  colorViolations.length > 0 ||
  customPropertyViolations.length > 0 ||
  offlineBundleViolations.length > 0
) {
  process.exit(1);
}
