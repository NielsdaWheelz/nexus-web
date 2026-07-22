import { describe, expect, it } from "vitest";
import {
  decodeMediaNavigation,
  decodeMediaNavigationResponse,
  normalizeReaderNavigationToc,
  parseReaderNavigationHrefAnchorId,
  type MediaNavigationResponse,
  type ReaderNavigationTocNode,
} from "./readerNavigation";

describe("normalizeReaderNavigationToc", () => {
  it("marks TOC nodes navigable only when section_id is valid", () => {
    const sectionIds = new Set(["OPS/nav/intro"]);
    const nodes: ReaderNavigationTocNode[] = [
      {
        id: "root",
        label: "Part I",
        ordinal: 0,
        href: null,
        fragment_idx: null,
        level: null,
        depth: 0,
        section_id: null,
        children: [
          {
            id: "node-1",
            label: "Introduction",
            ordinal: 1,
            href: "Text/intro.xhtml",
            fragment_idx: 0,
            level: null,
            depth: 1,
            section_id: "OPS/nav/intro",
            children: [],
          },
          {
            id: "node-2",
            label: "Chapter 2",
            ordinal: 2,
            href: "Text/chapter-2.xhtml",
            fragment_idx: 1,
            level: null,
            depth: 1,
            section_id: "OPS/nav/chapter-2",
            children: [],
          },
        ],
      },
    ];

    const out = normalizeReaderNavigationToc(nodes, sectionIds);
    expect(out[0].navigable).toBe(false);
    expect(out[0].children[0].navigable).toBe(true);
    expect(out[0].children[1].navigable).toBe(false);
  });
});

describe("parseReaderNavigationHrefAnchorId", () => {
  it("extracts decoded anchors from reader navigation hrefs", () => {
    expect(
      parseReaderNavigationHrefAnchorId("Text/intro.xhtml#deep-anchor"),
    ).toBe("deep-anchor");
    expect(parseReaderNavigationHrefAnchorId("#space%20anchor")).toBe(
      "space anchor",
    );
  });

  it("returns null for hrefs without usable anchors", () => {
    expect(parseReaderNavigationHrefAnchorId("Text/intro.xhtml")).toBeNull();
    expect(parseReaderNavigationHrefAnchorId("#")).toBeNull();
    expect(parseReaderNavigationHrefAnchorId(null)).toBeNull();
  });

  it("keeps malformed URI anchors readable", () => {
    expect(parseReaderNavigationHrefAnchorId("Text/intro.xhtml#bad%ZZ")).toBe(
      "bad%ZZ",
    );
  });
});

describe("MediaNavigationResponse", () => {
  it("accepts the final navigation payload shape", () => {
    const payload: MediaNavigationResponse = {
      data: {
        media_id: "media-1",
        kind: "web_article",
        sections: [],
        toc_nodes: [],
        landmarks: [],
        page_list: [],
      },
    };

    expect(payload.data.landmarks).toEqual([]);
    expect(payload.data.page_list).toEqual([]);
  });

  it("strictly decodes the complete navigation owner DTO", () => {
    const data = {
      media_id: "media-1",
      kind: "web_article",
      sections: [
        {
          section_id: "introduction",
          label: "Introduction",
          ordinal: 0,
          fragment_id: "fragment-1",
          fragment_idx: 0,
          level: 1,
          depth: 0,
          start_offset: 0,
          end_offset: 120,
          href_path: null,
          href_fragment: null,
          anchor_id: "introduction",
          char_count: 120,
        },
      ],
      toc_nodes: [
        {
          id: "toc-1",
          label: "Introduction",
          ordinal: 0,
          href: "#introduction",
          fragment_idx: 0,
          level: 1,
          depth: 0,
          section_id: "introduction",
          children: [],
        },
      ],
      landmarks: [
        {
          id: "landmark-1",
          label: "Start",
          ordinal: 0,
          href: "#introduction",
          fragment_idx: 0,
          section_id: "introduction",
        },
      ],
      page_list: [],
    };

    expect(decodeMediaNavigation(data)).toEqual(data);
    expect(decodeMediaNavigationResponse({ data })).toEqual({ data });
  });

  it("rejects extra and malformed nested navigation fields", () => {
    const empty = {
      media_id: "media-1",
      kind: "epub",
      sections: [],
      toc_nodes: [],
      landmarks: [],
      page_list: [],
    };
    expect(() => decodeMediaNavigation({ ...empty, legacy_toc: [] })).toThrow(
      /must contain exactly/,
    );
    expect(() =>
      decodeMediaNavigation({
        ...empty,
        toc_nodes: [
          {
            id: "toc-1",
            label: "Introduction",
            ordinal: 0,
            href: null,
            fragment_idx: null,
            level: null,
            depth: null,
            section_id: null,
            children: [],
            legacy_target: null,
          },
        ],
      }),
    ).toThrow(/toc_nodes\[0\] must contain exactly/);
    expect(() =>
      decodeMediaNavigationResponse({ data: empty, meta: {} }),
    ).toThrow(/MediaNavigationResponse must contain exactly/);
  });
});
