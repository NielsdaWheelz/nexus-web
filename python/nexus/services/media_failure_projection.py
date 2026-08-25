"""Lightweight persistence owner for terminal Media failure fields."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

type MediaFailureStage = Literal[
    "upload",
    "extract",
    "transcribe",
    "embed",
    "metadata",
    "other",
]

_MEDIA_FAILURE_STAGES = frozenset({"upload", "extract", "transcribe", "embed", "metadata", "other"})


def require_media_failure_stage(value: str) -> MediaFailureStage:
    """Narrow a boundary string to the closed Media failure-stage contract."""
    if value not in _MEDIA_FAILURE_STAGES:
        raise AssertionError(f"unsupported Media failure stage: {value!r}")
    return cast(MediaFailureStage, value)


def mark_media_failed_by_id(
    db: Session,
    *,
    media_id: UUID,
    stage: MediaFailureStage,
    error_code: str,
    error_message: str,
    now: datetime,
) -> None:
    """Transition one locked Media row to terminal failure."""
    updated = db.execute(
        text(
            """
            UPDATE media
            SET processing_status = 'failed',
                failure_stage = :failure_stage,
                last_error_code = :error_code,
                last_error_message = :error_message,
                processing_completed_at = NULL,
                failed_at = :now,
                updated_at = :now
            WHERE id = :media_id
            RETURNING id
            """
        ),
        {
            "media_id": media_id,
            "failure_stage": stage,
            "error_code": error_code,
            "error_message": error_message,
            "now": now,
        },
    ).one_or_none()
    if updated is None:
        raise AssertionError("terminal Media failure target is absent")
