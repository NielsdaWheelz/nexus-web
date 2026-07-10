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

const violations = [];

for (const file of collectCssFiles(srcDir)) {
  const relativePath = toPosix(relative(webDir, file));
  if (isAllowedPath(relativePath)) {
    continue;
  }

  const source = stripCssComments(readFileSync(file, "utf8"));
  const lines = source.split("\n");

  lines.forEach((line, lineIndex) => {
    const matches = [...line.matchAll(COLOR_LITERAL_PATTERN)];
    for (const match of matches) {
      violations.push({
        path: relativePath,
        line: lineIndex + 1,
        token: match[0],
      });
    }
  });
}

if (violations.length > 0) {
  console.error("Raw CSS color literals must live in the theme owner or a documented scoped palette.");
  console.error("Use semantic custom properties from src/app/globals.css in ordinary CSS modules.");
  console.error("");
  for (const violation of violations) {
    console.error(`${violation.path}:${violation.line}: ${violation.token}`);
  }
  process.exit(1);
}
