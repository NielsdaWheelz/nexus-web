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

// Normalized TOC node with navigability flag
export interface NormalizedTocNode extends EpubTocNode {
  navigable: boolean;
  children: NormalizedTocNode[];
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
