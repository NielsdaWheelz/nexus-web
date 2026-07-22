import { describe, expect, it } from "vitest";
import {
  assumeReaderSelectionKey,
  parseReaderSelectionKey,
  readerSelectionKeyToWire,
} from "./readerSelectionKey";

const MEDIA = "11111111-1111-1111-1111-111111111111";
const HIGHLIGHT = "22222222-2222-2222-2222-222222222222";

describe("parseReaderSelectionKey", () => {
  it("accepts a canonical (media, highlight) pair", () => {
    expect(parseReaderSelectionKey({ mediaId: MEDIA, highlightId: HIGHLIGHT })).toEqual({
      mediaId: MEDIA,
      highlightId: HIGHLIGHT,
    });
  });

  it("rejects noncanonical values without throwing", () => {
    expect(
      parseReaderSelectionKey({
        mediaId: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA",
        highlightId: HIGHLIGHT,
      }),
    ).toBeNull();
    expect(parseReaderSelectionKey({ mediaId: "not-a-uuid", highlightId: HIGHLIGHT })).toBeNull();
    expect(parseReaderSelectionKey({ mediaId: MEDIA, highlightId: "" })).toBeNull();
    expect(parseReaderSelectionKey({ mediaId: 42, highlightId: HIGHLIGHT })).toBeNull();
    expect(parseReaderSelectionKey({ mediaId: MEDIA, highlightId: null })).toBeNull();
  });
});

describe("assumeReaderSelectionKey", () => {
  it("returns the key for a canonical value", () => {
    expect(assumeReaderSelectionKey({ mediaId: MEDIA, highlightId: HIGHLIGHT })).toEqual({
      mediaId: MEDIA,
      highlightId: HIGHLIGHT,
    });
  });

  it("defects on a noncanonical trusted value", () => {
    expect(() => assumeReaderSelectionKey({ mediaId: "x", highlightId: HIGHLIGHT })).toThrow();
  });
});

describe("readerSelectionKeyToWire", () => {
  it("maps to the snake_case wire shape", () => {
    expect(readerSelectionKeyToWire({ mediaId: MEDIA, highlightId: HIGHLIGHT })).toEqual({
      media_id: MEDIA,
      highlight_id: HIGHLIGHT,
    });
  });
});
