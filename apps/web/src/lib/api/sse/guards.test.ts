import { describe, expect, it } from "vitest";
import { isOptionalString, optionalString } from "./guards";

describe("isOptionalString", () => {
  it("accepts string, null, and undefined; rejects everything else", () => {
    expect(isOptionalString("x")).toBe(true);
    expect(isOptionalString("")).toBe(true);
    expect(isOptionalString(null)).toBe(true);
    expect(isOptionalString(undefined)).toBe(true);
    expect(isOptionalString(0)).toBe(false);
    expect(isOptionalString({})).toBe(false);
  });
});

describe("optionalString", () => {
  it("passes string | null through and keeps absent as undefined", () => {
    expect(optionalString("x")).toBe("x");
    expect(optionalString(null)).toBeNull();
    expect(optionalString(undefined)).toBeUndefined();
  });

  it("collapses invalid shapes to undefined so callers can detect them via key presence", () => {
    expect(optionalString(7)).toBeUndefined();
    expect(optionalString({})).toBeUndefined();
  });
});
