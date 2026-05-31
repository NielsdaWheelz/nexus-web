import { describe, expect, it } from "vitest";
import { nextRovingIndexForKey } from "./rovingIndex";

describe("nextRovingIndexForKey", () => {
  it("clamps vertical arrow movement", () => {
    expect(
      nextRovingIndexForKey({
        key: "ArrowUp",
        currentIndex: 0,
        itemCount: 3,
        orientation: "vertical",
      }),
    ).toBe(0);
    expect(
      nextRovingIndexForKey({
        key: "ArrowDown",
        currentIndex: 1,
        itemCount: 3,
        orientation: "vertical",
      }),
    ).toBe(2);
  });

  it("wraps horizontal arrow movement when requested", () => {
    expect(
      nextRovingIndexForKey({
        key: "ArrowLeft",
        currentIndex: 0,
        itemCount: 3,
        orientation: "horizontal",
        wrap: true,
      }),
    ).toBe(2);
  });

  it("handles Home and End only when enabled", () => {
    expect(
      nextRovingIndexForKey({
        key: "End",
        currentIndex: 0,
        itemCount: 3,
        orientation: "horizontal",
      }),
    ).toBe(2);
    expect(
      nextRovingIndexForKey({
        key: "End",
        currentIndex: 0,
        itemCount: 3,
        orientation: "horizontal",
        homeEnd: false,
      }),
    ).toBeNull();
  });
});
