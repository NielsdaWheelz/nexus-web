"""Canonical publisher chapters and their exact transcript destinations.

The caller supplies one consistent database snapshot. The source read contains only
ordered segment ids and chapter metadata, so processing snapshots never load bodies.
The change token includes effective intervals and labels; body identity remains the
segment-id identity. A text scope includes only a contiguous run of whole timed cues. A missing end
is derived only when the publisher observation confirmed absence; historical nulls
retain their uncertainty until a new observation.
"""

import hashlib
import json
from bisect import bisect_right
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.reader_document import (
    ReaderPointOut,
    ReaderUnitOut,
    TranscriptNavigationOut,
    TranscriptReaderChapterOut,
    TranscriptReaderSearchExtentOut,
)


@dataclass(frozen=True, slots=True)
class TranscriptChapter:
    index: int
    label: str
    start_ms: int
    end_ms: int | None


@dataclass(frozen=True, slots=True)
class TranscriptNavigationSource:
    key: str
    chapters: list[TranscriptChapter]


def read_transcript_navigation_source(db: Session, *, media_id: UUID) -> TranscriptNavigationSource:
    """Ids and canonical chapter facts from the caller's publication snapshot."""
    unit_ids = list(
        db.scalars(
            text("""SELECT id::text FROM fragments WHERE media_id = :id
                    ORDER BY t_start_ms ASC NULLS LAST, idx ASC"""),
            {"id": media_id},
        )
    )
    rows = db.execute(
        text("""SELECT chapter_idx, title, t_start_ms, t_end_ms, end_absence_confirmed
                FROM podcast_episode_chapters WHERE media_id = :id
                ORDER BY t_start_ms, chapter_idx"""),
        {"id": media_id},
    ).all()
    starts = [row.t_start_ms for row in rows]
    chapters = []
    for row in rows:
        later = bisect_right(starts, row.t_start_ms)
        end = row.t_end_ms
        if end is None and row.end_absence_confirmed and later < len(starts):
            end = starts[later]
        chapters.append(TranscriptChapter(row.chapter_idx, row.title, row.t_start_ms, end))
    material = [unit_ids, [[c.index, c.label, c.start_ms, c.end_ms] for c in chapters]]
    digest = hashlib.sha256(json.dumps(material, separators=(",", ":")).encode()).hexdigest()
    return TranscriptNavigationSource(key=digest, chapters=chapters)


def project_transcript_navigation(
    source: TranscriptNavigationSource, units: list[ReaderUnitOut]
) -> TranscriptNavigationOut:
    """Retain every chapter; uncovered starts and inexact scopes remain absent."""
    chapters = []
    for chapter in source.chapters:
        containing = [
            unit
            for unit in units
            if unit.t_start_ms is not None
            and unit.t_end_ms is not None
            and unit.t_start_ms <= chapter.start_ms < unit.t_end_ms
        ]
        overlapping = [
            (index, unit)
            for index, unit in enumerate(units)
            if chapter.end_ms is not None
            and unit.t_start_ms is not None
            and unit.t_end_ms is not None
            and unit.t_start_ms < unit.t_end_ms
            and unit.t_start_ms < chapter.end_ms
            and chapter.start_ms < unit.t_end_ms
        ]
        extent = None
        if (
            chapter.end_ms is not None
            and chapter.start_ms < chapter.end_ms
            and overlapping
            and overlapping[-1][0] - overlapping[0][0] + 1 == len(overlapping)
            and all(
                unit.t_start_ms is not None
                and unit.t_end_ms is not None
                and chapter.start_ms <= unit.t_start_ms < unit.t_end_ms <= chapter.end_ms
                for _, unit in overlapping
            )
        ):
            extent = TranscriptReaderSearchExtentOut(
                start=ReaderPointOut(unit_id=overlapping[0][1].id, offset=0),
                end=ReaderPointOut(
                    unit_id=overlapping[-1][1].id, offset=len(overlapping[-1][1].canonical_text)
                ),
            )
        chapters.append(
            TranscriptReaderChapterOut(
                id=f"chapter-{chapter.index}",
                label=chapter.label,
                start_ms=chapter.start_ms,
                end_ms=chapter.end_ms,
                at=ReaderPointOut(unit_id=containing[-1].id, offset=0) if containing else None,
                search_extent=extent,
            )
        )
    return TranscriptNavigationOut(key=source.key, chapters=chapters)
