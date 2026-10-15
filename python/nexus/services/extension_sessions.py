"""Extension sessions: a revocable bearer (``nx_ext_…``, stored as its sha256) that
authorizes only its own session route and ``/extension/*`` (I6)."""

from __future__ import annotations

import hashlib
import secrets
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import ExtensionSession
from nexus.schemas.extension_capture import (
    ARTICLE_PACKET_MAX_BYTES,
    CaptureLimits,
    ExtensionSessionOut,
)

_PREFIX = "nx_ext_"


def create_extension_session(db: Session, user_id: UUID) -> tuple[ExtensionSession, str]:
    token = f"{_PREFIX}{secrets.token_urlsafe(32)}"
    session = ExtensionSession(user_id=user_id, token_hash=_hash(token))
    db.add(session)
    db.commit()
    db.refresh(session)
    return session, token


def resolve_extension_session_user(db: Session, token: str) -> UUID | None:
    session = _live(db, token)
    if session is None:
        return None
    session.last_used_at = func.now()
    db.flush()
    return session.user_id


def describe_extension_session(db: Session, user_id: UUID) -> ExtensionSessionOut:
    row = db.execute(
        text("SELECT email, display_name FROM users WHERE id = :id"), {"id": user_id}
    ).one()
    settings = get_settings()
    return ExtensionSessionOut(
        user_id=user_id,
        email=row.email,
        display_name=row.display_name,
        limits=CaptureLimits(
            max_pdf_bytes=settings.max_pdf_bytes,
            max_epub_bytes=settings.max_epub_bytes,
            max_article_packet_bytes=ARTICLE_PACKET_MAX_BYTES,
        ),
    )


def revoke_extension_session_token(db: Session, token: str) -> bool:
    session = _live(db, token)
    if session is None:
        return False
    session.revoked_at = func.now()
    db.commit()
    return True


def _live(db: Session, token: str) -> ExtensionSession | None:
    if not token.startswith(_PREFIX):
        return None
    return db.scalar(
        select(ExtensionSession).where(
            ExtensionSession.token_hash == _hash(token), ExtensionSession.revoked_at.is_(None)
        )
    )


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()
