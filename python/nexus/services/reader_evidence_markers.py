"""Overview-rail marker projection for canonical Reader Evidence."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from nexus.schemas.document_embeds import DocumentEmbedOut
from nexus.schemas.reader_document import ReaderCitationOccurrenceOut, ReaderUnitOut
from nexus.schemas.reader_document_map import (
    ReaderDocumentMapMarkerKind,
    ReaderDocumentMapMarkerOut,
    ReaderDocumentMapMarkerTone,
    ReaderEvidenceHighlightOut,
    ReaderEvidenceResolvedOut,
    ReaderEvidenceRootOut,
    ReaderEvidenceSourceReferenceOut,
)
from nexus.services.reader_locations import (
    locator_end_fraction,
    locator_fraction,
    locator_json,
    timed_fragment_offset,
)
from nexus.services.resource_items.items import preview_texts

_ITEM_TONES: dict[str, ReaderDocumentMapMarkerTone] = {
    "Highlight": "Highlight",
    "SourceReference": "Citation",
    "GeneratedCitation": "Citation",
    "Link": "Link",
    "MachineLink": "MachineLink",
}


def evidence_root_key(root: ReaderEvidenceRootOut) -> str:
    """Citation occurrences keep their identity when they share a referenced resource."""
    if len(root.direct_facts) == 1:
        fact = root.direct_facts[0]
        if fact.origin == "citation" and fact.ordinal is not None:
            return str(fact.edge_id)
    return root.ref


def citation_point_markers(
    *,
    occurrences: list[ReaderCitationOccurrenceOut],
    units: Sequence[ReaderUnitOut],
) -> list[ReaderDocumentMapMarkerOut]:
    """A declared reference has a source point even without any captured target words."""
    from nexus.services.reader_document import reading_source_ranges

    ranges = reading_source_ranges(list(units))
    total = sum(end - start for _unit, start, end in ranges)
    result = []
    for occurrence in occurrences:
        point = occurrence.at
        if point is None:
            continue
        before = 0
        for unit, start, end in ranges:
            if unit.id == point.unit_id and start <= point.offset <= end:
                marker = _marker(
                    kind="GeneratedCitation",
                    item_id=str(occurrence.citation.edge_id),
                    position=(before + point.offset - start) / total if total else 0,
                    end_position=None,
                    tone="Citation",
                    label=occurrence.citation.item.label,
                    preview=preview_texts([occurrence.citation.item])[0] or None,
                )
                marker.id = f"marker:{occurrence.citation.edge_id}"
                result.append(marker)
                break
            before += end - start
    return result


def build_markers(
    *,
    media_id: UUID,
    embeds: list[DocumentEmbedOut],
    roots: list[ReaderEvidenceRootOut],
    fragment_ranges: dict[str, tuple[int, int]],
    fragment_times: dict[str, tuple[int, int]],
    total_fragment_chars: int,
    page_count: int | None,
    pdf_page_heights: dict[int, float],
) -> list[ReaderDocumentMapMarkerOut]:
    """Project canonical facts and reader owners onto 0..1 document positions."""

    def timed_fraction(locator: dict[str, object] | None, *, end: bool = False) -> float | None:
        point = (
            timed_fragment_offset(locator, fragment_ranges, fragment_times, end=end)
            if locator
            else None
        )
        if point is None or total_fragment_chars <= 0:
            return None
        return (fragment_ranges[point[0]][0] + point[1]) / total_fragment_chars

    def fraction(locator: dict[str, object] | None) -> float | None:
        timed = timed_fraction(locator)
        if timed is not None:
            return timed
        return locator_fraction(
            locator, fragment_ranges, total_fragment_chars, page_count, pdf_page_heights
        )

    def end_fraction(locator: dict[str, object] | None) -> float | None:
        timed = timed_fraction(locator, end=True)
        if timed is not None:
            return timed
        return locator_end_fraction(
            locator, fragment_ranges, total_fragment_chars, page_count, pdf_page_heights
        )

    markers: list[ReaderDocumentMapMarkerOut] = []
    for embed in embeds:
        locator = _document_embed_locator(media_id, embed)
        position = fraction(locator)
        if position is None:
            continue
        markers.append(
            _marker(
                kind="Embed",
                item_id=f"embed:{embed.id}",
                position=position,
                end_position=end_fraction(locator),
                tone="Warning"
                if embed.resolution_status in ("failed", "unsupported")
                else "Neutral",
                label=embed.display.label,
                preview=embed.display.description or None,
            )
        )
    placed: list[tuple[ReaderEvidenceRootOut, dict[str, object] | None, float]] = []
    for root in roots:
        if not isinstance(root.resolution, ReaderEvidenceResolvedOut):
            continue
        locator = locator_json(root.resolution.anchor.locator)
        position = fraction(locator)
        if position is None:
            continue
        placed.append((root, locator, position))
    previews = iter(
        preview_texts(
            [
                root.content.item
                for root, _, _ in placed
                if not isinstance(root.content, ReaderEvidenceSourceReferenceOut)
            ]
        )
    )
    for root, locator, position in placed:
        content = root.content
        if isinstance(content, ReaderEvidenceSourceReferenceOut):
            label = content.label
            preview = content.excerpt.text
        else:
            label = content.item.label
            preview = next(previews)
        kind: ReaderDocumentMapMarkerKind
        if isinstance(content, ReaderEvidenceHighlightOut):
            kind = "Highlight"
        elif isinstance(content, ReaderEvidenceSourceReferenceOut):
            kind = "SourceReference"
        elif any(
            fact.origin == "citation" and fact.ordinal is not None for fact in root.direct_facts
        ):
            kind = "GeneratedCitation"
        elif any(fact.origin not in ("assistant", "discovery") for fact in root.direct_facts):
            kind = "Link"
        else:
            kind = "MachineLink"
        marker = _marker(
            kind=kind,
            item_id=evidence_root_key(root),
            position=position,
            end_position=end_fraction(locator),
            tone=_ITEM_TONES[kind],
            label=label,
            preview=preview or None,
        )
        marker.id = f"marker:{evidence_root_key(root)}"
        markers.append(marker)
    markers.sort(key=lambda marker: (marker.position, marker.kind, marker.item_id))
    return markers


def _marker(
    *,
    kind: ReaderDocumentMapMarkerKind,
    item_id: str,
    position: float,
    end_position: float | None,
    tone: ReaderDocumentMapMarkerTone,
    label: str,
    preview: str | None,
) -> ReaderDocumentMapMarkerOut:
    return ReaderDocumentMapMarkerOut(
        id=f"marker:{kind}:{item_id}",
        kind=kind,
        item_id=item_id,
        position=position,
        end_position=end_position if end_position is not None else None,
        tone=tone,
        label=label,
        preview=preview if preview else None,
    )


def _document_embed_locator(media_id: UUID, embed: DocumentEmbedOut) -> dict[str, object] | None:
    if embed.locator.fragment_id is None or embed.locator.canonical_start_offset is None:
        return None
    locator: dict[str, object] = {
        "type": "web_text_offsets",
        "media_id": str(media_id),
        "fragment_id": str(embed.locator.fragment_id),
        "start_offset": embed.locator.canonical_start_offset,
    }
    if embed.locator.canonical_end_offset is not None:
        locator["end_offset"] = embed.locator.canonical_end_offset
    return locator
