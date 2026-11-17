"""Drawing units from a work's canonical structure, in whole-work place coordinates.

The caller owns visibility and the read snapshot. Navigation is read only after its
publication is ready; failures in a ready publication propagate. Parts are zero-based.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.consumption_activity import UnitOut
from nexus.schemas.reader import NavigationTextPointOut
from nexus.services.capabilities import is_document_status_ready
from nexus.services.consumption.projection import listening_duration_sql
from nexus.services.media_document_metrics import pdf_pages_sql
from nexus.services.reader_navigation import get_media_navigation_for_viewer


@dataclass(frozen=True, slots=True)
class Structure:
    unit: Literal["Chapter", "Section", "Page"] | None
    parts: list[str]
    units: list[UnitOut]


@dataclass(frozen=True, slots=True)
class _Start:
    label: str | None
    place: float
    part: int | None = None
    weight: float | None = None


def _arrange(starts: list[_Start]) -> list[UnitOut]:
    distinct: dict[float, _Start] = {}
    for start in sorted(starts, key=lambda item: item.place):
        distinct.setdefault(start.place, start)
    ordered = list(distinct.values())
    result: list[UnitOut] = []
    for i, start in enumerate(ordered):
        end = ordered[i + 1].place if i + 1 < len(ordered) else 1.0
        result.append(
            UnitOut(
                label=start.label,
                start=start.place,
                end=end,
                weight=end - start.place if start.weight is None else start.weight,
                part=start.part,
            )
        )
    return result


def units(db: Session, viewer_id: UUID, media_id: UUID) -> Structure:
    """The unit noun, parts and ordered units of one authorized work; no units is valid."""
    row = db.execute(
        text(f"""SELECT m.kind, m.processing_status, rp.generation,
                       {pdf_pages_sql("m")} AS pages,
                       nullif({listening_duration_sql("pls", "pe")}, 0) AS duration_ms
                FROM media m
                LEFT JOIN reader_publications rp ON rp.media_id = m.id
                LEFT JOIN podcast_episodes pe ON pe.media_id = m.id
                LEFT JOIN podcast_listening_states pls
                  ON pls.media_id = m.id AND pls.user_id = :viewer_id
                WHERE m.id = :media_id"""),
        {"viewer_id": viewer_id, "media_id": media_id},
    ).one()
    empty = Structure(None, [], [])
    if row.kind in ("epub", "web_article", "pdf") and (
        not is_document_status_ready(row.processing_status) or row.generation is None
    ):
        return empty
    if row.kind == "pdf":
        weights = dict(
            db.execute(
                text("""SELECT p.page_number, coalesce(sum(regexp_count(
                        substring(m.plain_text FROM p.start_offset + 1
                                  FOR p.end_offset - p.start_offset), '[^[:space:]]+')), 0)
                    FROM pdf_page_text_spans p JOIN media m ON m.id = p.media_id
                    WHERE p.media_id = :media_id GROUP BY p.page_number"""),
                {"media_id": media_id},
            )
            .tuples()
            .all()
        )
        pages = int(row.pages)
        return (
            Structure(
                "Page",
                [],
                _arrange(
                    [
                        _Start(str(page), (page - 1) / pages, weight=float(weights.get(page, 0)))
                        for page in range(1, pages + 1)
                    ]
                ),
            )
            if pages
            else empty
        )
    if row.kind == "podcast_episode":
        if row.duration_ms is None or row.duration_ms <= 0:
            return empty
        chapters = db.execute(
            text("""SELECT title, t_start_ms FROM podcast_episode_chapters
                    WHERE media_id = :media_id AND t_start_ms <= :duration_ms
                    ORDER BY chapter_idx"""),
            {"media_id": media_id, "duration_ms": row.duration_ms},
        )
        result = _arrange(
            [_Start(chapter.title, chapter.t_start_ms / row.duration_ms) for chapter in chapters]
        )
        return Structure("Section", [], result) if len(result) >= 2 else empty
    if row.kind not in ("epub", "web_article"):
        return empty
    navigation = get_media_navigation_for_viewer(db, viewer_id, media_id)
    preceding: dict[UUID, int] = {}
    total = 0
    for fragment in navigation.fragments:
        preceding[fragment.fragment_id] = total
        total += fragment.char_count
    if total == 0:
        return empty

    def place(target: NavigationTextPointOut) -> float:
        return (preceding[target.fragment_id] + target.offset) / total

    if row.kind == "web_article":
        parents = {section.section_id: section.parent_section_id for section in navigation.sections}
        depths: dict[str, int] = {}
        for section in navigation.sections:
            depth, parent = 0, section.parent_section_id
            while parent is not None:
                depth += 1
                parent = parents[parent]
            depths[section.section_id] = depth
        shallowest = min(depths.values(), default=0)
        result = _arrange(
            [
                _Start(section.label or None, place(section.target))
                for section in navigation.sections
                if depths[section.section_id] == shallowest
            ]
        )
        return Structure("Section", [], result) if len(result) >= 2 else empty

    parts = [node for node in navigation.toc_nodes if node.children]
    labels = [node.label for node in parts] if len(parts) >= 2 else []
    starts: list[_Start] = []
    part_index = 0
    for node in navigation.toc_nodes:
        part = part_index if labels and node.children else None
        if node.children:
            part_index += 1
        for unit in node.children if node.children else [node]:
            if unit.target is not None:
                starts.append(_Start(unit.label or None, place(unit.target), part))
    sections = [
        _Start(section.label or None, place(section.target)) for section in navigation.sections
    ]
    for candidates, part_labels in [(starts, labels), (sections, [])]:
        result = _arrange(candidates)
        if result and result[0].start > 0.005:
            end = result[0].start
            result.insert(0, UnitOut(label=None, start=0, end=end, weight=end, part=None))
        if len(result) >= 2:
            return Structure("Chapter", part_labels, result)
    return empty
