"""Activity exclusions: drop one observed session from every statistic, or count it again."""

from __future__ import annotations

from collections.abc import Callable
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas.consumption_activity import (
    ActivityExclusionResultOut,
    ExcludeActivityIn,
    RestoreActivityExclusionIn,
)
from nexus.services.consumption import replayed_command, stats
from nexus.services.consumption.handles import EXCLUSION, seal, unseal


def exclude(
    viewer_id: UUID, *, command: ExcludeActivityIn, media_id: UUID
) -> ActivityExclusionResultOut:
    """Drop exactly one current observed session from every statistic."""

    def apply(db: Session) -> dict[str, str]:
        if command.started_at >= command.ended_at:
            raise InvalidRequestError(message="Excluded activity session has an invalid interval")
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        device_id = stats.resolve_device(db, viewer_id=viewer_id, handle=command.device_handle)
        interval = command.model_dump(include={"modality", "started_at", "ended_at"})
        if not stats.exact_session_exists(
            db, viewer_id=viewer_id, media_id=media_id, device_id=device_id, **interval
        ):
            raise InvalidRequestError(
                message="Excluded activity must name one exact current observed session"
            )
        exclusion_id = new_uuid7()
        db.execute(
            text("""
                INSERT INTO consumption_activity_exclusions
                    (id, user_id, media_id, modality, device_id, started_at, ended_at)
                VALUES (:id, :viewer_id, :media_id, :modality, :device_id, :started_at, :ended_at)
            """),
            {"id": exclusion_id, "viewer_id": viewer_id, "media_id": media_id}
            | {"device_id": device_id, **interval},
        )
        return _result("Excluded", exclusion_id)

    return _replayed(viewer_id, command, apply)


def restore(viewer_id: UUID, *, command: RestoreActivityExclusionIn) -> ActivityExclusionResultOut:
    """Count one excluded session again."""

    def apply(db: Session) -> dict[str, str]:
        params = {"id": unseal(EXCLUSION, command.exclusion_handle), "viewer_id": viewer_id}
        restored = db.scalar(
            text("""SELECT restored_at IS NOT NULL FROM consumption_activity_exclusions
                    WHERE id = :id AND user_id = :viewer_id"""),
            params,
        )
        if restored is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Activity exclusion not found")
        if restored:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "Activity exclusion is already restored"
            )
        db.execute(
            text("UPDATE consumption_activity_exclusions SET restored_at = now() WHERE id = :id"),
            params,
        )
        return _result("Restored", params["id"])

    return _replayed(viewer_id, command, apply)


def _result(outcome: str, exclusion_id: UUID) -> dict[str, str]:
    return {"outcome": outcome, "exclusionHandle": seal(EXCLUSION, exclusion_id)}


def _replayed(
    viewer_id: UUID,
    command: ExcludeActivityIn | RestoreActivityExclusionIn,
    apply: Callable[[Session], dict[str, str]],
) -> ActivityExclusionResultOut:
    """One exclusion write, replayed by ``clientMutationId``; its memo is the result itself."""
    return replayed_command(
        "apply_activity_exclusion",
        "Consumption.ActivityExclusions",
        viewer_id,
        command,
        apply,
        lambda _, memo: ActivityExclusionResultOut.model_validate(memo),
    )
