import { describe, expect, it } from "vitest";
import {
  buildCompactMediaPaneTitle,
  buildEpubLocationHref,
  formatMediaAuthors,
  resolveEpubInternalLinkTarget,
} from "./mediaHelpers";

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

describe("epub navigation helpers", () => {
  it("builds canonical epub loc hrefs", () => {
    expect(
      buildEpubLocationHref("media-1", "OPS/nav/chapter-1", {
        fragmentId: "frag-1",
        highlightId: "hl-1",
      })
    ).toBe("/media/media-1?loc=OPS%2Fnav%2Fchapter-1&fragment=frag-1&highlight=hl-1");
  });

  it("resolves internal chapter links through section ids", () => {
    expect(
      resolveEpubInternalLinkTarget("../chapter-2.xhtml#anchor-2", "OPS/nav/chapter-1", [
        {
          section_id: "OPS/nav/chapter-1",
          href: "Text/chapter-1.xhtml",
          children: [],
        },
        {
          section_id: "OPS/nav/chapter-2",
          href: "Text/chapter-2.xhtml#anchor-2",
          children: [],
        },
      ])
    ).toEqual({
      sectionId: "OPS/nav/chapter-2",
      anchorId: "anchor-2",
    });
  });

  it("keeps in-section anchor links on the current section", () => {
    expect(
      resolveEpubInternalLinkTarget("#notes", "OPS/nav/chapter-1", [
        {
          section_id: "OPS/nav/chapter-1",
          href: "Text/chapter-1.xhtml",
          children: [],
        },
      ])
    ).toEqual({
      sectionId: "OPS/nav/chapter-1",
      anchorId: "notes",
    });
  });
});
