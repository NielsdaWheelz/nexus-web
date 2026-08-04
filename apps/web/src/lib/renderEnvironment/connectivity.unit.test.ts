import { describe, expect, it } from "vitest";
import { connectivityFromNavigator } from "./connectivity";

// Oracle: the render environment must present a total two-state connectivity
// value. A navigator that is absent or SSR-partial (Node ≥21 exposes a
// `navigator` global without `onLine`) must read as "Online", never "Offline".
describe("connectivityFromNavigator", () => {
  it("reports Online when navigator.onLine is true", () => {
    expect(connectivityFromNavigator({ onLine: true } as Navigator)).toBe(
      "Online",
    );
  });

  it("reports Offline when navigator.onLine is false", () => {
    expect(connectivityFromNavigator({ onLine: false } as Navigator)).toBe(
      "Offline",
    );
  });

  it("reports Online when navigator is absent", () => {
    expect(connectivityFromNavigator(undefined)).toBe("Online");
  });

  it("reports Online when navigator lacks a boolean onLine", () => {
    expect(connectivityFromNavigator({} as Navigator)).toBe("Online");
  });
});
