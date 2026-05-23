import { describe, expect, it } from "vitest";
import { parseReaderResumeState } from "./types";

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

  it("rejects removed flat payloads", () => {
    expect(() =>
      parseReaderResumeState({
        source: "fragment-2",
        text_offset: 84,
      })
    ).toThrow("Invalid reader state payload");
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
});
