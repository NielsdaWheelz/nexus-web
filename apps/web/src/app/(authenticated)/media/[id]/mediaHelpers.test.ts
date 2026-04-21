import { describe, expect, it } from "vitest";
import { buildCompactMediaPaneTitle, formatMediaAuthors } from "./mediaHelpers";

describe("media author formatting", () => {
  it("compacts extra author names for dense labels", () => {
    expect(
      formatMediaAuthors(
        [
          { id: "author-1", name: "Ada Lovelace", role: "author" },
          { id: "author-2", name: "Grace Hopper", role: "editor" },
          { id: "author-3", name: "Katherine Johnson", role: null },
        ],
        2
      )
    ).toBe("Ada Lovelace, Grace Hopper +1");
  });

  it("builds a compact pane title from the first author", () => {
    expect(
      buildCompactMediaPaneTitle({
        title: "Computing Notes",
        authors: [
          { id: "author-1", name: "Ada Lovelace", role: "author" },
          { id: "author-2", name: "Grace Hopper", role: "editor" },
        ],
      })
    ).toBe("Computing Notes · Ada Lovelace +1");
  });
});
