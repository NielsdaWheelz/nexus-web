"""Revocable browser extension session tokens."""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ExtensionSession

_TOKEN_PREFIX = "nx_ext_"


def create_extension_session(
    db: Session,
    user_id: UUID,
) -> tuple[ExtensionSession, str]:
    token = f"{_TOKEN_PREFIX}{secrets.token_urlsafe(32)}"
    session = ExtensionSession(user_id=user_id, token_hash=_hash_extension_token(token))
    db.add(session)
    db.flush()
    db.refresh(session)
    db.commit()
    return session, token


def resolve_extension_session_user(db: Session, token: str) -> UUID | None:
    if not token.startswith(_TOKEN_PREFIX):
        return None

    session = db.execute(
        select(ExtensionSession).where(
            ExtensionSession.token_hash == _hash_extension_token(token),
            ExtensionSession.revoked_at.is_(None),
        )
    ).scalar_one_or_none()
    if session is None:
        return None

    session.last_used_at = datetime.now(UTC)
    db.flush()
    return session.user_id


def revoke_extension_session_token(db: Session, token: str) -> bool:
    if not token.startswith(_TOKEN_PREFIX):
        return False

    session = db.execute(
        select(ExtensionSession).where(
            ExtensionSession.token_hash == _hash_extension_token(token),
            ExtensionSession.revoked_at.is_(None),
        )
    ).scalar_one_or_none()
    if session is None:
        return False

    session.revoked_at = datetime.now(UTC)
    db.commit()
    return True


def _hash_extension_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
