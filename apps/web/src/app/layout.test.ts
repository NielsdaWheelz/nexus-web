import { describe, it, expect } from "vitest";
import { viewport } from "@/app/viewport";

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
