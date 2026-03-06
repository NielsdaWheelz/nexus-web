/**
 * Structural CSS assertions for mobile scroll fixes.
 *
 * These tests verify that critical CSS properties required for mobile
 * scroll behavior are present in the stylesheet source. They catch
 * accidental regressions where a CSS change silently breaks mobile
 * scrolling without any JS-level test failure.
 *
 * Note: Full behavioral verification of these CSS properties (e.g.,
 * computed styles at mobile viewport sizes) belongs in E2E tests.
 * These unit tests are a lightweight safety net.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/** Read a CSS file relative to the vitest project root (apps/web/). */
function readCss(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

describe("mobile scroll CSS safety net", () => {
  describe("root layout viewport height", () => {
    const css = readCss("src/app/(authenticated)/layout.module.css");

    it("uses 100dvh for dynamic mobile viewport height", () => {
      expect(
        css,
        "Root layout must use 100dvh so the app fits within the dynamic mobile viewport " +
          "(100vh includes the hidden address bar, causing content to be pushed below the fold)"
      ).toContain("100dvh");
    });

    it("retains 100vh as a fallback for older browsers", () => {
      expect(
        css,
        "Root layout must keep 100vh as a fallback for browsers that don't support dvh"
      ).toContain("100vh");
    });
  });

  describe("PDF reader viewport on mobile", () => {
    const css = readCss("src/components/PdfReader.module.css");

    it("uses dvh for PDF viewport height on mobile", () => {
      expect(
        css,
        "PDF viewport should use dvh on mobile to account for dynamic address bar"
      ).toMatch(/dvh/);
    });
  });

  describe("transcript segments on mobile", () => {
    const css = readCss("src/app/(authenticated)/media/[id]/page.module.css");

    it("uses viewport-relative max-height for transcript segments on mobile", () => {
      expect(
        css,
        "Transcript segments should use dvh for max-height on mobile instead of hardcoded 320px"
      ).toMatch(/transcriptSegments[\s\S]*?dvh/);
    });
  });
});
