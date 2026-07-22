import { describe, expect, it } from "vitest";
import {
  decodeOptionalPublicationDate,
  decodePublicationDate,
} from "./publicationDate";

describe("publication-date source contract", () => {
  it.each([
    "1946",
    "1983-11",
    "2026-02-28",
    "2024-02-29",
    "2026-07-20T12:30:45Z",
    "2026-07-20T12:30:45.123+05:30",
  ])("accepts the owned wire grammar: %s", (value) => {
    expect(decodePublicationDate(value, "date")).toBe(value);
  });

  it.each([
    undefined,
    "",
    "0000",
    "2026-00",
    "2026-13",
    "2025-02-29",
    "2026-02-30",
    "March 1843",
    "2026-07-20T24:00:00Z",
    "2026-07-20T12:60:00Z",
    "2026-07-20T12:30:00",
  ])("rejects malformed or unreal wire input: %p", (value) => {
    expect(() => decodePublicationDate(value, "date")).toThrow();
  });

  it("preserves explicit nullable absence", () => {
    expect(decodeOptionalPublicationDate(null, "date")).toEqual({
      kind: "Absent",
    });
  });
});
