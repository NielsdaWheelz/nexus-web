import {
  expectArray,
  expectExactRecord,
  expectInteger,
  expectNonnegativeInteger,
  expectNullableInteger,
  expectNullableString,
  expectOneOf,
  expectString,
} from "@/lib/validation";

export interface ReaderNavigationFragment {
  fragment_id: string;
  fragment_idx: number;
  char_count: number;
}

export interface ReaderNavigationSection {
  section_id: string;
  label: string;
  ordinal: number;
  fragment_id: string;
  fragment_idx: number;
  level: number | null;
  depth: number | null;
  start_offset: number;
  end_offset: number | null;
  href_path: string | null;
  href_fragment: string | null;
  anchor_id: string | null;
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
    fragments: ReaderNavigationFragment[];
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
    [
      "media_id",
      "kind",
      "fragments",
      "sections",
      "toc_nodes",
      "landmarks",
      "page_list",
    ],
    name,
  );
  const navigation: MediaNavigation = {
    media_id: expectString(value.media_id, `${name}.media_id`),
    kind: expectOneOf(
      value.kind,
      ["epub", "web_article"] as const,
      `${name}.kind`,
    ),
    fragments: expectArray(
      value.fragments,
      (fragment, index) =>
        decodeNavigationFragment(fragment, `${name}.fragments[${index}]`),
      `${name}.fragments`,
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
  assertNavigationRelations(navigation, name);
  return navigation;
}

function assertNavigationRelations(
  navigation: MediaNavigation,
  name: string,
): void {
  const fragmentsByIndex = new Map<number, ReaderNavigationFragment>();
  const fragmentIds = new Set<string>();
  let previousFragmentIndex = -1;
  for (const fragment of navigation.fragments) {
    if (
      fragment.fragment_idx <= previousFragmentIndex ||
      fragmentsByIndex.has(fragment.fragment_idx) ||
      fragmentIds.has(fragment.fragment_id)
    ) {
      throw new TypeError(
        `${name}.fragments must be ordered unique document units`,
      );
    }
    previousFragmentIndex = fragment.fragment_idx;
    fragmentsByIndex.set(fragment.fragment_idx, fragment);
    fragmentIds.add(fragment.fragment_id);
  }

  const sectionIds = new Set<string>();
  const sectionOrdinals = new Set<number>();
  let previousSectionOrdinal = -1;
  for (const section of navigation.sections) {
    const fragment = fragmentsByIndex.get(section.fragment_idx);
    if (
      sectionIds.has(section.section_id) ||
      sectionOrdinals.has(section.ordinal) ||
      section.ordinal <= previousSectionOrdinal
    ) {
      throw new TypeError(`${name}.sections must be ordered unique targets`);
    }
    if (!fragment || fragment.fragment_id !== section.fragment_id) {
      throw new TypeError(
        `${name}.sections must target their declared document fragment`,
      );
    }
    if (
      section.start_offset > fragment.char_count ||
      (section.end_offset !== null && section.end_offset > fragment.char_count)
    ) {
      throw new TypeError(
        `${name}.sections offsets must be bounded by canonical fragment length`,
      );
    }
    sectionIds.add(section.section_id);
    sectionOrdinals.add(section.ordinal);
    previousSectionOrdinal = section.ordinal;
  }

  const assertLocation = (
    location: ReaderNavigationLocation | ReaderNavigationTocNode,
    locationName: string,
  ) => {
    if (
      location.fragment_idx !== null &&
      !fragmentsByIndex.has(location.fragment_idx)
    ) {
      throw new TypeError(`${locationName} targets an absent fragment`);
    }
    if (location.section_id !== null && !sectionIds.has(location.section_id)) {
      throw new TypeError(`${locationName} targets an absent section`);
    }
  };
  const walkToc = (nodes: ReaderNavigationTocNode[], path: string) => {
    nodes.forEach((node, index) => {
      const nodeName = `${path}[${index}]`;
      assertLocation(node, nodeName);
      walkToc(node.children, `${nodeName}.children`);
    });
  };
  walkToc(navigation.toc_nodes, `${name}.toc_nodes`);
  navigation.landmarks.forEach((location, index) =>
    assertLocation(location, `${name}.landmarks[${index}]`),
  );
  navigation.page_list.forEach((location, index) =>
    assertLocation(location, `${name}.page_list[${index}]`),
  );
}

function decodeNavigationFragment(
  raw: unknown,
  name: string,
): ReaderNavigationFragment {
  const value = expectExactRecord(
    raw,
    ["fragment_id", "fragment_idx", "char_count"],
    name,
  );
  return {
    fragment_id: expectString(value.fragment_id, `${name}.fragment_id`),
    fragment_idx: expectNonnegativeInteger(
      value.fragment_idx,
      `${name}.fragment_idx`,
    ),
    char_count: expectNonnegativeInteger(
      value.char_count,
      `${name}.char_count`,
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
    ],
    name,
  );
  const startOffset = expectNonnegativeInteger(
    value.start_offset,
    `${name}.start_offset`,
  );
  const endOffset = expectNullableInteger(
    value.end_offset,
    `${name}.end_offset`,
  );
  if (endOffset !== null && endOffset < startOffset) {
    throw new TypeError(`${name}.end_offset must not precede start_offset`);
  }
  return {
    section_id: expectString(value.section_id, `${name}.section_id`),
    label: expectString(value.label, `${name}.label`),
    ordinal: expectNonnegativeInteger(value.ordinal, `${name}.ordinal`),
    fragment_id: expectString(value.fragment_id, `${name}.fragment_id`),
    fragment_idx: expectNonnegativeInteger(
      value.fragment_idx,
      `${name}.fragment_idx`,
    ),
    level: expectNullableInteger(value.level, `${name}.level`),
    depth: expectNullableInteger(value.depth, `${name}.depth`),
    start_offset: startOffset,
    end_offset: endOffset,
    href_path: expectNullableString(value.href_path, `${name}.href_path`),
    href_fragment: expectNullableString(
      value.href_fragment,
      `${name}.href_fragment`,
    ),
    anchor_id: expectNullableString(value.anchor_id, `${name}.anchor_id`),
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
