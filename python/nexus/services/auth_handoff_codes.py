"""Single-use handoff codes that move a Supabase session into the Android WebView."""

from __future__ import annotations

import hashlib
import secrets
from uuid import UUID

from sqlalchemy import delete, func, insert, text
from sqlalchemy.orm import Session

from nexus.db.models import AuthHandoffCode

_CODE_PREFIX = "nx_hand_"
_CODE_TTL_INTERVAL = text("interval '90 seconds'")


def create_auth_handoff_code(
    db: Session,
    user_id: UUID,
    access_token: str,
    refresh_token: str,
    challenge: str,
) -> str:
    code = f"{_CODE_PREFIX}{secrets.token_urlsafe(32)}"
    db.execute(
        insert(AuthHandoffCode).values(
            user_id=user_id,
            code_hash=_hash(code),
            challenge=challenge.lower(),
            access_token=access_token,
            refresh_token=refresh_token,
            expires_at=func.now() + _CODE_TTL_INTERVAL,
        )
    )
    db.commit()
    return code


def consume_auth_handoff_code(db: Session, code: str, verifier: str) -> tuple[str, str] | None:
    if not code.startswith(_CODE_PREFIX):
        return None

    row = db.execute(
        delete(AuthHandoffCode)
        .where(
            AuthHandoffCode.code_hash == _hash(code),
            AuthHandoffCode.challenge == _hash(verifier),
            AuthHandoffCode.expires_at > func.now(),
        )
        .returning(AuthHandoffCode.access_token, AuthHandoffCode.refresh_token)
    ).first()
    db.commit()
    if row is None:
        return None
    return row.access_token, row.refresh_token


def purge_expired_auth_handoff_codes(db: Session) -> int:
    deleted_ids = (
        db.execute(
            delete(AuthHandoffCode)
            .where(AuthHandoffCode.expires_at <= func.now())
            .returning(AuthHandoffCode.id)
        )
        .scalars()
        .all()
    )
    db.commit()
    return len(deleted_ids)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
