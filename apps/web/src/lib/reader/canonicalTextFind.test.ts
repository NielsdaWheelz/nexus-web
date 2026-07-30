import { describe, expect, it } from "vitest";
import {
  canonicalTextFind,
  canonicalTextFindSnippet,
} from "@/lib/reader/canonicalTextFind";

function readyOccurrences(
  result: ReturnType<typeof canonicalTextFind>,
) {
  expect(result.kind).toBe("Ready");
  if (result.kind !== "Ready") {
    throw new Error(`expected Ready, received ${result.kind}`);
  }
  return result.occurrences;
}

describe("canonicalTextFind", () => {
  it("exports the canonical codepoint snippet projection", () => {
    const codePoints = Array.from(
      `${"L".repeat(70)}😀needle😀${"R".repeat(70)}`,
    );

    expect(canonicalTextFindSnippet(codePoints, 71, 77)).toEqual([
      { text: `${"L".repeat(63)}😀`, emphasized: false },
      { text: "needle", emphasized: true },
      { text: `😀${"R".repeat(63)}`, emphasized: false },
    ]);
  });

  it("matches escaped NFC literals with ECMAScript Unicode case semantics", () => {
    const literal = canonicalTextFind({
      units: [
        {
          id: "literal",
          text: "before ^$.*+?()[]{}|\\ after",
        },
      ],
      query: "^$.*+?()[]{}|\\",
      matchCase: true,
      wholeWord: false,
      completeness: "Complete",
    });
    const normalized = canonicalTextFind({
      units: [{ id: "normalized", text: "Café" }],
      query: "cafe\u0301",
      matchCase: false,
      wholeWord: false,
      completeness: "Complete",
    });
    const simpleFold = canonicalTextFind({
      units: [{ id: "fold", text: "ſ K ß İ" }],
      query: "s",
      matchCase: false,
      wholeWord: false,
      completeness: "Complete",
    });
    const expandingFold = canonicalTextFind({
      units: [{ id: "fold", text: "ſ K ß İ" }],
      query: "ss",
      matchCase: false,
      wholeWord: false,
      completeness: "Complete",
    });
    const accentFold = canonicalTextFind({
      units: [{ id: "accent", text: "Café" }],
      query: "cafe",
      matchCase: false,
      wholeWord: false,
      completeness: "Complete",
    });
    const unicodeExactCase = canonicalTextFind({
      units: [{ id: "fold", text: "ſ K ß İ" }],
      query: "s",
      matchCase: true,
      wholeWord: false,
      completeness: "Complete",
    });
    const exactCase = canonicalTextFind({
      units: [{ id: "case", text: "Cat cat" }],
      query: "cat",
      matchCase: true,
      wholeWord: false,
      completeness: "Complete",
    });

    expect(
      readyOccurrences(literal).map(({ startCp, endCp }) => [startCp, endCp]),
    ).toEqual([[7, 21]]);
    expect(readyOccurrences(normalized)).toMatchObject([
      { unitId: "normalized", startCp: 0, endCp: 4 },
    ]);
    expect(readyOccurrences(simpleFold)).toMatchObject([
      { unitId: "fold", startCp: 0, endCp: 1 },
    ]);
    expect(expandingFold).toEqual({
      kind: "NoMatches",
      completeness: "Complete",
    });
    expect(accentFold).toEqual({
      kind: "NoMatches",
      completeness: "Complete",
    });
    expect(unicodeExactCase).toEqual({
      kind: "NoMatches",
      completeness: "Complete",
    });
    expect(readyOccurrences(exactCase)).toMatchObject([
      { unitId: "case", startCp: 4, endCp: 7 },
    ]);
  });

  it("uses Intl.Segmenter boundaries for whole-word matching", () => {
    const result = canonicalTextFind({
      units: [{ id: "latin", text: "cat catfish cat. cat_dog" }],
      query: "cat",
      matchCase: false,
      wholeWord: true,
      completeness: "Complete",
    });

    expect(
      readyOccurrences(result).map(({ startCp, endCp }) => [startCp, endCp]),
    ).toEqual([
      [0, 3],
      [12, 15],
    ]);
  });

  it("continues after a rejected whole-word overlap", () => {
    const result = canonicalTextFind({
      units: [{ id: "overlap", text: "xa a a" }],
      query: "a a",
      matchCase: true,
      wholeWord: true,
      completeness: "Complete",
    });

    expect(
      readyOccurrences(result).map(({ startCp, endCp }) => [startCp, endCp]),
    ).toEqual([[3, 6]]);
  });

  it("keeps CJK whole-word behavior on the platform segmenter", () => {
    const result = canonicalTextFind({
      units: [{ id: "cjk", text: "猫と犬" }],
      query: "猫",
      matchCase: true,
      wholeWord: true,
      completeness: "Complete",
    });

    expect(readyOccurrences(result)).toMatchObject([
      { unitId: "cjk", startCp: 0, endCp: 1 },
    ]);
  });

  it("returns non-overlapping matches in logical-unit and source order", () => {
    const ordered = canonicalTextFind({
      units: [
        { id: "first", text: "aaaa" },
        { id: "second", text: "aa" },
      ],
      query: "aa",
      matchCase: true,
      wholeWord: false,
      completeness: "Partial",
    });
    const crossing = canonicalTextFind({
      units: [
        { id: "left", text: "hel" },
        { id: "right", text: "lo" },
      ],
      query: "hello",
      matchCase: true,
      wholeWord: false,
      completeness: "Partial",
    });

    expect(ordered.kind).toBe("Ready");
    if (ordered.kind !== "Ready") {
      throw new Error(`expected Ready, received ${ordered.kind}`);
    }
    expect(ordered.completeness).toBe("Partial");
    expect(
      ordered.occurrences.map(({ unitId, startCp, endCp }) => ({
        unitId,
        startCp,
        endCp,
      })),
    ).toEqual([
      { unitId: "first", startCp: 0, endCp: 2 },
      { unitId: "first", startCp: 2, endCp: 4 },
      { unitId: "second", startCp: 0, endCp: 2 },
    ]);
    expect(crossing).toEqual({
      kind: "NoMatches",
      completeness: "Partial",
    });
  });

  it("reports right-open codepoint locators and faithful bounded snippets", () => {
    const left = "L".repeat(70);
    const right = "R".repeat(70);
    const result = canonicalTextFind({
      units: [{ id: "astral", text: `${left}😀needle😀${right}` }],
      query: "needle",
      matchCase: true,
      wholeWord: false,
      completeness: "Complete",
    });
    const [occurrence] = readyOccurrences(result);

    expect(occurrence).toEqual({
      unitId: "astral",
      startCp: 71,
      endCp: 77,
      snippet: [
        { text: `${"L".repeat(63)}😀`, emphasized: false },
        { text: "needle", emphasized: true },
        { text: `😀${"R".repeat(63)}`, emphasized: false },
      ],
    });
    expect(
      occurrence?.snippet
        .map(({ text }) => text)
        .join(""),
    ).toBe(`${"L".repeat(63)}😀needle😀${"R".repeat(63)}`);
  });

  it("preserves completeness on Ready and NoMatches only", () => {
    const ready = canonicalTextFind({
      units: [{ id: "one", text: "needle" }],
      query: "needle",
      matchCase: true,
      wholeWord: false,
      completeness: "Partial",
    });
    const none = canonicalTextFind({
      units: [{ id: "one", text: "haystack" }],
      query: "needle",
      matchCase: true,
      wholeWord: false,
      completeness: "Partial",
    });

    expect(ready).toMatchObject({ kind: "Ready", completeness: "Partial" });
    expect(none).toEqual({
      kind: "NoMatches",
      completeness: "Partial",
    });
  });

  it("returns no truncated rows after observing match 2,001", () => {
    const atLimit = canonicalTextFind({
      units: [{ id: "limit", text: "x".repeat(2_000) }],
      query: "x",
      matchCase: true,
      wholeWord: false,
      completeness: "Complete",
    });
    const overLimit = canonicalTextFind({
      units: [{ id: "limit", text: "x".repeat(2_001) }],
      query: "x",
      matchCase: true,
      wholeWord: false,
      completeness: "Partial",
    });

    expect(readyOccurrences(atLimit)).toHaveLength(2_000);
    expect(overLimit).toEqual({
      kind: "TooManyMatches",
      threshold: 2_000,
    });
    expect(overLimit).not.toHaveProperty("occurrences");
    expect(overLimit).not.toHaveProperty("completeness");
  });
});
