import { decodePresence, type Presence } from "@/lib/api/presence";
import {
  expectArray,
  expectExactRecord,
  expectNonnegativeInteger,
  expectOneOf,
  expectString,
} from "@/lib/validation";

export interface ReaderNavigationFragment {
  fragment_id: string;
  fragment_idx: number;
  char_count: number;
}

export interface ReaderNavigationTextPoint {
  fragment_id: string;
  offset: number;
}

export interface ReaderNavigationTextRange {
  start: ReaderNavigationTextPoint;
  end: ReaderNavigationTextPoint;
}

export interface ReaderNavigationSection {
  section_id: string;
  anchor_id: Presence<string>;
  label: string;
  parent_section_id: Presence<string>;
  target: ReaderNavigationTextPoint;
  extent: Presence<ReaderNavigationTextRange>;
  source: "Publisher" | "Heading" | "Both" | "InferredNumberedEntry";
}

export interface ReaderNavigationTocNode {
  id: string;
  label: string;
  section_id: Presence<string>;
  children: ReaderNavigationTocNode[];
}

export interface ReaderNavigationLocation {
  id: string;
  label: string;
  target: Presence<ReaderNavigationTextPoint>;
}

export interface MediaNavigationResponse {
  data: {
    media_id: string;
    kind: "epub" | "web_article";
    generation: number;
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
      "generation",
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
    generation: expectNonnegativeInteger(value.generation, `${name}.generation`),
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

  const fragmentsById = new Map(navigation.fragments.map((fragment) => [fragment.fragment_id, fragment]));
  const absoluteStarts = new Map<string, number>();
  let length = 0;
  for (const fragment of navigation.fragments) {
    absoluteStarts.set(fragment.fragment_id, length);
    length += fragment.char_count;
  }
  const pointOffset = (point: ReaderNavigationTextPoint): number => {
    const fragment = fragmentsById.get(point.fragment_id);
    const start = absoluteStarts.get(point.fragment_id);
    if (fragment === undefined || start === undefined || point.offset > fragment.char_count) {
      throw new TypeError(`${name} point must lie within its canonical fragment`);
    }
    return start + point.offset;
  };
  if (navigation.generation < 1) throw new TypeError(`${name}.generation must be positive`);
  const sections = new Map<string, ReaderNavigationSection>();
  let previousStart = -1;
  for (const section of navigation.sections) {
    const start = pointOffset(section.target);
    if (sections.has(section.section_id) || start < previousStart) {
      throw new TypeError(`${name}.sections must be unique and in source order`);
    }
    if (section.extent.kind === "Present") {
      const range = section.extent.value;
      if (range.start.fragment_id !== section.target.fragment_id || range.start.offset !== section.target.offset || pointOffset(range.end) < start) {
        throw new TypeError(`${name}.section extent must start at its target and be ordered`);
      }
    }
    sections.set(section.section_id, section);
    previousStart = start;
  }
  for (const section of navigation.sections) {
    const seen = new Set([section.section_id]);
    let parent = section.parent_section_id;
    while (parent.kind === "Present") {
      const ancestor = sections.get(parent.value);
      if (ancestor === undefined || seen.has(parent.value)) {
        throw new TypeError(`${name}.section parents must be present and acyclic`);
      }
      if (section.extent.kind === "Present" && ancestor.extent.kind === "Present" &&
          (pointOffset(section.extent.value.start) < pointOffset(ancestor.extent.value.start) ||
           pointOffset(section.extent.value.end) > pointOffset(ancestor.extent.value.end))) {
        throw new TypeError(`${name}.section extent must be contained by its ancestors`);
      }
      seen.add(parent.value);
      parent = ancestor.parent_section_id;
    }
  }
  const walkToc = (nodes: ReaderNavigationTocNode[]) => {
    for (const node of nodes) {
      if (node.section_id.kind === "Present" && !sections.has(node.section_id.value)) {
        throw new TypeError(`${name}.toc_nodes target an absent section`);
      }
      walkToc(node.children);
    }
  };
  walkToc(navigation.toc_nodes);
  for (const location of [...navigation.landmarks, ...navigation.page_list]) {
    if (location.target.kind === "Present") pointOffset(location.target.value);
  }
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

export function decodeReaderNavigationTextPoint(raw: unknown, name: string): ReaderNavigationTextPoint {
  const value = expectExactRecord(raw, ["fragment_id", "offset"], name);
  return {
    fragment_id: expectString(value.fragment_id, `${name}.fragment_id`),
    offset: expectNonnegativeInteger(value.offset, `${name}.offset`),
  };
}

function decodeNavigationSection(raw: unknown, name: string): ReaderNavigationSection {
  const value = expectExactRecord(raw, ["section_id", "anchor_id", "label", "parent_section_id", "target", "extent", "source"], name);
  return {
    section_id: expectString(value.section_id, `${name}.section_id`),
    anchor_id: decodePresence(value.anchor_id, (id) => expectString(id, `${name}.anchor_id.value`)),
    label: expectString(value.label, `${name}.label`),
    parent_section_id: decodePresence(value.parent_section_id, (id) => expectString(id, `${name}.parent_section_id.value`)),
    target: decodeReaderNavigationTextPoint(value.target, `${name}.target`),
    extent: decodePresence(value.extent, (rawRange) => {
      const range = expectExactRecord(rawRange, ["start", "end"], `${name}.extent.value`);
      return {
        start: decodeReaderNavigationTextPoint(range.start, `${name}.extent.value.start`),
        end: decodeReaderNavigationTextPoint(range.end, `${name}.extent.value.end`),
      };
    }),
    source: expectOneOf(value.source, ["Publisher", "Heading", "Both", "InferredNumberedEntry"] as const, `${name}.source`),
  };
}

function decodeTocNode(raw: unknown, name: string): ReaderNavigationTocNode {
  const value = expectExactRecord(raw, ["id", "label", "section_id", "children"], name);
  return {
    id: expectString(value.id, `${name}.id`),
    label: expectString(value.label, `${name}.label`),
    section_id: decodePresence(value.section_id, (id) => expectString(id, `${name}.section_id.value`)),
    children: expectArray(value.children, (child, index) => decodeTocNode(child, `${name}.children[${index}]`), `${name}.children`),
  };
}

function decodeNavigationLocation(raw: unknown, name: string): ReaderNavigationLocation {
  const value = expectExactRecord(raw, ["id", "label", "target"], name);
  return {
    id: expectString(value.id, `${name}.id`),
    label: expectString(value.label, `${name}.label`),
    target: decodePresence(value.target, (point) => decodeReaderNavigationTextPoint(point, `${name}.target.value`)),
  };
}
