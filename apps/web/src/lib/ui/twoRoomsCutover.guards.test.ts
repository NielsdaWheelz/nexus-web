import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Negative gates for the Two Rooms hard cutover (two-rooms-hard-cutover.md §13).
// Node `.test.ts` (unit project), cwd = apps/web.

const APP_ROOT = process.cwd();

function sourceText(path: string): string {
  return readFileSync(join(APP_ROOT, path), "utf8");
}

// Extract the content of a top-level CSS block starting with the given selector.
// Handles one level of nesting (used for @media wrapper blocks too).
function cssRuleBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

const GLOBALS = "src/app/globals.css";
const APPNAV_CSS = "src/components/appnav/AppNav.module.css";
const SETTINGS_APPEARANCE =
  "src/app/(authenticated)/settings/appearance/SettingsAppearancePaneBody.tsx";

const TWO_ROOMS_TOKENS = [
  "--body-font-size",
  "--tracking-body",
  "--stroke-hairline",
  "--canvas-grain-opacity",
  "--canvas-grain-image",
] as const;

describe("Two Rooms cutover source gates", () => {
  // §13.1 — five new tokens present in all three theme locations.
  it("declares the five new room tokens in every theme location", () => {
    const globals = sourceText(GLOBALS);

    const darkBlock = cssRuleBlock(globals, ":root");
    const lightBlock = cssRuleBlock(globals, '[data-theme="light"]');
    const systemBlock = cssRuleBlock(globals, ":root:not([data-theme])");

    for (const token of TWO_ROOMS_TOKENS) {
      expect(darkBlock, `${token} missing from dark :root`).toContain(`${token}:`);
      expect(lightBlock, `${token} missing from [data-theme="light"]`).toContain(
        `${token}:`,
      );
      expect(systemBlock, `${token} missing from prefers-color-scheme fallback`).toContain(
        `${token}:`,
      );
    }
    // --stroke-hairline appears in both the invariant scale block (1px) and the
    // Press semantic block (1.5px). The loop above is satisfied by the scale
    // definition alone; assert the Press value explicitly.
    expect(darkBlock, "--stroke-hairline must be 1.5px in Press").toContain(
      "--stroke-hairline: 1.5px",
    );
  });

  // §13.2 — AppNav rail no longer owns the grain SVG filter.
  it("removes feTurbulence from AppNav.module.css", () => {
    const css = sourceText(APPNAV_CSS);
    expect(css).not.toContain("feTurbulence");
  });

  // §13.3 — body rule references the per-room token, not the invariant scale token directly.
  it("uses --body-font-size in the body rule (not --text-base directly)", () => {
    const globals = sourceText(GLOBALS);
    // The body block: find it via "body {" and extract its declarations.
    const bodyStart = globals.indexOf("body {");
    const bodyOpen = globals.indexOf("{", bodyStart);
    const bodyClose = globals.indexOf("}", bodyOpen);
    const bodyBlock = globals.slice(bodyOpen + 1, bodyClose);

    expect(bodyBlock).toContain("font-size: var(--body-font-size)");
    // The old direct body assignment must be gone.
    expect(bodyBlock).not.toContain("font-size: var(--text-base)");
  });

  // §13.4 — Study canvas is warmed to #faf8f3; the old value must be gone.
  it("sets --surface-canvas to #faf8f3 in Study and removes #fafaf7", () => {
    const globals = sourceText(GLOBALS);

    const lightBlock = cssRuleBlock(globals, '[data-theme="light"]');
    expect(lightBlock).toContain("--surface-canvas: #faf8f3");
    expect(lightBlock).not.toContain("--surface-canvas: #fafaf7");

    // The system-preference fallback must also use the new warm canvas.
    const systemBlock = cssRuleBlock(globals, ":root:not([data-theme])");
    expect(systemBlock).toContain("--surface-canvas: #faf8f3");
    expect(systemBlock).not.toContain("--surface-canvas: #fafaf7");
  });

  // §13.5 — settings labels renamed to Study/Press; no title-case Light/Dark as text nodes.
  it("uses Study and Press as visible labels; radio values remain light/dark", () => {
    const tsx = sourceText(SETTINGS_APPEARANCE);

    expect(tsx).toContain("Study");
    expect(tsx).toContain("Press");

    // Title-case text-node form must be absent (value="light" lowercase is OK).
    expect(tsx).not.toMatch(/>Light</);
    expect(tsx).not.toMatch(/>Dark</);

    // Radio value attributes stay unchanged.
    expect(tsx).toContain('value="light"');
    expect(tsx).toContain('value="dark"');
  });
});
