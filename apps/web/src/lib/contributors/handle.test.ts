import { describe, expect, it } from "vitest";
import {
  assumeContributorHandle,
  CONTRIBUTOR_HANDLE_RE,
  parseContributorHandle,
  RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS,
  tryParseContributorHandle,
} from "./handle";

describe("contributor handle grammar", () => {
  it("accepts lowercase ASCII segments joined by single hyphens", () => {
    for (const value of ["abc", "jane-doe", "a1-b2-c3", "x".repeat(80)]) {
      expect(parseContributorHandle(value)).toBe(value);
      expect(tryParseContributorHandle(value)).toBe(value);
      expect(CONTRIBUTOR_HANDLE_RE.test(value)).toBe(true);
    }
  });

  it("rejects uppercase, underscores, leading/trailing/double hyphens, and empty segments", () => {
    for (const value of [
      "Jane-Doe",
      "jane_doe",
      "-jane",
      "jane-",
      "jane--doe",
      "jane doe",
      "jane.doe",
      "",
    ]) {
      expect(tryParseContributorHandle(value)).toBeNull();
      expect(() => parseContributorHandle(value)).toThrow();
    }
  });

  it("rejects reserved collection segments even though they match the grammar", () => {
    expect(RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS.has("directory")).toBe(true);
    expect(RESERVED_CONTRIBUTOR_HANDLE_SEGMENTS.has("reconciliation-candidates")).toBe(true);
    for (const value of ["directory", "reconciliation-candidates"]) {
      expect(CONTRIBUTOR_HANDLE_RE.test(value)).toBe(true);
      expect(tryParseContributorHandle(value)).toBeNull();
      expect(() => parseContributorHandle(value)).toThrow();
    }
  });

  it("enforces the 3..80 character bounds", () => {
    expect(tryParseContributorHandle("ab")).toBeNull();
    expect(tryParseContributorHandle("abc")).toBe("abc");
    expect(tryParseContributorHandle("x".repeat(80))).toBe("x".repeat(80));
    expect(tryParseContributorHandle("x".repeat(81))).toBeNull();
  });

  it("assumeContributorHandle defects on non-canonical input and passes through canonical input", () => {
    expect(assumeContributorHandle("jane-doe")).toBe("jane-doe");
    expect(() => assumeContributorHandle("Jane Doe")).toThrow();
  });
});
