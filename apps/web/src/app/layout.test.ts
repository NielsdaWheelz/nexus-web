import { describe, it, expect, vi } from "vitest";

vi.mock("next/font/google", () => {
  const loadFont = () => ({ variable: "test-font-variable" });
  return {
    EB_Garamond: loadFont,
    IM_Fell_English: loadFont,
    Inter: loadFont,
    JetBrains_Mono: loadFont,
    UnifrakturMaguntia: loadFont,
  };
});

import { viewport } from "@/app/layout";

/**
 * Verifies the root layout exports a Next.js Viewport with viewport-fit=cover.
 * Without viewport-fit=cover, env(safe-area-inset-*) returns 0 on notched
 * devices, making all safe-area padding in the app ineffective.
 */
describe("Root layout viewport export", () => {
  it("sets viewportFit to cover for safe-area-inset activation", () => {
    expect(viewport.viewportFit).toBe("cover");
  });

  it("sets standard width and initialScale", () => {
    expect(viewport.width).toBe("device-width");
    expect(viewport.initialScale).toBe(1);
  });
});
