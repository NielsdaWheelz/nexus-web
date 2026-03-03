import { describe, it, expect, vi } from "vitest";
import {
  fetchAllEpubChapterSummaries,
  resolveInitialEpubChapterIdx,
  normalizeEpubToc,
  normalizeEpubNavigationToc,
  resolveInitialEpubSectionId,
  type EpubNavigationSection,
  type EpubNavigationTocNode,
  type EpubChapterSummary,
  type EpubChapterListResponse,
  type EpubTocNode,
} from "./epubReader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSummary(idx: number, title?: string): EpubChapterSummary {
  return {
    idx,
    fragment_id: `frag-${idx}`,
    title: title ?? `Chapter ${idx + 1}`,
    char_count: 1000 + idx,
    word_count: 200 + idx,
    has_toc_entry: true,
    primary_toc_node_id: `node-${idx}`,
  };
}

function makePage(
  chapters: EpubChapterSummary[],
  nextCursor: number | null,
  hasMore: boolean
): EpubChapterListResponse {
  return { data: chapters, page: { next_cursor: nextCursor, has_more: hasMore } };
}

// ---------------------------------------------------------------------------
// fetchAllEpubChapterSummaries
// ---------------------------------------------------------------------------

describe("fetchAllEpubChapterSummaries", () => {
  it("walks cursor pages until exhausted", async () => {
    const page1 = makePage([makeSummary(0), makeSummary(1)], 1, true);
    const page2 = makePage([makeSummary(2), makeSummary(3)], 3, true);
    const page3 = makePage([makeSummary(4)], null, false);

    const calls: string[] = [];
    const mockFetch = vi.fn(async (path: string) => {
      calls.push(path);
      if (path.includes("cursor=1")) return page2;
      if (path.includes("cursor=3")) return page3;
      return page1;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

    const result = await fetchAllEpubChapterSummaries(mockFetch, "media-1");

    expect(result).toHaveLength(5);
    expect(result.map((c) => c.idx)).toEqual([0, 1, 2, 3, 4]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("/api/media/media-1/chapters");
    expect(calls[1]).toContain("cursor=1");
    expect(calls[2]).toContain("cursor=3");
  });

  it("fails on non-advancing cursor", async () => {
    const stuckPage = makePage([makeSummary(0)], 0, true);

    const mockFetch = vi.fn(async () => stuckPage) as Parameters<
      typeof fetchAllEpubChapterSummaries
    >[0];

    await expect(
      fetchAllEpubChapterSummaries(mockFetch, "media-1")
    ).rejects.toThrow(/cursor did not advance/);
  });
});

// ---------------------------------------------------------------------------
// resolveInitialEpubChapterIdx
// ---------------------------------------------------------------------------

describe("resolveInitialEpubChapterIdx", () => {
  const manifest = [makeSummary(0), makeSummary(1), makeSummary(2)];

  it("prefers valid query param that maps to manifest", () => {
    expect(resolveInitialEpubChapterIdx(manifest, "2")).toBe(2);
    expect(resolveInitialEpubChapterIdx(manifest, "0")).toBe(0);
  });

  it("falls back to first manifest idx for invalid values", () => {
    expect(resolveInitialEpubChapterIdx(manifest, "abc")).toBe(0);
    expect(resolveInitialEpubChapterIdx(manifest, "-1")).toBe(0);
    expect(resolveInitialEpubChapterIdx(manifest, "999")).toBe(0);
    expect(resolveInitialEpubChapterIdx(manifest, "1.5")).toBe(0);
    expect(resolveInitialEpubChapterIdx(manifest, "")).toBe(0);
    expect(resolveInitialEpubChapterIdx(manifest, null)).toBe(0);
    expect(resolveInitialEpubChapterIdx(manifest, undefined)).toBe(0);
  });

  it("returns null for empty manifest", () => {
    expect(resolveInitialEpubChapterIdx([], "0")).toBeNull();
    expect(resolveInitialEpubChapterIdx([], null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeEpubToc
// ---------------------------------------------------------------------------

describe("normalizeEpubToc", () => {
  it("marks only mapped nodes as navigable", () => {
    const chapterIdxSet = new Set([0, 2]);

    const nodes: EpubTocNode[] = [
      {
        node_id: "1",
        parent_node_id: null,
        label: "Part I",
        href: null,
        fragment_idx: null,
        depth: 0,
        order_key: "0001",
        children: [
          {
            node_id: "1.1",
            parent_node_id: "1",
            label: "Chapter 1",
            href: "ch1.xhtml",
            fragment_idx: 0,
            depth: 1,
            order_key: "0001.0001",
            children: [],
          },
          {
            node_id: "1.2",
            parent_node_id: "1",
            label: "Chapter 2",
            href: "ch2.xhtml",
            fragment_idx: 1, // not in set — stale
            depth: 1,
            order_key: "0001.0002",
            children: [],
          },
        ],
      },
      {
        node_id: "2",
        parent_node_id: null,
        label: "Appendix",
        href: "appendix.xhtml",
        fragment_idx: 2,
        depth: 0,
        order_key: "0002",
        children: [],
      },
    ];

    const result = normalizeEpubToc(nodes, chapterIdxSet);

    // Structural node — not navigable (fragment_idx null)
    expect(result[0].navigable).toBe(false);
    expect(result[0].label).toBe("Part I");

    // Mapped child — navigable
    expect(result[0].children[0].navigable).toBe(true);
    expect(result[0].children[0].label).toBe("Chapter 1");

    // Stale child — not navigable (fragment_idx=1 not in set)
    expect(result[0].children[1].navigable).toBe(false);
    expect(result[0].children[1].label).toBe("Chapter 2");

    // Mapped root — navigable
    expect(result[1].navigable).toBe(true);
    expect(result[1].label).toBe("Appendix");

    // Preserves tree shape
    expect(result).toHaveLength(2);
    expect(result[0].children).toHaveLength(2);
  });
});

describe("resolveInitialEpubSectionId", () => {
  const sections: EpubNavigationSection[] = [
    {
      section_id: "sec-a",
      label: "Chapter 1",
      fragment_idx: 0,
      anchor_id: null,
      source_node_id: "ch0",
      source: "toc",
      ordinal: 0,
    },
    {
      section_id: "sec-b",
      label: "Chapter 2",
      fragment_idx: 1,
      anchor_id: "part-2",
      source_node_id: "ch1",
      source: "toc",
      ordinal: 1,
    },
  ];

  it("prefers valid loc query param", () => {
    expect(resolveInitialEpubSectionId(sections, "sec-b", null)).toBe("sec-b");
  });

  it("falls back to chapter query mapping when loc is missing", () => {
    expect(resolveInitialEpubSectionId(sections, null, "1")).toBe("sec-b");
  });

  it("falls back to first section for invalid loc/chapter values", () => {
    expect(resolveInitialEpubSectionId(sections, "missing", "999")).toBe("sec-a");
    expect(resolveInitialEpubSectionId(sections, null, "oops")).toBe("sec-a");
  });

  it("returns null for empty sections", () => {
    expect(resolveInitialEpubSectionId([], null, null)).toBeNull();
  });
});

describe("normalizeEpubNavigationToc", () => {
  it("marks TOC nodes navigable only when section_id is valid", () => {
    const sectionIds = new Set(["sec-a"]);
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
            node_id: "ch1",
            parent_node_id: "root",
            label: "Chapter 1",
            href: "ch1.xhtml",
            fragment_idx: 0,
            depth: 1,
            order_key: "0001.0001",
            section_id: "sec-a",
            children: [],
          },
          {
            node_id: "ch2",
            parent_node_id: "root",
            label: "Chapter 2",
            href: "ch2.xhtml",
            fragment_idx: 1,
            depth: 1,
            order_key: "0001.0002",
            section_id: "sec-b",
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
