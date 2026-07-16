import { describe, expect, it } from "vitest";
import {
  buildReaderLocationHref,
  hasCoarseReaderQuery,
  stripCoarseReaderQuery,
} from "./readerLocationHref";

describe("buildReaderLocationHref", () => {
  it("returns the bare stable entry without targets", () => {
    expect(buildReaderLocationHref("media-1")).toBe("/media/media-1");
  });

  it("composes loc, fragment, and highlight fields", () => {
    expect(
      buildReaderLocationHref("media-1", {
        loc: "section-2",
        fragmentId: "frag-9",
        highlightId: "hl-3",
      }),
    ).toBe("/media/media-1?loc=section-2&fragment=frag-9&highlight=hl-3");
  });

  it("omits null and empty target fields", () => {
    expect(
      buildReaderLocationHref("media-1", { loc: null, fragmentId: "frag-9" }),
    ).toBe("/media/media-1?fragment=frag-9");
  });
});

describe("stripCoarseReaderQuery", () => {
  it("removes only loc and fragment", () => {
    expect(
      stripCoarseReaderQuery(
        "/media/m1?loc=section-2&fragment=frag-9&apparatus=ap-1&tab=notes#loc-x",
      ),
    ).toBe("/media/m1?apparatus=ap-1&tab=notes#loc-x");
  });

  it("returns the bare entry when only coarse fields were present", () => {
    expect(stripCoarseReaderQuery("/media/m1?loc=a&fragment=b")).toBe("/media/m1");
  });

  it("leaves hrefs without coarse fields untouched", () => {
    expect(stripCoarseReaderQuery("/media/m1?apparatus=ap-1#frag")).toBe(
      "/media/m1?apparatus=ap-1#frag",
    );
    expect(stripCoarseReaderQuery("/media/m1")).toBe("/media/m1");
  });
});

describe("hasCoarseReaderQuery", () => {
  it("detects loc and fragment", () => {
    expect(hasCoarseReaderQuery("/media/m1?loc=a")).toBe(true);
    expect(hasCoarseReaderQuery("/media/m1?fragment=b")).toBe(true);
    expect(hasCoarseReaderQuery("/media/m1?apparatus=ap")).toBe(false);
    expect(hasCoarseReaderQuery("/media/m1")).toBe(false);
  });
});
