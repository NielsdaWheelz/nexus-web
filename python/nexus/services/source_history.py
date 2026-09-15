"""The history stage and counted progress of one source attempt.

A leaf over the durable source-type contract and the history vocabulary: the
queue seam (`jobs/history_projections.py`) records these facts inside the
worker's queue transition, so this owner must not reach the ORM or the queue.
"""

from __future__ import annotations

from nexus.schemas.import_history import SourceFailureProgress, Stage
from nexus.schemas.presence import Presence, absent, present
from nexus.services import media_source_types as source_types

COUNTED_PROGRESS_SOURCE_TYPES: frozenset[str] = (
    source_types.LOCAL_FILE_SOURCE_TYPES | source_types.REMOTE_FILE_SOURCE_TYPES
)
"""The source types whose adapter records Validate/Extract/Finalize progress.

Only the PDF/EPUB file adapters call ``record_source_extraction_progress`` and
``record_source_finalizing``; every other source is one opaque processing step.
"""


def source_history_stage(*, source_type: str, processing_stage: str | None) -> Stage:
    """The history stage of one source attempt (contract D12)."""
    if source_type not in COUNTED_PROGRESS_SOURCE_TYPES:
        return "SourceProcessing"
    match processing_stage:
        case None | "Validate":
            return "Validate"
        case "Extract":
            return "Extract"
        case "Finalize":
            return "Finalize"
        case _:
            # justify-defect: reset_source_progress and the two record_* writers
            # are the only producers of this column and write these three values.
            raise AssertionError(
                f"source attempt has an unknown processing stage {processing_stage!r}"
            )


def source_failure_progress(
    *,
    processing_stage: str | None,
    progress_completed: int,
    progress_total: int | None,
    progress_unit: str | None,
) -> Presence[SourceFailureProgress]:
    """The counted progress a failure happened at, Present only when the run had
    recorded a counted Extract snapshot."""
    if processing_stage != "Extract" or progress_total is None:
        return absent()
    return present(
        SourceFailureProgress(
            completed=progress_completed,
            total=present(progress_total),
            unit=absent() if progress_unit is None else present(progress_unit),
        )
    )
