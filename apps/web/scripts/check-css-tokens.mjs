import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
// at runtime by an owner below). The bundle is a build output: `./scripts/test`
// runs `bun run build:offline-reading` before this check so it is always the
// current one.
const offlineBundleCssDir = join(
  webDir,
  "../android/app/src/main/assets/nexus-offline/assets",
);
if (!existsSync(offlineBundleCssDir)) {
  throw new Error("Run `bun run build:offline-reading` before checking CSS tokens.");
}

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
  ["--font-cormorant", "src/app/layout.tsx"],
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
  // The Solar's two client-computed variables. Both are installed on
  // documentElement after hydration and neither may ever gate first paint:
  // --moon is also authored at 1 in globals.css so the room is never wrong
  // before the effect runs, and --grain-seed is read only through an inline
  // fallback (`var(--grain-seed, 0% 0%)`), which is what keeps the session sky
  // out of the Study and the Press.
  ["--grain-seed", "src/components/theme/SolarEffects.tsx"],
  [
    "--marker-color",
    "src/components/reader/ReaderDocumentMapOverviewRail.tsx",
  ],
  ["--moon", "src/components/theme/SolarEffects.tsx"],
  ["--pane-refresh-offset", "src/components/workspace/PaneShell.tsx"],
  [
    "--position",
    "src/components/reader/ReaderDocumentMapOverviewRail.tsx",
  ],
]);

// Direction §5 — the absence lint. No Tengwar webfont ships, ever: the
// inscriptions are baked outlines, and a transliteration font bound to a live
// DOM text node is the one failure that whole strategy exists to make
// impossible. Only font declarations, the shipped font files themselves, and
// the `src`/`path` strings handed to `localFont()` are read, so the provenance
// prose in elvishInscriptions.ts — which names the design machine's faces on
// purpose — is not a hit.
const TENGWAR_FACE_PATTERN = /tengwar|annatar|telcontar|parmaite/i;

// Every real face in this app arrives as a woff2 on one of these shelves and is
// bound by `next/font/local`, never by an `@font-face` the declaration scan
// could see. A Tengwar file could therefore land here and be loaded without any
// declaration anywhere naming it, which is what these two directories close.
const fontAssetDirs = ["src/app/fonts", "public/fonts"];

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

function collectFiles(dir, extensions, files = []) {
  for (const entry of readdirSync(dir)) {
    const absolutePath = join(dir, entry);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      collectFiles(absolutePath, extensions, files);
      continue;
    }
    if (extensions.some((extension) => entry.endsWith(extension))) {
      files.push(absolutePath);
    }
  }
  return files;
}

// Every font declaration in one file, whatever the file is: `.css` modules and
// the hand-written stylesheet strings inside `.tsx` (the sealed dossier
// document's two are the reason this scan is not CSS-only).
function fontDeclarations(source) {
  return [
    ...source.matchAll(/@font-face\s*\{([^}]*)\}/g),
    ...source.matchAll(/font-family\s*:\s*([^;}]*)/gi),
  ];
}

// The font files a shelf carries, at any depth. Licence sidecars count: a face
// arrives with the licence that names it.
function fontAssetPaths(dir, prefix = "", paths = []) {
  for (const entry of readdirSync(dir)) {
    const absolutePath = join(dir, entry);
    const path = prefix === "" ? entry : `${prefix}/${entry}`;
    if (statSync(absolutePath).isDirectory()) {
      fontAssetPaths(absolutePath, path, paths);
      continue;
    }
    paths.push(path);
  }
  return paths;
}

// The `src`/`path` strings inside a `localFont(…)` call, with their offsets.
// Reading only those two keys of only that call is what keeps ordinary strings
// — provenance prose included — out of the scan.
function localFontSources(source) {
  const sources = [];
  for (const call of source.matchAll(/\blocalFont\s*\(/g)) {
    const open = call.index + call[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < source.length; close += 1) {
      if (source[close] === "(") depth += 1;
      else if (source[close] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    for (const match of source
      .slice(open, close)
      .matchAll(/\b(?:src|path)\s*:\s*["'`]([^"'`]*)["'`]/g)) {
      sources.push({ index: open + match.index, value: match[1] });
    }
  }
  return sources;
}

// The slot the `var()` at `offset` occupies in the nearest enclosing
// `name(…)`, counting whitespace-, comma- and slash-separated top-level
// arguments from 1. Returns 0 when the offset is not inside such a call.
function functionSlot(value, offset, name) {
  for (const match of value.matchAll(new RegExp(`${name}\\s*\\(`, "gi"))) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < value.length; close += 1) {
      if (value[close] === "(") depth += 1;
      else if (value[close] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (offset <= open || offset >= close) continue;
    let slot = 0;
    let inArgument = false;
    let found = 0;
    depth = 0;
    for (let index = open + 1; index < close; index += 1) {
      const char = value[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      if (depth === 0 && (char === "," || char === "/" || /\s/.test(char))) {
        inArgument = false;
        continue;
      }
      if (!inArgument) {
        inArgument = true;
        slot += 1;
      }
      if (index === offset) found = slot;
    }
    if (found > 0) return found;
  }
  return 0;
}

// The declaration a byte offset sits in: everything back to the previous `;`,
// `{` or `}` and forward to the next one.
function declarationAt(source, offset) {
  let start = offset;
  while (start > 0 && !";{}".includes(source[start - 1])) start -= 1;
  let end = offset;
  while (end < source.length && !";{}".includes(source[end])) end += 1;
  const text = source.slice(start, end);
  const colon = text.indexOf(":");
  if (colon === -1) return { property: "", value: text, valueStart: start };
  return {
    property: text.slice(0, colon).trim(),
    value: text.slice(colon + 1),
    valueStart: start + colon + 1,
  };
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

const cssSources = collectFiles(srcDir, [".css"])
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
const moonViolations = [];

for (const { path, source } of cssSources) {
  const lines = source.split("\n");

  // Direction §10 wildcard 2 — the slot law. `--moon` is the one variable in
  // the app that answers to the clock, and it is safe only because it can
  // never reach a lightness or a chroma: it may appear in an `opacity`, in a
  // `drop-shadow` blur radius, or in the third (hue) slot of an `oklch()`,
  // and nowhere else. With that held, no phase of the moon can move a single
  // contrast ratio in the direction's §9 table. Declarations *of* `--moon`
  // are untouched — this reads uses.
  for (const reference of source.matchAll(/var\(\s*--moon\b/g)) {
    const declaration = declarationAt(source, reference.index);
    const offset = reference.index - declaration.valueStart;
    if (
      declaration.property === "opacity" ||
      functionSlot(declaration.value, offset, "drop-shadow") === 3 ||
      functionSlot(declaration.value, offset, "oklch") === 3
    ) {
      continue;
    }
    moonViolations.push({
      path,
      line: lineNumberAt(source, reference.index),
      token: `${declaration.property}: ${declaration.value.trim()}`,
    });
  }

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

// The Tengwar absence lint runs over the modules too, not only the stylesheets:
// the sealed dossier document's stylesheets are hand-written strings inside
// `DossierDocumentFrame.tsx`, and a face bound there would be as real as one in
// a `.css` file and invisible to every other pass here.
const tengwarViolations = [];
for (const file of collectFiles(srcDir, [".ts", ".tsx"]).sort()) {
  const path = toPosix(relative(webDir, file));
  const source = readFileSync(file, "utf8");
  for (const declaration of fontDeclarations(source)) {
    if (!TENGWAR_FACE_PATTERN.test(declaration[1])) continue;
    tengwarViolations.push({
      path,
      line: lineNumberAt(source, declaration.index),
      token: declaration[1].trim(),
    });
  }
  for (const fontSource of localFontSources(source)) {
    if (!TENGWAR_FACE_PATTERN.test(fontSource.value)) continue;
    tengwarViolations.push({
      path,
      line: lineNumberAt(source, fontSource.index),
      token: fontSource.value,
    });
  }
}
for (const dir of fontAssetDirs) {
  const absoluteDir = join(webDir, dir);
  if (!existsSync(absoluteDir)) continue;
  for (const path of fontAssetPaths(absoluteDir).sort()) {
    if (!TENGWAR_FACE_PATTERN.test(path)) continue;
    tengwarViolations.push({ path: `${dir}/${path}` });
  }
}
for (const { path, source } of cssSources) {
  for (const declaration of fontDeclarations(source)) {
    if (!TENGWAR_FACE_PATTERN.test(declaration[1])) continue;
    tengwarViolations.push({
      path,
      line: lineNumberAt(source, declaration.index),
      token: declaration[1].trim(),
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

// Sections are separated by a blank line, whichever of them fire.
let reportedSection = false;
function beginReport() {
  if (reportedSection) console.error("");
  reportedSection = true;
}

if (colorViolations.length > 0) {
  beginReport();
  console.error("Raw CSS color literals must live in the theme owner or a documented scoped palette.");
  console.error("Use semantic custom properties from src/app/globals.css in ordinary CSS modules.");
  console.error("");
  for (const violation of colorViolations) {
    console.error(`${violation.path}:${violation.line}: ${violation.token}`);
  }
}

if (customPropertyViolations.length > 0) {
  beginReport();
  console.error("Undefined CSS custom properties:");
  for (const violation of customPropertyViolations) {
    console.error(`${violation.path}:${violation.line}: ${violation.token}`);
  }
}

if (moonViolations.length > 0) {
  beginReport();
  console.error(
    "--moon outside its permitted slots (the Solar, direction §10 wildcard 2):",
  );
  for (const violation of moonViolations) {
    console.error(`${violation.path}:${violation.line}: ${violation.token}`);
  }
  console.error(
    "The lunar scalar may appear only in an opacity, a drop-shadow blur radius, or the third (hue) slot of an oklch().",
  );
  console.error(
    "Nothing text sits on may vary with the moon — that invariant is what keeps every contrast ratio fixed.",
  );
}

if (tengwarViolations.length > 0) {
  beginReport();
  console.error(
    "A Tengwar face is named in a font declaration, a shipped font file, or a next/font source (the Solar, direction §5):",
  );
  for (const violation of tengwarViolations) {
    console.error(
      violation.line === undefined
        ? violation.path
        : `${violation.path}:${violation.line}: ${violation.token}`,
    );
  }
  console.error(
    "No Tengwar webfont ships, ever. Tengwar fonts are transliteration fonts: bound to a live DOM text node they produce glyph soup.",
  );
  console.error(
    "Inscriptions are baked outlines in src/lib/theme/elvishInscriptions.ts, drawn as aria-hidden SVG paths.",
  );
}

if (offlineBundleViolations.length > 0) {
  beginReport();
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
  moonViolations.length > 0 ||
  tengwarViolations.length > 0 ||
  offlineBundleViolations.length > 0
) {
  process.exit(1);
}
