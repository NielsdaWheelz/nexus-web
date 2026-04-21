import { describe, expect, it } from "vitest";
import {
  isReadableStatus,
  normalizeEpubNavigationToc,
  resolveInitialEpubSectionId,
  type EpubNavigationSection,
  type EpubNavigationTocNode,
} from "./epubReader";

describe("resolveInitialEpubSectionId", () => {
  const sections: EpubNavigationSection[] = [
    {
      section_id: "OPS/nav/intro",
      label: "Introduction",
      fragment_idx: 0,
      href_path: "OPS/text/intro.xhtml",
      anchor_id: null,
      source_node_id: "node-1",
      source: "toc",
      ordinal: 0,
      char_count: 1200,
    },
    {
      section_id: "OPS/nav/chapter-2",
      label: "Chapter 2",
      fragment_idx: 1,
      href_path: "OPS/text/chapter-2.xhtml",
      anchor_id: "anchor-2",
      source_node_id: "node-2",
      source: "toc",
      ordinal: 1,
      char_count: 1800,
    },
  ];

  it("prefers a valid loc query param", () => {
    expect(resolveInitialEpubSectionId(sections, "OPS/nav/chapter-2")).toBe(
      "OPS/nav/chapter-2"
    );
  });

  it("falls back to the first section for invalid or missing loc values", () => {
    expect(resolveInitialEpubSectionId(sections, "missing")).toBe("OPS/nav/intro");
    expect(resolveInitialEpubSectionId(sections, null)).toBe("OPS/nav/intro");
  });

  it("returns null when no sections are available", () => {
    expect(resolveInitialEpubSectionId([], null)).toBeNull();
  });
});

describe("normalizeEpubNavigationToc", () => {
  it("marks TOC nodes navigable only when section_id is valid", () => {
    const sectionIds = new Set(["OPS/nav/intro"]);
    const nodes: EpubNavigationTocNode[] = [
      {
        node_id: "root",
        parent_node_id: null,
        label: "Part I",
        href: null,
        fragment_idx: null,
        depth: 0,
        order_key: "0001",
        section_id: null,
        children: [
          {
            node_id: "node-1",
            parent_node_id: "root",
            label: "Introduction",
            href: "Text/intro.xhtml",
            fragment_idx: 0,
            depth: 1,
            order_key: "0001.0001",
            section_id: "OPS/nav/intro",
            children: [],
          },
          {
            node_id: "node-2",
            parent_node_id: "root",
            label: "Chapter 2",
            href: "Text/chapter-2.xhtml",
            fragment_idx: 1,
            depth: 1,
            order_key: "0001.0002",
            section_id: "OPS/nav/chapter-2",
            children: [],
          },
        ],
      },
    ];

    const out = normalizeEpubNavigationToc(nodes, sectionIds);
    expect(out[0].navigable).toBe(false);
    expect(out[0].children[0].navigable).toBe(true);
    expect(out[0].children[1].navigable).toBe(false);
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
