"""Overview-rail marker projection for canonical Reader Evidence."""

from __future__ import annotations

from typing import cast
from uuid import UUID

from nexus.schemas.media import DocumentEmbedOut, MediaNavigationOut
from nexus.schemas.presence import absent, present
from nexus.schemas.reader_document_map import (
    ReaderDocumentMapMarkerKind,
    ReaderDocumentMapMarkerOut,
    ReaderDocumentMapMarkerTone,
    ReaderEvidencePassageGroupOut,
    ReaderEvidenceResolvedOut,
)
from nexus.services.reader_locations import locator_end_fraction, locator_fraction, locator_json

_ITEM_TONES: dict[str, ReaderDocumentMapMarkerTone] = {
    "Highlight": "Highlight",
    "SourceReference": "Citation",
    "GeneratedCitation": "Citation",
    "Link": "Link",
    "Synapse": "Synapse",
}


def build_markers(
    *,
    media_id: UUID,
    media_kind: str,
    navigation: MediaNavigationOut | None,
    embeds: list[DocumentEmbedOut],
    groups: list[ReaderEvidencePassageGroupOut],
    fragment_ranges: dict[str, tuple[int, int]],
    total_fragment_chars: int,
    page_count: int | None,
    pdf_page_heights: dict[int, float],
) -> list[ReaderDocumentMapMarkerOut]:
    """Project canonical facts and reader owners onto 0..1 document positions."""

    def fraction(locator: dict[str, object] | None) -> float | None:
        return locator_fraction(
            locator, fragment_ranges, total_fragment_chars, page_count, pdf_page_heights
        )

    def end_fraction(locator: dict[str, object] | None) -> float | None:
        return locator_end_fraction(
            locator, fragment_ranges, total_fragment_chars, page_count, pdf_page_heights
        )

    offsets_type = "web_text_offsets" if media_kind == "web_article" else "epub_fragment_offsets"
    markers: list[ReaderDocumentMapMarkerOut] = []
    for section in navigation.sections if navigation is not None else []:
        position = fraction(
            {
                "type": offsets_type,
                "media_id": str(media_id),
                "fragment_id": str(section.target.fragment_id),
                "start_offset": section.target.offset,
            }
        )
        if position is None:
            continue
        markers.append(
            _marker(
                kind="Contents",
                item_id=f"contents:{section.section_id}",
                position=position,
                end_position=fraction(
                    {
                        "fragment_id": str(section.extent.value.end.fragment_id),
                        "start_offset": section.extent.value.end.offset,
                    }
                )
                if section.extent.kind == "Present"
                else None,
                tone="Neutral",
                label=section.label,
                preview=None,
            )
        )
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
    for group in groups:
        if not isinstance(group.resolution, ReaderEvidenceResolvedOut):
            continue
        locator = locator_json(group.resolution.anchor.locator)
        position = fraction(locator)
        if position is None:
            continue
        end_position = end_fraction(locator)
        for item in group.items:
            markers.append(
                _marker(
                    kind=cast(ReaderDocumentMapMarkerKind, item.kind),
                    item_id=item.id,
                    position=position,
                    end_position=end_position,
                    tone=_ITEM_TONES[item.kind],
                    label=item.label,
                    preview=item.excerpt.value if item.excerpt.kind == "Present" else None,
                )
            )
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
        end_position=present(end_position) if end_position is not None else absent(),
        tone=tone,
        label=label,
        preview=present(preview) if preview else absent(),
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
