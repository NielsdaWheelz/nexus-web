import { describe, expect, it } from "vitest";
import {
  isReadableStatus,
  normalizeEpubNavigationToc,
  type EpubNavigationResponse,
  type EpubNavigationTocNode,
} from "./epubReader";

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

describe("EpubNavigationResponse", () => {
  it("accepts the final navigation payload shape", () => {
    const payload: EpubNavigationResponse = {
      data: {
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
