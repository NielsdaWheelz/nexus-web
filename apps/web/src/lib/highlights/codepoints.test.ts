import { describe, expect, it } from "vitest";

import {
  codepointLength,
  codepointToUtf16,
  utf16ToCodepoint,
} from "./codepoints";

describe("codepointLength", () => {
  it("returns 0 for empty string", () => {
    expect(codepointLength("")).toBe(0);
  });

  it("counts ASCII codepoints", () => {
    expect(codepointLength("Hello")).toBe(5);
  });

  it("counts an astral character as one codepoint", () => {
    expect(codepointLength("🎉")).toBe(1);
  });

  it("counts a mix of ASCII and astral codepoints", () => {
    expect(codepointLength("A🎉B")).toBe(3);
  });

  it("counts skin-tone-modified emoji codepoint-by-codepoint", () => {
    // 👍🏽 is "thumbs up" + skin-tone modifier — two codepoints either way.
    const thumbsUp = "👍🏽";
    expect(codepointLength(thumbsUp)).toBe([...thumbsUp].length);
  });
});

describe("utf16ToCodepoint", () => {
  it("is the identity on ASCII", () => {
    expect(utf16ToCodepoint("hello", 0)).toBe(0);
    expect(utf16ToCodepoint("hello", 3)).toBe(3);
    expect(utf16ToCodepoint("hello", 5)).toBe(5);
  });

  it("collapses an astral character's surrogate pair to one codepoint", () => {
    // "🎉" = 1 codepoint, 2 UTF-16 units.
    const text = "Hello 🎉 World";
    expect(utf16ToCodepoint(text, 0)).toBe(0);
    expect(utf16ToCodepoint(text, 6)).toBe(6);
    expect(utf16ToCodepoint(text, 8)).toBe(7);
    expect(utf16ToCodepoint(text, 9)).toBe(8);
  });

  it("handles a run of astral characters", () => {
    const text = "🎉🎊🎈";
    expect(utf16ToCodepoint(text, 0)).toBe(0);
    expect(utf16ToCodepoint(text, 2)).toBe(1);
    expect(utf16ToCodepoint(text, 4)).toBe(2);
    expect(utf16ToCodepoint(text, 6)).toBe(3);
  });

  it("returns the codepoint count for the full length of a ZWJ sequence", () => {
    const text = "👨‍👩‍👧";
    expect(utf16ToCodepoint(text, 0)).toBe(0);
    expect(utf16ToCodepoint(text, text.length)).toBe([...text].length);
  });
});

describe("codepointToUtf16", () => {
  it("is the identity on ASCII", () => {
    expect(codepointToUtf16("hello", 0)).toBe(0);
    expect(codepointToUtf16("hello", 3)).toBe(3);
    expect(codepointToUtf16("hello", 5)).toBe(5);
  });

  it("expands one codepoint into two UTF-16 units across an astral character", () => {
    const text = "Hello 🎉 World";
    expect(codepointToUtf16(text, 0)).toBe(0);
    expect(codepointToUtf16(text, 6)).toBe(6);
    expect(codepointToUtf16(text, 7)).toBe(8);
    expect(codepointToUtf16(text, 8)).toBe(9);
  });
});
