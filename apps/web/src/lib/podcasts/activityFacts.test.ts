import { describe, expect, it } from "vitest";
import { decodePodcastUnplayedCount } from "./activityFacts";

describe("decodePodcastUnplayedCount", () => {
  it("constructs absence for zero and a rich positive count otherwise", () => {
    expect(decodePodcastUnplayedCount(0)).toEqual({ kind: "Absent" });
    expect(decodePodcastUnplayedCount(3)).toEqual({
      kind: "Present",
      value: { value: 3 },
    });
  });

  it.each([Number.NaN, -1, 1.5, "3", null])(
    "rejects malformed count %p",
    (value) => {
      expect(() => decodePodcastUnplayedCount(value)).toThrow(/non-negative integer/);
    },
  );
});
