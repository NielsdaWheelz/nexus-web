/**
 * EPUB reader orchestration module.
 *
 * Typed client contracts for chapter manifest traversal, selected chapter
 * resolution, and TOC normalization aligned to PR-04 response surfaces.
 */

import type { apiFetch as ApiFetchFn } from "@/lib/api/client";

// ---------------------------------------------------------------------------
// Types aligned to PR-04 backend response shapes
// ---------------------------------------------------------------------------

export interface EpubChapterSummary {
  idx: number;
  fragment_id: string;
  title: string;
  char_count: number;
  word_count: number;
  has_toc_entry: boolean;
  primary_toc_node_id: string | null;
}

export interface EpubChapter extends EpubChapterSummary {
  html_sanitized: string;
  canonical_text: string;
  prev_idx: number | null;
  next_idx: number | null;
  created_at: string;
}

export interface EpubTocNode {
  node_id: string;
  parent_node_id: string | null;
  label: string;
  href: string | null;
  fragment_idx: number | null;
  depth: number;
  order_key: string;
  children: EpubTocNode[];
}

export interface EpubChapterListResponse {
  data: EpubChapterSummary[];
  page: {
    next_cursor: number | null;
    has_more: boolean;
  };
}

export interface EpubTocResponse {
  data: {
    nodes: EpubTocNode[];
  };
}

export interface EpubNavigationSection {
  section_id: string;
  label: string;
  fragment_idx: number;
  anchor_id: string | null;
  source_node_id: string | null;
  source: "toc" | "fragment_fallback";
  ordinal: number;
}

export interface EpubNavigationTocNode extends EpubTocNode {
  section_id: string | null;
  children: EpubNavigationTocNode[];
}

export interface EpubNavigationResponse {
  data: {
    sections: EpubNavigationSection[];
    toc_nodes: EpubNavigationTocNode[];
  };
}

// Normalized TOC node with navigability flag
export interface NormalizedTocNode extends EpubTocNode {
  navigable: boolean;
  children: NormalizedTocNode[];
}

export interface NormalizedNavigationTocNode extends EpubNavigationTocNode {
  navigable: boolean;
  children: NormalizedNavigationTocNode[];
}

// ---------------------------------------------------------------------------
// fetchAllEpubChapterSummaries
// ---------------------------------------------------------------------------

type ApiFetchType = typeof ApiFetchFn;

const CHAPTER_PAGE_LIMIT = 200;

/**
 * Walk cursor-paginated `/chapters` endpoint until exhausted.
 * Fails deterministically if cursor does not advance monotonically.
 */
export async function fetchAllEpubChapterSummaries(
  apiFetchFn: ApiFetchType,
  mediaId: string
): Promise<EpubChapterSummary[]> {
  const allChapters: EpubChapterSummary[] = [];
  let cursor: number | null = null;
  let prevCursor: number | null = null;

  for (;;) {
    const params = new URLSearchParams({ limit: String(CHAPTER_PAGE_LIMIT) });
    if (cursor !== null) {
      params.set("cursor", String(cursor));
    }

    const resp = await apiFetchFn<EpubChapterListResponse>(
      `/api/media/${mediaId}/chapters?${params}`
    );

    allChapters.push(...resp.data);

    if (!resp.page.has_more) {
      break;
    }

    const nextCursor = resp.page.next_cursor;
    if (nextCursor === null || (prevCursor !== null && nextCursor <= prevCursor)) {
      throw new Error(
        `EPUB chapter pagination error: cursor did not advance ` +
          `(prev=${prevCursor}, next=${nextCursor})`
      );
    }

    prevCursor = cursor;
    cursor = nextCursor;
  }

  return allChapters;
}

// ---------------------------------------------------------------------------
// resolveInitialEpubChapterIdx
// ---------------------------------------------------------------------------

/**
 * Resolve the initial active chapter idx from URL query param and manifest.
 *
 * - Valid in-manifest chapter param -> that idx.
 * - Invalid/missing/non-numeric/out-of-manifest -> first manifest idx.
 * - Empty manifest -> null (reader empty state).
 */
export function resolveInitialEpubChapterIdx(
  chapters: EpubChapterSummary[],
  requestedChapterParam: string | null | undefined
): number | null {
  if (chapters.length === 0) {
    return null;
  }

  if (requestedChapterParam != null && requestedChapterParam !== "") {
    const parsed = Number(requestedChapterParam);
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0) {
      const exists = chapters.some((c) => c.idx === parsed);
      if (exists) {
        return parsed;
      }
    }
  }

  return chapters[0].idx;
}

// ---------------------------------------------------------------------------
// normalizeEpubToc
// ---------------------------------------------------------------------------

/**
 * Normalize TOC nodes with navigability based on chapter manifest idx set.
 *
 * A node is navigable only when its `fragment_idx` maps to an existing
 * chapter in the manifest. Structural/unmapped nodes remain renderable
 * but non-clickable.
 */
export function normalizeEpubToc(
  nodes: EpubTocNode[],
  chapterIdxSet: Set<number>
): NormalizedTocNode[] {
  return nodes.map((node) => ({
    ...node,
    navigable: node.fragment_idx !== null && chapterIdxSet.has(node.fragment_idx),
    children: normalizeEpubToc(node.children, chapterIdxSet),
  }));
}

/**
 * Resolve canonical section id for EPUB navigation from URL params.
 *
 * Priority:
 * 1) valid `loc` query param (section id)
 * 2) valid `chapter` query param mapped to first matching section
 * 3) first section in ordered navigation list
 * 4) null when no sections
 */
export function resolveInitialEpubSectionId(
  sections: EpubNavigationSection[],
  requestedLocParam: string | null | undefined,
  requestedChapterParam: string | null | undefined
): string | null {
  if (sections.length === 0) {
    return null;
  }

  if (requestedLocParam && sections.some((s) => s.section_id === requestedLocParam)) {
    return requestedLocParam;
  }

  if (requestedChapterParam != null && requestedChapterParam !== "") {
    const parsed = Number(requestedChapterParam);
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed >= 0) {
      const byChapter = sections.find((s) => s.fragment_idx === parsed);
      if (byChapter) {
        return byChapter.section_id;
      }
    }
  }

  return sections[0].section_id;
}

/**
 * Normalize navigation TOC nodes with section-level navigability.
 *
 * A node is navigable only when it carries a valid section_id present in the
 * current navigation payload.
 */
export function normalizeEpubNavigationToc(
  nodes: EpubNavigationTocNode[],
  sectionIdSet: Set<string>
): NormalizedNavigationTocNode[] {
  return nodes.map((node) => ({
    ...node,
    navigable: node.section_id !== null && sectionIdSet.has(node.section_id),
    children: normalizeEpubNavigationToc(node.children, sectionIdSet),
  }));
}

// ---------------------------------------------------------------------------
// Readable status set (centralized)
// ---------------------------------------------------------------------------

const READABLE_STATUSES = new Set([
  "ready_for_reading",
  "embedding",
  "ready",
]);

export function isReadableStatus(status: string): boolean {
  return READABLE_STATUSES.has(status);
}
