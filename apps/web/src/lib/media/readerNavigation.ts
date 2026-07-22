import {
  expectArray,
  expectExactRecord,
  expectInteger,
  expectNullableInteger,
  expectNullableString,
  expectOneOf,
  expectString,
} from "@/lib/validation";

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

export type MediaNavigation = MediaNavigationResponse["data"];

export function decodeMediaNavigation(
  raw: unknown,
  name = "MediaNavigation",
): MediaNavigation {
  const value = expectExactRecord(
    raw,
    ["media_id", "kind", "sections", "toc_nodes", "landmarks", "page_list"],
    name,
  );
  return {
    media_id: expectString(value.media_id, `${name}.media_id`),
    kind: expectOneOf(
      value.kind,
      ["epub", "web_article"] as const,
      `${name}.kind`,
    ),
    sections: expectArray(
      value.sections,
      (section, index) =>
        decodeNavigationSection(section, `${name}.sections[${index}]`),
      `${name}.sections`,
    ),
    toc_nodes: expectArray(
      value.toc_nodes,
      (node, index) => decodeTocNode(node, `${name}.toc_nodes[${index}]`),
      `${name}.toc_nodes`,
    ),
    landmarks: expectArray(
      value.landmarks,
      (location, index) =>
        decodeNavigationLocation(location, `${name}.landmarks[${index}]`),
      `${name}.landmarks`,
    ),
    page_list: expectArray(
      value.page_list,
      (location, index) =>
        decodeNavigationLocation(location, `${name}.page_list[${index}]`),
      `${name}.page_list`,
    ),
  };
}

export function decodeMediaNavigationResponse(
  raw: unknown,
): MediaNavigationResponse {
  const value = expectExactRecord(raw, ["data"], "MediaNavigationResponse");
  return {
    data: decodeMediaNavigation(value.data, "MediaNavigationResponse.data"),
  };
}

function decodeNavigationSection(
  raw: unknown,
  name: string,
): ReaderNavigationSection {
  const value = expectExactRecord(
    raw,
    [
      "section_id",
      "label",
      "ordinal",
      "fragment_id",
      "fragment_idx",
      "level",
      "depth",
      "start_offset",
      "end_offset",
      "href_path",
      "href_fragment",
      "anchor_id",
      "char_count",
    ],
    name,
  );
  return {
    section_id: expectString(value.section_id, `${name}.section_id`),
    label: expectString(value.label, `${name}.label`),
    ordinal: expectInteger(value.ordinal, `${name}.ordinal`),
    fragment_id: expectNullableString(value.fragment_id, `${name}.fragment_id`),
    fragment_idx: expectNullableInteger(
      value.fragment_idx,
      `${name}.fragment_idx`,
    ),
    level: expectNullableInteger(value.level, `${name}.level`),
    depth: expectNullableInteger(value.depth, `${name}.depth`),
    start_offset: expectNullableInteger(
      value.start_offset,
      `${name}.start_offset`,
    ),
    end_offset: expectNullableInteger(value.end_offset, `${name}.end_offset`),
    href_path: expectNullableString(value.href_path, `${name}.href_path`),
    href_fragment: expectNullableString(
      value.href_fragment,
      `${name}.href_fragment`,
    ),
    anchor_id: expectNullableString(value.anchor_id, `${name}.anchor_id`),
    char_count: expectNullableInteger(value.char_count, `${name}.char_count`),
  };
}

function decodeTocNode(raw: unknown, name: string): ReaderNavigationTocNode {
  const value = expectExactRecord(
    raw,
    [
      "id",
      "label",
      "ordinal",
      "href",
      "fragment_idx",
      "level",
      "depth",
      "section_id",
      "children",
    ],
    name,
  );
  return {
    id: expectString(value.id, `${name}.id`),
    label: expectString(value.label, `${name}.label`),
    ordinal: expectInteger(value.ordinal, `${name}.ordinal`),
    href: expectNullableString(value.href, `${name}.href`),
    fragment_idx: expectNullableInteger(
      value.fragment_idx,
      `${name}.fragment_idx`,
    ),
    level: expectNullableInteger(value.level, `${name}.level`),
    depth: expectNullableInteger(value.depth, `${name}.depth`),
    section_id: expectNullableString(value.section_id, `${name}.section_id`),
    children: expectArray(
      value.children,
      (child, index) => decodeTocNode(child, `${name}.children[${index}]`),
      `${name}.children`,
    ),
  };
}

function decodeNavigationLocation(
  raw: unknown,
  name: string,
): ReaderNavigationLocation {
  const value = expectExactRecord(
    raw,
    ["id", "label", "ordinal", "href", "fragment_idx", "section_id"],
    name,
  );
  return {
    id: expectString(value.id, `${name}.id`),
    label: expectString(value.label, `${name}.label`),
    ordinal: expectInteger(value.ordinal, `${name}.ordinal`),
    href: expectNullableString(value.href, `${name}.href`),
    fragment_idx: expectNullableInteger(
      value.fragment_idx,
      `${name}.fragment_idx`,
    ),
    section_id: expectNullableString(value.section_id, `${name}.section_id`),
  };
}

export interface NormalizedNavigationTocNode extends ReaderNavigationTocNode {
  navigable: boolean;
  children: NormalizedNavigationTocNode[];
}

export function normalizeReaderNavigationToc(
  nodes: ReaderNavigationTocNode[],
  sectionIdSet: Set<string>,
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
