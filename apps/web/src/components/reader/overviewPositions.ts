import type { Fragment } from "@/app/(authenticated)/media/[id]/transcriptView";
import type { EpubNavigationSection } from "@/lib/media/epubReader";
import { canonicalCpLength } from "@/lib/reader/textOffsets";
import type { AnchoredHighlightRow } from "./useAnchoredHighlightProjection";

export interface PositionedHighlight {
  highlight: AnchoredHighlightRow;
  position: number; // 0..1, fraction through the whole document
}

/**
 * Maps a media's highlights to whole-document positions (0..1) for the
 * overview ruler. Highlights that cannot be positioned are dropped. The result
 * is sorted ascending by position.
 *
 * EPUB note: a stored EPUB highlight anchors by `fragment_id`, and each
 * `EpubNavigationSection` carries the `fragment_id` of its one fragment, so
 * highlights position directly against the section list.
 */
export function positionHighlights(input: {
  mediaKind: "web" | "transcript" | "epub" | "pdf";
  highlights: AnchoredHighlightRow[];
  fragments: Fragment[];
  epubSections: EpubNavigationSection[];
  numPages: number | null;
}): PositionedHighlight[] {
  const positioned: PositionedHighlight[] = [];

  if (input.mediaKind === "pdf") {
    if (input.numPages !== null && input.numPages > 0) {
      for (const highlight of input.highlights) {
        if (highlight.page_number == null) {
          continue;
        }
        const position = (highlight.page_number - 0.5) / input.numPages;
        positioned.push({
          highlight,
          position: Math.min(1, Math.max(0, position)),
        });
      }
    }
  } else {
    // web / transcript / epub: cumulative codepoint offset over text units.
    const units =
      input.mediaKind === "epub"
        ? input.epubSections
            .slice()
            .sort((left, right) => left.ordinal - right.ordinal)
            .map((section) => ({
              fragmentId: section.fragment_id,
              length: section.char_count,
            }))
        : input.fragments
            .slice()
            .sort((left, right) => left.idx - right.idx)
            .map((fragment) => ({
              fragmentId: fragment.id,
              length: canonicalCpLength(fragment.canonical_text),
            }));

    const total = units.reduce((sum, unit) => sum + unit.length, 0);
    const startOffsets = new Map<string, number>();
    let cumulative = 0;
    for (const unit of units) {
      startOffsets.set(unit.fragmentId, cumulative);
      cumulative += unit.length;
    }

    if (total > 0) {
      for (const highlight of input.highlights) {
        const fragmentId = highlight.anchor?.fragment_id;
        const unitStart =
          fragmentId === undefined ? undefined : startOffsets.get(fragmentId);
        if (unitStart === undefined || highlight.anchor === undefined) {
          continue;
        }
        positioned.push({
          highlight,
          position: (unitStart + highlight.anchor.start_offset) / total,
        });
      }
    }
  }

  positioned.sort((left, right) => left.position - right.position);
  return positioned;
}
