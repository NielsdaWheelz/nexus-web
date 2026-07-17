import { describe, expect, it } from "vitest";
import {
  buildReaderLocationHref,
  hasCoarseReaderQuery,
  stripCoarseReaderQuery,
} from "./readerLocationHref";

describe("buildReaderLocationHref", () => {
  it("builds a loc-only href", () => {
    expect(buildReaderLocationHref("media-1", { loc: "section-2" })).toBe(
      "/media/media-1?loc=section-2",
    );
  });

  it("builds a fragment-only href", () => {
    expect(buildReaderLocationHref("media-1", { fragmentId: "frag-9" })).toBe(
      "/media/media-1?fragment=frag-9",
    );
  });

  it("composes loc and fragment fields", () => {
    expect(
      buildReaderLocationHref("media-1", {
        loc: "section-2",
        fragmentId: "frag-9",
      }),
    ).toBe("/media/media-1?loc=section-2&fragment=frag-9");
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
