import { describe, expect, it } from "vitest";
import {
  resolveEpubInternalLinkTarget,
  resolveSectionAnchorId,
  type NavigationTocNodeLike,
} from "./epubHelpers";
import type { ReaderNavigationSection } from "@/lib/media/readerNavigation";

const sections: ReaderNavigationSection[] = [
  {
    section_id: "chapter-1.xhtml",
    label: "Chapter 1",
    ordinal: 0,
    fragment_id: "fragment-1",
    fragment_idx: 0,
    level: null,
    depth: null,
    start_offset: 0,
    end_offset: 100,
    href_path: "Text/chapter-1.xhtml",
    href_fragment: null,
    anchor_id: null,
    char_count: 100,
  },
  {
    section_id: "chapter-2.xhtml",
    label: "Chapter 2",
    ordinal: 1,
    fragment_id: "fragment-2",
    fragment_idx: 1,
    level: null,
    depth: null,
    start_offset: 100,
    end_offset: 200,
    href_path: "Text/chapter-2.xhtml",
    href_fragment: null,
    anchor_id: null,
    char_count: 100,
  },
];

describe("resolveEpubInternalLinkTarget", () => {
  it("keeps same-section hash links in the active section", () => {
    expect(
      resolveEpubInternalLinkTarget("#deep-anchor", "chapter-1.xhtml", sections),
    ).toEqual({ sectionId: "chapter-1.xhtml", anchorId: "deep-anchor" });
  });

  it("resolves relative section links through EPUB href paths", () => {
    expect(
      resolveEpubInternalLinkTarget(
        "chapter-2.xhtml#target",
        "chapter-1.xhtml",
        sections,
      ),
    ).toEqual({ sectionId: "chapter-2.xhtml", anchorId: "target" });
  });

  it("resolves nested relative paths from the active section href path", () => {
    expect(
      resolveEpubInternalLinkTarget(
        "../Text/chapter-2.xhtml#target",
        "chapter-1.xhtml",
        sections,
      ),
    ).toEqual({ sectionId: "chapter-2.xhtml", anchorId: "target" });
  });

  it("rejects external links and unresolved EPUB paths", () => {
    expect(
      resolveEpubInternalLinkTarget(
        "https://example.com/chapter-2.xhtml",
        "chapter-1.xhtml",
        sections,
      ),
    ).toBeNull();
    expect(
      resolveEpubInternalLinkTarget(
        "missing.xhtml#target",
        "chapter-1.xhtml",
        sections,
      ),
    ).toBeNull();
  });
});

describe("resolveSectionAnchorId", () => {
  it("uses section anchors before TOC href anchors", () => {
    expect(resolveSectionAnchorId("section-1", "explicit", [])).toBe("explicit");
  });

  it("finds the matching TOC href anchor", () => {
    const toc: NavigationTocNodeLike[] = [
      {
        section_id: "section-1",
        href: "Text/chapter-1.xhtml#toc-anchor",
        children: [],
      },
    ];

    expect(resolveSectionAnchorId("section-1", null, toc)).toBe("toc-anchor");
  });
});
