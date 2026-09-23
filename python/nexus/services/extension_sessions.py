"""Revocable browser extension session tokens."""

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
from nexus.schemas.presence import presence_from_nullable
from nexus.services.sealed_handles import seal_user

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

    session.last_used_at = func.now()
    db.flush()
    return session.user_id


def describe_extension_session(db: Session, user_id: UUID) -> ExtensionSessionOut:
    """The account identity a bearer resolves to, and the capture byte limits."""
    row = db.execute(
        text("SELECT email, display_name FROM users WHERE id = :user_id"), {"user_id": user_id}
    ).one()
    settings = get_settings()
    return ExtensionSessionOut(
        user_handle=seal_user(user_id),
        email=presence_from_nullable(row.email),
        display_name=presence_from_nullable(row.display_name),
        limits=CaptureLimits(
            max_pdf_bytes=settings.max_pdf_bytes,
            max_epub_bytes=settings.max_epub_bytes,
            max_article_packet_bytes=ARTICLE_PACKET_MAX_BYTES,
        ),
    )


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

    session.revoked_at = func.now()
    db.commit()
    return True


def _hash_extension_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
