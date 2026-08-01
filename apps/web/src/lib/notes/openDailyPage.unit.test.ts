import { describe, expect, it } from "vitest";
import { resolveDailyLocalDate } from "./openDailyPage";

describe("Today resolution", () => {
  it("uses the authenticated account time zone at the same instant", () => {
    const now = new Date("2026-07-30T01:30:00Z");

    expect(
      resolveDailyLocalDate({ kind: "Today" }, "America/Los_Angeles", now),
    ).toBe("2026-07-29");
    expect(resolveDailyLocalDate({ kind: "Today" }, "Asia/Tokyo", now)).toBe(
      "2026-07-30",
    );
  });
});
