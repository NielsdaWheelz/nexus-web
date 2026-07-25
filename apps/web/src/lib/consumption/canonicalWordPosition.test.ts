import { describe, expect, it } from "vitest";
import {
  documentWordBoundaryOrdinal,
  wordBoundaryOrdinal,
} from "./canonicalWordPosition";
import corpus from "../../../../../testdata/consumption/canonical_word_policy.json";

describe("wordBoundaryOrdinal", () => {
  it("matches the shared PostgreSQL word-policy corpus", () => {
    for (const entry of corpus) {
      for (const [offset, expected] of entry.boundaries) {
        expect(wordBoundaryOrdinal(entry.text, offset), entry.name).toBe(expected);
      }
      expect(wordBoundaryOrdinal(entry.text, Array.from(entry.text).length), entry.name).toBe(
        entry.wordCount,
      );
    }
  });

  it("adds the server-owned document prefix ordinal", () => {
    expect(
      documentWordBoundaryOrdinal({
        canonicalText: "one two",
        documentWordStart: 12,
        offset: 5,
      }),
    ).toBe(14);
  });
});
