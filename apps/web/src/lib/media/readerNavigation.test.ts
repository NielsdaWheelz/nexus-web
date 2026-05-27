import { describe, expect, it } from "vitest";
import {
  isReadableStatus,
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
    expect(parseReaderNavigationHrefAnchorId("Text/intro.xhtml#deep-anchor")).toBe(
      "deep-anchor",
    );
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
        source_version: "web_article:fragments:abc",
        sections: [],
        toc_nodes: [],
        landmarks: [],
        page_list: [],
      },
    };

    expect(payload.data.landmarks).toEqual([]);
    expect(payload.data.page_list).toEqual([]);
  });
});

describe("isReadableStatus", () => {
  it("accepts reader-ready statuses", () => {
    expect(isReadableStatus("ready_for_reading")).toBe(true);
    expect(isReadableStatus("embedding")).toBe(true);
    expect(isReadableStatus("ready")).toBe(true);
  });

  it("rejects non-reader statuses", () => {
    expect(isReadableStatus("pending")).toBe(false);
    expect(isReadableStatus("failed")).toBe(false);
  });
});
