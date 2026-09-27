import type { AnchoredReaderRow } from "@/components/reader/useAnchoredReaderProjection";
import { parseRawPdfQuads } from "@/lib/highlights/pdfTypes";
import type { ReaderEvidenceItem, ReaderEvidencePassageGroup } from "./documentMap";

/** Source order is authoritative. Crowded groups continue below the viewport. */
export function placeEvidenceGroups(
  groups: readonly { id: string; desiredTop: number }[],
  heights: ReadonlyMap<string, number>,
  gap: number,
): { id: string; top: number; gapBefore: number; bottom: number }[] {
  let previousBottom = 0;
  return groups.map((group, index) => {
    const top = Math.max(0, group.desiredTop, previousBottom + (index ? gap : 0));
    const gapBefore = top - previousBottom;
    const bottom = top + (heights.get(group.id) ?? 0);
    previousBottom = bottom;
    return { id: group.id, top, gapBefore, bottom };
  });
}

export function anchoredRowForEvidenceItem(
  group: ReaderEvidencePassageGroup,
  item: ReaderEvidenceItem,
): AnchoredReaderRow | null {
  if (group.resolution.kind !== "Resolved") return null;
  const locator = group.resolution.anchor.locator;
  const base = {
    id: item.id,
    exact: item.kind === "Highlight" ? item.quote : item.label,
    color: item.kind === "Highlight" ? item.color : ("blue" as const),
    stable_order_key: group.resolution.order_key,
  };
  if (
    locator.type === "web_text_offsets" ||
    locator.type === "epub_fragment_offsets"
  ) {
    return {
      ...base,
      anchor: {
        fragment_id: locator.fragment_id,
        start_offset: locator.start_offset,
        end_offset: locator.end_offset,
      },
    };
  }
  if (locator.type === "pdf_page_geometry") {
    return {
      ...base,
      page_number: locator.page_number,
      quads: parseRawPdfQuads(locator.quads),
    };
  }
  return null;
}
