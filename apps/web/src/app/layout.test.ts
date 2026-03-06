import { describe, it, expect, beforeAll } from "vitest";

/**
 * Verifies the root layout exports a Next.js Viewport with viewport-fit=cover.
 * Without viewport-fit=cover, env(safe-area-inset-*) returns 0 on notched
 * devices, making all safe-area padding in the app ineffective.
 */
describe("Root layout viewport export", () => {
  let viewport: Record<string, unknown>;

  beforeAll(async () => {
    const mod = await import("@/app/layout");
    const v = (mod as Record<string, unknown>).viewport;
    expect(v).toBeDefined();
    viewport = v as Record<string, unknown>;
  });

  it("sets viewportFit to cover for safe-area-inset activation", () => {
    expect(viewport.viewportFit).toBe("cover");
  });

  it("sets standard width and initialScale", () => {
    expect(viewport.width).toBe("device-width");
    expect(viewport.initialScale).toBe(1);
  });
});
