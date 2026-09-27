import type { CanonicalCursorResult } from "@/lib/highlights/canonicalCursor";
import type { ReaderEvidencePassageGroup, ReaderEvidenceSourceReference } from "./documentMap";

/** Attach inferred note references to their exact, preserved source links. */
export function bindEpubSourceNoteReferences(
  root: HTMLElement,
  cursor: CanonicalCursorResult,
  fragmentId: string,
  groups: readonly ReaderEvidencePassageGroup[],
): void {
  const canonicalCharacters = [...cursor.emitted];
  for (const group of groups) {
    if (group.resolution.kind !== "Resolved") continue;
    const references = group.items.filter((item): item is ReaderEvidenceSourceReference =>
      item.kind === "SourceReference" &&
      (item.apparatus_kind === "footnote_ref" || item.apparatus_kind === "endnote_ref"),
    );
    if (references.length !== 1) continue;
    const item = references[0];
    const locator = group.resolution.anchor.locator;
    if (locator.type !== "epub_fragment_offsets" ||
      locator.fragment_id !== fragmentId ||
      locator.start_offset >= locator.end_offset ||
      locator.end_offset > cursor.length) continue;
    const exact = locator.text_quote_selector?.exact;
    if (!exact || canonicalCharacters.slice(locator.start_offset, locator.end_offset).join("") !== exact) continue;

    const first = cursor.provenance[locator.start_offset]?.spans[0]?.node;
    const marker = first?.parentElement?.closest("a[href]");
    if (!(marker instanceof HTMLAnchorElement) || !root.contains(marker) ||
      marker.hasAttribute("data-reader-apparatus-item-id") ||
      (item.marker_anchor_id.kind === "Present" && item.marker_anchor_id.value !== marker.id)) continue;
    // Every span in the locator belongs to this link. Its neighboring
    // canonical characters must be outside the link, so a partial label fails.
    let matchesFullLink = !cursor.provenance[locator.start_offset - 1]?.spans.some(
      (span) => marker.contains(span.node),
    ) && !cursor.provenance[locator.end_offset]?.spans.some(
      (span) => marker.contains(span.node),
    );
    for (let offset = locator.start_offset; matchesFullLink && offset < locator.end_offset; offset += 1) {
      const spans = cursor.provenance[offset]?.spans ?? [];
      if (!spans.length || spans.some((span) => !marker.contains(span.node))) {
        matchesFullLink = false;
      }
    }
    if (!matchesFullLink) continue;

    marker.setAttribute("data-reader-apparatus-item-id", item.stable_key);
    marker.setAttribute("data-reader-apparatus-kind", item.apparatus_kind);
    marker.setAttribute("data-reader-apparatus-confidence", item.confidence);
  }
}
