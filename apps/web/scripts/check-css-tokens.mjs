// the color-literal ban and the undefined-var
// check (V5), the latter also run over each packaged bundle's built css, which
// loads no hosted stylesheet at runtime. the moon slot law, the tengwar absence
// scan and the runtime-owner existence check are gone (design §1 Q3).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|\boklch\s*\(/g;
const LITERALS_ALLOWED =
  /^src\/app\/(globals|brand)\.css$|^src\/lib\/documentReader\/documentReader\.module\.css$|^src\/app\/\(authenticated\)\/(oracle|atlas)\//;
// installed at runtime (next/font on the root layout, or inline styles); not declared in css.
const RUNTIME = new Set([
  "--anchored-max-width",
  "--font-cormorant",
  "--font-eb-garamond",
  "--font-im-fell",
  "--font-inter",
  "--font-jetbrains-mono",
  "--font-unifraktur",
  "--depth",
  "--floating-action-caret-inline-offset",
  "--floating-action-content-max-height",
  "--floating-action-content-max-width",
  "--grain-seed",
  "--moon",
  "--pane-refresh-offset",
]);
const FONTS = [...RUNTIME].filter((name) => name.startsWith("--font-"));
// pdf.js viewer chrome variables nexus never ships (pdf_viewer.css leftovers).
const PDFJS = new Set([
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
const BUNDLES = [
  [
    "the installed android application",
    "../android/app/src/main/assets/app/assets",
    "bun run build:android",
  ],
  [
    "the android shelf",
    "../android/app/src/main/assets/shelf/assets",
    "bun run build:shelf",
  ],
  [
    "the Firefox extension popup",
    "../extension/dist/assets",
    "bun run build:extension",
  ],
];

const strip = (css) =>
  css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
const line = (css, index) => css.slice(0, index).split("\n").length;
const declared = (css) =>
  new Set([...css.matchAll(/(?:^|[;{])\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));
const cssFiles = (dir) =>
  readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith(".css"))
    .map((f) => join(dir, f));
// a var() with a top-level comma carries its own fallback.
function hasFallback(css, at) {
  for (let i = css.indexOf("(", at), depth = 0; i < css.length; i++) {
    if (css[i] === "(") depth++;
    else if (css[i] === ")" && --depth === 0) return false;
    else if (css[i] === "," && depth === 1) return true;
  }
  return false;
}
function undefinedVars(path, css, known, allowed) {
  return [...css.matchAll(/var\(\s*(--[\w-]+)/g)]
    .filter(
      (m) => !known.has(m[1]) && !allowed(m[1]) && !hasFallback(css, m.index),
    )
    .map((m) => `${path}:${line(css, m.index)}: ${m[1]}`);
}

const sources = cssFiles(join(web, "src"))
  .sort()
  .map((f) => [relative(web, f), strip(readFileSync(f, "utf8"))]);
const known = new Set(sources.flatMap(([, css]) => [...declared(css)]));
const colors = sources
  .filter(([path]) => !LITERALS_ALLOWED.test(path))
  .flatMap(([path, css]) =>
    [...css.matchAll(COLOR)].map(
      (m) => `${path}:${line(css, m.index)}: ${m[0]}`,
    ),
  );
const undefs = sources.flatMap(([path, css]) =>
  undefinedVars(path, css, known, (name) => RUNTIME.has(name)),
);
const bundles = BUNDLES.map(([name, dir, build]) => {
  if (!existsSync(join(web, dir)))
    throw new Error(`Run \`${build}\` before checking CSS tokens.`);
  const files = cssFiles(join(web, dir)).map((f) => [
    relative(web, f),
    strip(readFileSync(f, "utf8")),
  ]);
  const own = new Set(files.flatMap(([, css]) => [...declared(css)]));
  const allowed = (v) => PDFJS.has(v) || (RUNTIME.has(v) && !FONTS.includes(v));
  return [
    name,
    [
      ...new Set(
        files.flatMap(([path, css]) => undefinedVars(path, css, own, allowed)),
      ),
    ],
  ];
});

const report = [
  [
    "Raw CSS color literals must use semantic custom properties from src/app/globals.css:",
    colors,
  ],
  ["Undefined CSS custom properties:", undefs],
  ...bundles.map(([name, found]) => [
    `CSS custom properties consumed by ${name} but never declared inside its bundle:`,
    found,
  ]),
].filter(([, found]) => found.length > 0);
for (const [title, found] of report)
  console.error([title, ...found, ""].join("\n"));
if (report.length > 0) process.exit(1);
