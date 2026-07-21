import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The sole CI gate for AC-7 (machine-hand-hard-cutover.md §11 S0, §14): parse the
// real hex values of --ink-machine and its background surfaces out of globals.css
// per theme, compute the WCAG 2.x relative-luminance contrast ratio, and assert
// every machine-ink × surface pair clears AA (>= 4.5). A future palette move that
// darkens a room's ink or lightens a surface therefore breaks CI, not the eye.

const APP_ROOT = process.cwd();

function globalsCss(): string {
  return readFileSync(join(APP_ROOT, "src/app/globals.css"), "utf8");
}

// Extract the declaration block for a top-level selector (e.g. ":root",
// '[data-theme="light"]') from globals.css so a token is read from the right theme.
function themeBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`missing theme block: ${selector}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`unterminated theme block: ${selector}`);
}

function hexToken(block: string, name: string): string {
  const match = block.match(
    new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\b`),
  );
  if (!match) throw new Error(`missing hex token --${name}`);
  return match[1];
}

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("machine-ink contrast gate (AC-7)", () => {
  const css = globalsCss();
  // Dark defaults live inside :root; explicit light lives in [data-theme="light"]
  // (the prefers-color-scheme fallback carries identical values — verified by the
  // guard test's presence/count assertion).
  const rooms = [
    { theme: "dark", block: themeBlock(css, ":root") },
    { theme: "light", block: themeBlock(css, '[data-theme="light"]') },
  ];

  for (const { theme, block } of rooms) {
    const ink = hexToken(block, "ink-machine");
    for (const surface of ["surface-1", "surface-canvas"] as const) {
      it(`${theme}: --ink-machine on --${surface} clears AA`, () => {
        const ratio = contrastRatio(ink, hexToken(block, surface));
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("collection metadata contrast", () => {
  const css = globalsCss();
  const rooms = [
    { theme: "dark", block: themeBlock(css, ":root") },
    { theme: "light", block: themeBlock(css, '[data-theme="light"]') },
  ];

  for (const { theme, block } of rooms) {
    const ink = hexToken(block, "ink-muted");
    for (const surface of ["surface-1", "surface-canvas"] as const) {
      it(`${theme}: --ink-muted on --${surface} clears AA`, () => {
        expect(contrastRatio(ink, hexToken(block, surface))).toBeGreaterThanOrEqual(
          4.5,
        );
      });
    }
  }
});
