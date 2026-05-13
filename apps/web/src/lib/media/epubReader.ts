/**
 * EPUB reader contracts.
 *
 * EPUB now uses one canonical linear model:
 * persisted sections plus TOC nodes that point at those sections.
 */

export interface EpubSectionContent {
  section_id: string;
  label: string;
  fragment_id: string;
  fragment_idx: number;
  href_path: string | null;
  anchor_id: string | null;
  source_node_id: string | null;
  source: "toc" | "spine";
  ordinal: number;
  prev_section_id: string | null;
  next_section_id: string | null;
  html_sanitized: string;
  canonical_text: string;
  char_count: number;
  word_count: number;
  created_at: string;
}

export interface EpubNavigationSection {
  section_id: string;
  label: string;
  fragment_idx: number;
  href_path: string | null;
  anchor_id: string | null;
  source_node_id: string | null;
  source: "toc" | "spine";
  ordinal: number;
  char_count: number;
}

export interface EpubNavigationTocNode {
  node_id: string;
  parent_node_id: string | null;
  label: string;
  href: string | null;
  fragment_idx: number | null;
  depth: number;
  order_key: string;
  section_id: string | null;
  children: EpubNavigationTocNode[];
}

export interface EpubNavigationLocation {
  label: string;
  href: string | null;
  fragment_idx: number | null;
  section_id: string | null;
}

export interface EpubNavigationResponse {
  data: {
    sections: EpubNavigationSection[];
    toc_nodes: EpubNavigationTocNode[];
    landmarks: EpubNavigationLocation[];
    page_list: EpubNavigationLocation[];
  };
}

export interface NormalizedNavigationTocNode extends EpubNavigationTocNode {
  navigable: boolean;
  children: NormalizedNavigationTocNode[];
}

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

const READABLE_STATUSES = new Set(["ready_for_reading", "embedding", "ready"]);

export function isReadableStatus(status: string): boolean {
  return READABLE_STATUSES.has(status);
}
