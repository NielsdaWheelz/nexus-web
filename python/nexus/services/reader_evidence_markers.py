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
from nexus.services.reader_locations import locator_fraction, locator_json


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
    """Project canonical facts and reader owners into normalized overview markers."""

    markers: list[ReaderDocumentMapMarkerOut] = []
    if navigation is not None:
        for index, section in enumerate(navigation.sections):
            locator = None
            if section.fragment_id is not None:
                locator = {
                    "type": "web_text_offsets"
                    if media_kind == "web_article"
                    else "epub_fragment_offsets",
                    "media_id": str(media_id),
                    "fragment_id": str(section.fragment_id),
                    "start_offset": section.start_offset or 0,
                    "end_offset": section.end_offset
                    or section.start_offset
                    or max(section.char_count or 0, 1),
                }
            fraction = locator_fraction(
                locator,
                fragment_ranges,
                total_fragment_chars,
                page_count,
                pdf_page_heights,
            )
            if fraction is None and navigation.sections:
                fraction = (index + 0.5) / len(navigation.sections)
            if fraction is not None:
                markers.append(
                    _marker(
                        kind="Contents",
                        item_id=f"contents:{section.section_id}",
                        position=fraction,
                        tone="Neutral",
                        label=section.label,
                        preview=None,
                    )
                )
    for embed in embeds:
        locator = _document_embed_locator(media_id, embed)
        fraction = locator_fraction(
            locator,
            fragment_ranges,
            total_fragment_chars,
            page_count,
            pdf_page_heights,
        )
        if fraction is None:
            continue
        markers.append(
            _marker(
                kind="Embed",
                item_id=f"embed:{embed.id}",
                position=fraction,
                tone="Warning"
                if embed.resolution_status in ("failed", "unsupported")
                else "Neutral",
                label=embed.display.label,
                preview=embed.display.description or None,
            )
        )
    tones: dict[str, ReaderDocumentMapMarkerTone] = {
        "Highlight": "Highlight",
        "SourceReference": "Citation",
        "GeneratedCitation": "Citation",
        "Link": "Link",
        "Synapse": "Synapse",
    }
    for group in groups:
        if not isinstance(group.resolution, ReaderEvidenceResolvedOut):
            continue
        fraction = locator_fraction(
            locator_json(group.resolution.anchor.locator),
            fragment_ranges,
            total_fragment_chars,
            page_count,
            pdf_page_heights,
        )
        if fraction is None:
            continue
        for item in group.items:
            preview = item.excerpt.value if item.excerpt.kind == "Present" else None
            markers.append(
                _marker(
                    kind=cast(ReaderDocumentMapMarkerKind, item.kind),
                    item_id=item.id,
                    position=fraction,
                    tone=tones[item.kind],
                    label=item.label,
                    preview=preview,
                )
            )
    markers.sort(key=lambda marker: (marker.position, marker.kind, marker.item_id))
    return markers


def _marker(
    *,
    kind: ReaderDocumentMapMarkerKind,
    item_id: str,
    position: float,
    tone: ReaderDocumentMapMarkerTone,
    label: str,
    preview: str | None,
) -> ReaderDocumentMapMarkerOut:
    return ReaderDocumentMapMarkerOut(
        id=f"marker:{kind}:{item_id}",
        kind=kind,
        item_id=item_id,
        position=min(1.0, max(0.0, position)),
        tone=tone,
        label=label,
        preview=present(preview) if preview else absent(),
    )


def _document_embed_locator(
    media_id: UUID,
    embed: DocumentEmbedOut,
) -> dict[str, object] | None:
    if (
        embed.locator.fragment_id is None
        or embed.locator.canonical_start_offset is None
        or embed.locator.canonical_end_offset is None
    ):
        return None
    return {
        "type": "web_text_offsets",
        "media_id": str(media_id),
        "fragment_id": str(embed.locator.fragment_id),
        "start_offset": embed.locator.canonical_start_offset,
        "end_offset": embed.locator.canonical_end_offset,
    }
