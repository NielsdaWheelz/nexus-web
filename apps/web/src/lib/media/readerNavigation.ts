import type { Schema } from "@/lib/api/wire";

export type ReaderNavigationFragment = Schema<"ReaderNavigationFragmentOut">;
export type ReaderNavigationTextPoint = Schema<"NavigationTextPointOut">;
export type ReaderNavigationSection = Schema<"ReaderNavigationSectionOut">;
export type ReaderNavigationTocNode = Schema<"ReaderNavigationTocNodeOut">;
export type MediaNavigation = Schema<"MediaNavigationOut">;

/** A published location can be a reading section or an EPUB contents point. */
export function findReaderNavigationLocation(
  navigation: MediaNavigation,
  id: string,
): { kind: "Section"; section: ReaderNavigationSection } |
  { kind: "TocPoint"; point: ReaderNavigationTextPoint } | null {
  const section = navigation.sections.find((candidate) => candidate.section_id === id);
  if (section) return { kind: "Section", section };
  if (navigation.kind !== "epub") return null;

  const findPoint = (nodes: ReaderNavigationTocNode[]): ReaderNavigationTextPoint | null => {
    for (const node of nodes) {
      if (node.id === id) return node.target.kind === "Present" ? node.target.value : null;
      const point = findPoint(node.children);
      if (point) return point;
    }
    return null;
  };
  const point = findPoint(navigation.toc_nodes);
  return point ? { kind: "TocPoint", point } : null;
}
