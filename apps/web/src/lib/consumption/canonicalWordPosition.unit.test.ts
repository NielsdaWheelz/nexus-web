import { expect, it } from "vitest";
import { documentWordBoundaryOrdinal } from "./canonicalWordPosition";

it("does not count a word twice when its canonical text crosses a publication cut", () => {
  // Original document is 'alpha beta'; the retained unit begins at the 'p'.
  expect(documentWordBoundaryOrdinal({
    canonicalText: "pha beta", documentWordStart: 1, startsInWord: true, offset: 3,
  })).toBe(1);
  expect(documentWordBoundaryOrdinal({
    canonicalText: "pha beta", documentWordStart: 1, startsInWord: true, offset: 5,
  })).toBe(2);
});
