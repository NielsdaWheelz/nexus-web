"""Overview-rail marker projection for canonical Reader Evidence."""

from __future__ import annotations

from uuid import UUID

from nexus.schemas.document_embeds import DocumentEmbedOut
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
from nexus.services.resource_items.items import preview_text

_ITEM_TONES: dict[str, ReaderDocumentMapMarkerTone] = {
    "Highlight": "Highlight",
    "SourceReference": "Citation",
    "GeneratedCitation": "Citation",
    "Link": "Link",
    "MachineLink": "MachineLink",
}


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
    for root in roots:
        if not isinstance(root.resolution, ReaderEvidenceResolvedOut):
            continue
        locator = locator_json(root.resolution.anchor.locator)
        position = fraction(locator)
        if position is None:
            continue
        content = root.content
        if isinstance(content, ReaderEvidenceSourceReferenceOut):
            label = content.label
            preview = content.excerpt.text
        else:
            label = content.item.label
            preview = preview_text(content.item)
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
            item_id=root.ref,
            position=position,
            end_position=end_fraction(locator),
            tone=_ITEM_TONES[kind],
            label=label,
            preview=preview or None,
        )
        marker.id = f"marker:{root.ref}"
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
