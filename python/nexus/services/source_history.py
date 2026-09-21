"""The history stage and counted progress of one source attempt.

A leaf over the source-type contract and the history vocabulary: the queue seam
(``jobs/history_projections.py``) records these facts inside the worker's queue
transition, so this owner reaches neither the ORM nor the queue.
"""

from __future__ import annotations

from nexus.schemas.import_history import SourceFailureProgress, Stage
from nexus.schemas.presence import Presence, absent, present
from nexus.services import media_source_types as source_types

COUNTED_PROGRESS_SOURCE_TYPES: frozenset[str] = (
    source_types.LOCAL_FILE_SOURCE_TYPES | source_types.REMOTE_FILE_SOURCE_TYPES
)
"""The source types whose adapter records Validate/Extract/Finalize progress.

Only the PDF/EPUB file adapters record counted progress; every other source is
one opaque processing step.
"""

_STAGES: dict[str, Stage] = {"Validate": "Validate", "Extract": "Extract", "Finalize": "Finalize"}


def source_history_stage(*, source_type: str, processing_stage: str | None) -> Stage:
    """The history stage one source attempt is currently in."""
    if source_type not in COUNTED_PROGRESS_SOURCE_TYPES:
        return "SourceProcessing"
    return _STAGES.get(processing_stage or "Validate", "Validate")


def source_failure_progress(
    *,
    processing_stage: str | None,
    progress_completed: int,
    progress_total: int | None,
    progress_unit: str | None,
) -> Presence[SourceFailureProgress]:
    """The counted progress a failure happened at, present only during Extract."""
    if processing_stage != "Extract" or progress_total is None:
        return absent()
    return present(
        SourceFailureProgress(
            completed=progress_completed,
            total=present(progress_total),
            unit=absent() if progress_unit is None else present(progress_unit),
        )
    )
