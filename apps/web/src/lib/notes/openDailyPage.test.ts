import { describe, expect, it } from "vitest";
import { resolveDailyLocalDate } from "./openDailyPage";

describe("resolveDailyLocalDate", () => {
  it("uses the current account zone for every future Today resolution", () => {
    const now = new Date("2026-07-30T01:30:00Z");

    expect(
      resolveDailyLocalDate("Today", "America/Los_Angeles", now),
    ).toBe("2026-07-29");
    expect(resolveDailyLocalDate("Today", "Asia/Tokyo", now)).toBe(
      "2026-07-30",
    );
  });
});
