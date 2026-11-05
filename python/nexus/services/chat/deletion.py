"""Account chat deletion fence; accepted rows remain their own replay receipts.

Fresh creation holds a shared fence through admission. A hard chat/subtree delete
holds it exclusively before conversation locks and advances it only after removal.
The fence does not record commands or serialize unrelated account writers.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, ConflictError


def lock_revision(db: Session, viewer_id: UUID, *, deleting: bool = False) -> int:
    revision = db.scalar(
        text(
            "SELECT revision FROM chat_deletion_revisions WHERE user_id=:viewer "
            + ("FOR UPDATE" if deleting else "FOR SHARE")
        ),
        {"viewer": viewer_id},
    )
    if revision is None or revision < 1:
        # justify-defect: migration and account bootstrap establish this permanent fence.
        raise AssertionError("authenticated account has no valid chat deletion fence")
    return revision


def require_revision(db: Session, viewer_id: UUID, expected: str) -> None:
    if lock_revision(db, viewer_id) != int(expected):
        raise ConflictError(ApiErrorCode.E_CHAT_CREATION_STALE, "Chat creation needs review")


def advance(db: Session, viewer_id: UUID) -> None:
    """The caller holds the exclusive fence and has removed an existing chat/subtree."""
    db.execute(
        text(
            "UPDATE chat_deletion_revisions SET revision=revision+1 "
            "WHERE user_id=:viewer RETURNING revision"
        ),
        {"viewer": viewer_id},
    ).scalar_one()
