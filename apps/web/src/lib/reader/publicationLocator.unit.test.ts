import { expect, it } from "vitest";
import { buildTextReaderLocatorAtOffset } from "./DocumentReaderSession";

it("keeps original fragment and document coordinates when a rendered unit begins in the middle", () => {
  const locator = buildTextReaderLocatorAtOffset({
    anchorOffset: 2, canonicalText: "a😀bc", fragmentId: "fragment", format: "web",
    fragmentStartOffset: 100, fragmentLength: 200,
    documentStartOffset: 400, documentLength: 1000, isFinalUnit: false,
    epubSection: null, epubAnchorId: null, positionBucketCodePoints: 50,
  });
  expect(locator).toMatchObject({
    kind: "web", target: { fragment_id: "fragment" },
    locations: { text_offset: 102, progression: 0.51, total_progression: 0.502, position: 11 },
    text: { quote: "a😀bc" },
  });
});

it("does not mark an intermediate unit end as a fragment or document end", () => {
  expect(buildTextReaderLocatorAtOffset({
    anchorOffset: 4, canonicalText: "a😀bc", fragmentId: "fragment", format: "web",
    fragmentStartOffset: 100, fragmentLength: 200,
    documentStartOffset: 400, documentLength: 1000, isFinalUnit: false,
    epubSection: null, epubAnchorId: null, positionBucketCodePoints: 50,
  })).toMatchObject({ locations: { text_offset: 104, progression: 0.52, total_progression: 0.504 } });
});
