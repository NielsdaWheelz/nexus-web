import { describe, expect, it } from "vitest";
import { buildQuoteSelector } from "./quoteText";

describe("buildQuoteSelector", () => {
  it("omits empty and nullish prefix/suffix", () => {
    expect(buildQuoteSelector({ exact: "hi" })).toEqual({ exact: "hi" });
    expect(
      buildQuoteSelector({ exact: "hi", prefix: "", suffix: null }),
    ).toEqual({ exact: "hi" });
    expect(
      buildQuoteSelector({ exact: "hi", prefix: "a", suffix: "b" }),
    ).toEqual({ exact: "hi", prefix: "a", suffix: "b" });
  });
});
