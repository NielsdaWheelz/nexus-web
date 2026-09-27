import type { CanonicalCursorResult } from "@/lib/highlights/canonicalCursor";
import type { ReaderEvidencePassageGroup, ReaderEvidenceSourceReference } from "./documentMap";

/** Attach inferred note references to their exact, preserved source links. */
export function bindEpubSourceNoteReferences(
  root: HTMLElement,
  cursor: CanonicalCursorResult,
  fragmentId: string,
  groups: readonly ReaderEvidencePassageGroup[],
): () => void {
  const canonicalCharacters = [...cursor.emitted];
  const bound: Array<{ marker: HTMLAnchorElement; itemId: string; kind: string; confidence: string }> = [];
  const candidates = new Map<HTMLAnchorElement, ReaderEvidenceSourceReference>();
  const ambiguous = new Set<HTMLAnchorElement>();
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

    const previous = candidates.get(marker);
    if (previous && (previous.id !== item.id || previous.stable_key !== item.stable_key)) {
      ambiguous.add(marker);
    } else {
      candidates.set(marker, item);
    }
  }
  for (const [marker, item] of candidates) {
    if (ambiguous.has(marker)) continue;
    marker.setAttribute("data-reader-apparatus-item-id", item.stable_key);
    marker.setAttribute("data-reader-apparatus-kind", item.apparatus_kind);
    marker.setAttribute("data-reader-apparatus-confidence", item.confidence);
    bound.push({ marker, itemId: item.stable_key, kind: item.apparatus_kind, confidence: item.confidence });
  }
  return () => {
    for (const { marker, itemId, kind, confidence } of bound) {
      if (marker.getAttribute("data-reader-apparatus-item-id") !== itemId ||
        marker.getAttribute("data-reader-apparatus-kind") !== kind ||
        marker.getAttribute("data-reader-apparatus-confidence") !== confidence) continue;
      marker.removeAttribute("data-reader-apparatus-item-id");
      marker.removeAttribute("data-reader-apparatus-kind");
      marker.removeAttribute("data-reader-apparatus-confidence");
    }
  };
}
