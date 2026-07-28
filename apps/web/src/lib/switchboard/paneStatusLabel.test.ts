import { describe, expect, it } from "vitest";
import { paneStatusLabel } from "./paneStatusLabel";

describe("paneStatusLabel", () => {
  it("labels the current pane as the active tab", () => {
    expect(
      paneStatusLabel({ current: true, visibility: "visible" }),
    ).toBe("Active tab");
  });

  it("labels a current pane active even when minimized", () => {
    expect(
      paneStatusLabel({ current: true, visibility: "minimized" }),
    ).toBe("Active tab");
  });

  it("labels a minimized non-current pane as minimized", () => {
    expect(
      paneStatusLabel({ current: false, visibility: "minimized" }),
    ).toBe("Minimized");
  });

  it("labels a visible non-current pane as an open tab", () => {
    expect(
      paneStatusLabel({ current: false, visibility: "visible" }),
    ).toBe("Open tab");
  });
});
