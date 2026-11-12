"""The permanent account mutex and replay fence for the librarian timeline."""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, ConflictError


def lock_revision(db: Session, viewer_id: UUID) -> int:
    revision = db.scalar(
        text("SELECT deletion_revision FROM librarian_state WHERE user_id=:viewer FOR UPDATE"),
        {"viewer": viewer_id},
    )
    if revision is None or revision < 1:
        # justify-defect: migration and account bootstrap establish this permanent row.
        raise AssertionError("authenticated account has no librarian state")
    return revision


def require_revision(db: Session, viewer_id: UUID, expected: str) -> None:
    if lock_revision(db, viewer_id) != int(expected):
        raise ConflictError(
            ApiErrorCode.E_CHAT_CREATION_STALE, "Deleted history requires a fresh send"
        )


def advance(db: Session, viewer_id: UUID) -> None:
    """The caller holds the account lock and has removed an existing terminal turn."""
    db.execute(
        text(
            "UPDATE librarian_state SET deletion_revision=deletion_revision+1 WHERE user_id=:viewer"
        ),
        {"viewer": viewer_id},
    )
