import { describe, expect, it } from "vitest";
import { parseReaderResumeState } from "./types";

function webStateWithText(text: {
  quote: string | null;
  quote_prefix: string | null;
  quote_suffix: string | null;
}) {
  return {
    kind: "web",
    target: { fragment_id: "fragment-1" },
    locations: {
      text_offset: 10,
      progression: null,
      total_progression: 0.5,
      position: 1,
    },
    text,
  };
}

describe("parseReaderResumeState", () => {
  it("accepts complete explicit-null resume states", () => {
    const state = {
      kind: "epub",
      target: {
        section_id: "chapter-2",
        href_path: "chapter-2.xhtml",
        anchor_id: null,
      },
      locations: {
        text_offset: 12,
        progression: 0.5,
        total_progression: null,
        position: null,
      },
      text: {
        quote: "Reader fragment 1",
        quote_prefix: null,
        quote_suffix: null,
      },
    };

    expect(parseReaderResumeState(state)).toEqual(state);
  });

  it("rejects missing nullable fields", () => {
    expect(() =>
      parseReaderResumeState({
        kind: "pdf",
        page: 2,
        page_progression: null,
        position: null,
      })
    ).toThrow("Invalid reader state payload");
  });

  it("rejects undefined fields", () => {
    expect(() =>
      parseReaderResumeState({
        kind: "web",
        target: { fragment_id: "fragment-2" },
        locations: {
          text_offset: 84,
          progression: undefined,
          total_progression: 0.7,
          position: 2,
        },
        text: {
          quote: "second fragment quote",
          quote_prefix: null,
          quote_suffix: null,
        },
      })
    ).toThrow("Invalid reader state payload");
  });

  it("accepts quote context at the exact code-point bounds", () => {
    const state = webStateWithText({
      // Astral characters: bounds count code points, not UTF-16 units.
      quote: "\u{1f4d6}".repeat(256),
      quote_prefix: "p".repeat(128),
      quote_suffix: "s".repeat(128),
    });
    expect(parseReaderResumeState(state)).toEqual(state);
  });

  it("rejects oversized quote context instead of truncating", () => {
    expect(() =>
      parseReaderResumeState(
        webStateWithText({
          quote: "\u{1f4d6}".repeat(257),
          quote_prefix: null,
          quote_suffix: null,
        }),
      ),
    ).toThrow("Invalid reader state payload");
    expect(() =>
      parseReaderResumeState(
        webStateWithText({
          quote: "q",
          quote_prefix: "p".repeat(129),
          quote_suffix: null,
        }),
      ),
    ).toThrow("Invalid reader state payload");
    expect(() =>
      parseReaderResumeState(
        webStateWithText({
          quote: "q",
          quote_prefix: null,
          quote_suffix: "s".repeat(129),
        }),
      ),
    ).toThrow("Invalid reader state payload");
  });
});
