"""First sight of a verified user: their row, the default library and its admin membership."""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.db.session import transaction


def ensure_user_and_default_library(db: Session, user_id: UUID, email: str | None) -> None:
    """Create whichever of them is missing (the library is "My Library"); idempotent.

    ``users.email`` mirrors the token's email. The provider keeps emails unique, so another row
    still holding this one is a stale mirror and gives it up. Concurrent first sights converge
    through the SERIALIZABLE retry (``users_pkey``, ``uix_libraries_one_default_per_user``).
    """
    params = {"id": user_id, "email": email}

    def attempt() -> None:
        with transaction(db):
            current = db.execute(text("SELECT email FROM users WHERE id = :id"), params).first()
            # the row before its address: two first sights of one user race on users_pkey alone
            if current is None:
                db.execute(text("INSERT INTO users (id) VALUES (:id)"), params)
            if email is not None and (current is None or current.email != email):
                db.execute(
                    text("UPDATE users SET email = NULL WHERE email = :email AND id <> :id"), params
                )
                db.execute(text("UPDATE users SET email = :email WHERE id = :id"), params)
            library_id = db.scalar(
                text("SELECT id FROM libraries WHERE owner_user_id = :id AND is_default"), params
            )
            if library_id is None:
                library_id = db.scalar(
                    text("""
                        INSERT INTO libraries (name, owner_user_id, is_default)
                        VALUES ('My Library', :id, true) RETURNING id
                    """),
                    params,
                )
            db.execute(
                text("""
                    INSERT INTO memberships (library_id, user_id, role)
                    VALUES (:library_id, :id, 'admin') ON CONFLICT DO NOTHING
                """),
                {**params, "library_id": library_id},
            )

    retry_serializable(db, "default_library_bootstrap", attempt)
