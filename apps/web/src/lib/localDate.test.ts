import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLocalDateInTimeZone } from "./localDate";

describe("formatLocalDateInTimeZone", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the requested calendar time zone instead of the browser date", () => {
    const instant = new Date("2026-07-30T01:00:00.000Z");

    expect(formatLocalDateInTimeZone(instant, "America/Los_Angeles")).toBe(
      "2026-07-29",
    );
    expect(formatLocalDateInTimeZone(instant, "Pacific/Kiritimati")).toBe(
      "2026-07-30",
    );
  });

  it("throws rather than falling back when Intl omits a date part", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      function MockDateTimeFormat() {
        return {
          formatToParts: () => [
            { type: "month", value: "07" },
            { type: "day", value: "30" },
          ],
        } as unknown as Intl.DateTimeFormat;
      } as typeof Intl.DateTimeFormat,
    );

    expect(() =>
      formatLocalDateInTimeZone(new Date(), "America/Los_Angeles"),
    ).toThrow("Unable to format a calendar date");
  });
});
