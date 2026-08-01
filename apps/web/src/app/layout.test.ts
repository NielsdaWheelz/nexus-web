import { describe, it, expect, vi } from "vitest";

vi.mock("next/font/google", () => {
  const loadFont = () => ({ variable: "test-font-variable" });
  return {
    Inter: loadFont,
    JetBrains_Mono: loadFont,
    EB_Garamond: loadFont,
    IM_Fell_English: loadFont,
    UnifrakturMaguntia: loadFont,
  };
});

import { viewport } from "@/app/layout";

/**
 * Verifies the root layout exports a Next.js Viewport with viewport-fit=cover.
 * Without viewport-fit=cover, the browser-provided safe-area values remain 0
 * on notched devices, making the root inset adapter ineffective.
 */
describe("Root layout viewport export", () => {
  it("sets viewportFit to cover for root safe-area activation", () => {
    expect(viewport.viewportFit).toBe("cover");
  });

  it("sets interactiveWidget to resizes-content so the keyboard resizes the layout viewport", () => {
    expect(viewport.interactiveWidget).toBe("resizes-content");
  });

  it("sets standard width and initialScale", () => {
    expect(viewport.width).toBe("device-width");
    expect(viewport.initialScale).toBe(1);
  });
});
