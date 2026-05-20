"""Single-use handoff codes that move a Supabase session into the Android WebView."""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import delete, func
from sqlalchemy.orm import Session

from nexus.db.models import AuthHandoffCode

_CODE_PREFIX = "nx_hand_"


def create_auth_handoff_code(
    db: Session,
    user_id: UUID,
    access_token: str,
    refresh_token: str,
    challenge: str,
) -> str:
    code = f"{_CODE_PREFIX}{secrets.token_urlsafe(32)}"
    row = AuthHandoffCode(
        user_id=user_id,
        code_hash=_hash(code),
        challenge=challenge.lower(),
        access_token=access_token,
        refresh_token=refresh_token,
        expires_at=datetime.now(UTC) + timedelta(seconds=90),  # 90s — bounds the handoff window
    )
    db.add(row)
    db.flush()
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
    result = db.execute(delete(AuthHandoffCode).where(AuthHandoffCode.expires_at <= func.now()))
    db.commit()
    return result.rowcount or 0


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
