"""The complete source-family write barrier, without storage or presentation imports.

Every media writer locks the same root/piece set in UUID order, then rechecks its
membership after a lock wait. These locks grant no access and commit nothing.
"""

from collections.abc import Sequence
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import TransactionRestart


def media_family_ids(db: Session, media_ids: Sequence[UUID]) -> list[UUID]:
    """complete root/piece families for one ordered media barrier; no access is granted."""
    if not media_ids:
        return []
    return list(
        db.scalars(
            text("""
        WITH roots AS (
            SELECT m.id FROM media m WHERE m.id=ANY(:ids)
            UNION
            SELECT source_media_id FROM media_parts WHERE media_id=ANY(:ids)
        )
        SELECT id FROM roots
        UNION
        SELECT p.media_id FROM media_parts p JOIN roots r ON r.id=p.source_media_id
        ORDER BY id
    """),
            {"ids": list(set(media_ids))},
        )
    )


def lock_media_rows_in_order(
    db: Session,
    media_ids: Sequence[UUID],
    *,
    lock_mode: Literal["update", "no_key_update"] = "update",
) -> list[UUID]:
    """lock complete source families in uuid order; return requested existing identities.

    re-enumeration after locking prevents a new lower-id child from escaping a
    read-committed barrier. the transaction owner restarts when the family changed.
    no_key_update serializes writers while admitting foreign-key key-share locks.
    """
    requested = set(media_ids)
    ordered = media_family_ids(db, media_ids)
    if not ordered:
        return []
    locked = list(
        db.scalars(
            text(
                "SELECT id FROM media WHERE id = ANY(:ids) ORDER BY id "
                + ("FOR UPDATE" if lock_mode == "update" else "FOR NO KEY UPDATE")
            ),
            {"ids": ordered},
        )
    )
    if media_family_ids(db, media_ids) != ordered:
        raise TransactionRestart
    return [media_id for media_id in locked if media_id in requested]
