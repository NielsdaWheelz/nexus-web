import { describe, expect, it } from "vitest";
import { buildCompactMediaPaneTitle } from "./mediaFormatting";

describe("buildCompactMediaPaneTitle", () => {
  it("returns null for null input", () => {
    expect(buildCompactMediaPaneTitle(null)).toBeNull();
  });

  it("returns null for media with an empty title", () => {
    expect(buildCompactMediaPaneTitle({ title: "", contributors: [] })).toBeNull();
  });

  it("returns null for media with a whitespace-only title", () => {
    expect(buildCompactMediaPaneTitle({ title: "   ", contributors: [] })).toBeNull();
  });

  it("returns the title when there are no contributors", () => {
    const result = buildCompactMediaPaneTitle({ title: "Dune", contributors: [] });
    expect(result).toBe("Dune");
  });

  it("returns the compact title·author form when a contributor is present", () => {
    const contributor = {
      contributor_handle: "frank-herbert",
      credited_name: "Frank Herbert",
      role: "author",
    };
    const result = buildCompactMediaPaneTitle({ title: "Dune", contributors: [contributor] });
    expect(result).toBe("Dune · Frank Herbert");
  });
});
