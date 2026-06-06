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
  children: ReaderNavigationTocNode[];
}

export interface ReaderNavigationLocation {
  id: string;
  label: string;
  ordinal: number;
  href: string | null;
  fragment_idx: number | null;
  section_id: string | null;
}

export interface MediaNavigationResponse {
  data: {
    media_id: string;
    kind: "epub" | "web_article";
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

export function parseReaderNavigationHrefAnchorId(
  href: string | null,
): string | null {
  if (!href || !href.includes("#")) {
    return null;
  }
  const fragment = href.split("#", 2)[1];
  if (!fragment) {
    return null;
  }
  try {
    return decodeURIComponent(fragment);
  } catch (error) {
    if (error instanceof URIError) {
      return fragment;
    }
    throw error;
  }
}
