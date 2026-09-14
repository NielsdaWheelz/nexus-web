import { expect, it } from "vitest";
import { canonicalTextFind } from "./canonicalTextFind";
import sharedCases from "../../../../../testdata/pane-find/canonical-text.json";

it("keeps canonical-text Find aligned with the shared corpus", () => {
  for (const testCase of sharedCases.cases) {
    const result = canonicalTextFind({
      units: testCase.units.map((unit) => ({
        id: unit.id,
        text: unit.text.repeat("repeat" in unit ? unit.repeat : 1),
      })),
      query: testCase.query,
      matchCase: testCase.matchCase,
      wholeWord: testCase.wholeWord,
      completeness: "Complete",
    });

    expect(result.kind, testCase.name).toBe(testCase.expected.kind);
    if (result.kind === "Ready") {
      if (!("occurrences" in testCase.expected)) {
        throw new Error(`${testCase.name} requires Ready occurrences.`);
      }
      expect(result.occurrences, testCase.name).toEqual(
        testCase.expected.occurrences,
      );
    } else if (result.kind === "TooManyMatches") {
      if (!("threshold" in testCase.expected)) {
        throw new Error(`${testCase.name} requires a match threshold.`);
      }
      expect(result.threshold, testCase.name).toBe(testCase.expected.threshold);
    }
  }
});
