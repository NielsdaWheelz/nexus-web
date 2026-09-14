import { expect, it } from "vitest";
import { decodeResolvedHighlightReaderTarget } from "./readerTargetHash";

it("answers an unverifiable PDF source as its own reader target, never as a decode failure", () => {
  expect(decodeResolvedHighlightReaderTarget({ data: { kind: "UnresolvedSource" } })).toEqual({ kind: "UnresolvedSource" });
  // The reader offers reanchoring for it, so it carries no position to mistake
  // for one and no extra field to read as a cause.
  expect(() => decodeResolvedHighlightReaderTarget({ data: { kind: "UnresolvedSource", page_number: 3 } })).toThrow(TypeError);
  expect(() => decodeResolvedHighlightReaderTarget({ data: { kind: "SourceUnverified" } })).toThrow(TypeError);
});
