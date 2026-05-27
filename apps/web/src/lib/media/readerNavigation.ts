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
  source_version?: string | null;
  created_at: string;
}

export interface ReaderNavigationSection {
  section_id: string;
  label: string;
  ordinal: number;
  fragment_id: string | null;
  fragment_idx: number | null;
  level: number | null;
  depth: number | null;
  start_offset: number | null;
  end_offset: number | null;
  href_path: string | null;
  href_fragment: string | null;
  anchor_id: string | null;
  char_count: number | null;
  source_version?: string | null;
}

export interface ReaderNavigationTocNode {
  id: string;
  label: string;
  ordinal: number;
  href: string | null;
  fragment_idx: number | null;
  level: number | null;
  depth: number | null;
  section_id: string | null;
  source_version?: string | null;
  children: ReaderNavigationTocNode[];
}

export interface ReaderNavigationLocation {
  id: string;
  label: string;
  ordinal: number;
  href: string | null;
  fragment_idx: number | null;
  section_id: string | null;
  source_version?: string | null;
}

export interface MediaNavigationResponse {
  data: {
    media_id: string;
    kind: "epub" | "web_article";
    source_version?: string | null;
    sections: ReaderNavigationSection[];
    toc_nodes: ReaderNavigationTocNode[];
    landmarks: ReaderNavigationLocation[];
    page_list: ReaderNavigationLocation[];
  };
}

export interface NormalizedNavigationTocNode extends ReaderNavigationTocNode {
  navigable: boolean;
  children: NormalizedNavigationTocNode[];
}

export function normalizeReaderNavigationToc(
  nodes: ReaderNavigationTocNode[],
  sectionIdSet: Set<string>
): NormalizedNavigationTocNode[] {
  return nodes.map((node) => ({
    ...node,
    navigable: node.section_id !== null && sectionIdSet.has(node.section_id),
    children: normalizeReaderNavigationToc(node.children, sectionIdSet),
  }));
}

const READABLE_STATUSES = new Set(["ready_for_reading", "embedding", "ready"]);

export function isReadableStatus(status: string): boolean {
  return READABLE_STATUSES.has(status);
}
