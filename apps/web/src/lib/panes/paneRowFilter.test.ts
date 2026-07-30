import { describe, expect, it } from "vitest";
import { matchesPaneFilterQuery } from "./paneRowFilter";

describe("Pane row filtering", () => {
  it("matches a literal NFC lowercase substring within one field", () => {
    expect(
      matchesPaneFilterQuery("  CAFÉ  ", [
        "An introduction to Cafe\u0301 culture",
      ]),
    ).toBe(true);
    expect(matchesPaneFilterQuery(".", ["Version 1.0"])).toBe(true);
  });

  it("does not join fields, strip accents, or interpret operators", () => {
    expect(matchesPaneFilterQuery("bar baz", ["foo bar", "baz qux"])).toBe(
      false,
    );
    expect(matchesPaneFilterQuery("cafe", ["café"])).toBe(false);
    expect(matchesPaneFilterQuery("a.*b", ["alpha a middle b omega"])).toBe(
      false,
    );
  });

  it("treats an outer-whitespace-only query as no filter", () => {
    expect(matchesPaneFilterQuery(" \n ", [])).toBe(true);
  });
});
