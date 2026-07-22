"""Idempotency-key handling for chat runs: hashing, lookup, mismatch, and advisory locking."""

from __future__ import annotations

import hashlib
import json
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.schemas.chat_reader_selection import ReaderSelectionKey
from nexus.schemas.conversation import ChatDestination
from nexus.services.redact import safe_kv

logger = get_logger(__name__)


def compute_payload_hash(
    *,
    destination: ChatDestination,
    content: str,
    profile_id: str,
    reasoning_option_id: str,
    reader_selection_key: ReaderSelectionKey | None,
) -> str:
    """Canonical send-idempotency digest over answer-determining identity only.

    Uses the canonical destination/insertion, content, complete profile
    selection, and the durable ``ReaderSelectionKey``. It never hashes the live
    ``ReaderSelectionRevision`` or any live-resolved quote field — the server
    re-resolves and snapshots under the Highlight row lock at send, so hashing
    those would create false replay mismatches (breaking replay-after-source-
    change). Tagged unions serialize as canonical JSON; keys are sorted and
    UUIDs are lowercase-hyphenated before SHA-256.
    """
    payload = {
        "destination": destination.model_dump(mode="json"),
        "content": content,
        "profile_id": profile_id,
        "reasoning_option_id": reasoning_option_id,
        "reader_selection_key": (
            {
                "media_id": str(reader_selection_key.media_id),
                "highlight_id": str(reader_selection_key.highlight_id),
            }
            if reader_selection_key is not None
            else None
        ),
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def compute_rerun_payload_hash(
    *,
    source_assistant_message_id: UUID,
    source_run: ChatRun,
    source_user_message: Message,
) -> str:
    payload = {
        "operation": "chat_response_rerun",
        "source_assistant_message_id": str(source_assistant_message_id),
        "source_run_id": str(source_run.id),
        "source_conversation_id": str(source_run.conversation_id),
        "source_user_message_id": str(source_user_message.id),
        "source_user_parent_message_id": (
            str(source_user_message.parent_message_id)
            if source_user_message.parent_message_id is not None
            else None
        ),
        "source_user_branch_root_message_id": (
            str(source_user_message.branch_root_message_id)
            if source_user_message.branch_root_message_id is not None
            else None
        ),
        "source_user_branch_anchor_kind": source_user_message.branch_anchor_kind,
        "source_user_branch_anchor": source_user_message.branch_anchor or {},
        "source_prompt_content": source_user_message.content,
        "source_profile_id": source_run.profile_id,
        "source_reasoning_option_id": source_run.reasoning_option_id,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


def normalize_idempotency_key(idempotency_key: str | None) -> str:
    normalized_key = (idempotency_key or "").strip()
    if not normalized_key:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is required")
    if len(normalized_key) > 128:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is too long")
    return normalized_key


def get_run_by_idempotency_key(
    db: Session, viewer_id: UUID, idempotency_key: str
) -> ChatRun | None:
    return (
        db.execute(
            select(ChatRun).where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.idempotency_key == idempotency_key,
            )
        )
        .scalars()
        .first()
    )


def raise_if_payload_mismatch(
    run: ChatRun,
    payload_hash: str,
    viewer_id: UUID,
    idempotency_key: str,
) -> None:
    if run.payload_hash == payload_hash:
        return
    logger.warning(
        "chat_run.idempotency_mismatch",
        **safe_kv(idempotency_key=idempotency_key, viewer_id=str(viewer_id)),
    )
    raise ApiError(
        ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
        "Idempotency key reused with different payload",
    )


def lock_idempotency_key(db: Session, viewer_id: UUID, idempotency_key: str) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": f"chat_run:{viewer_id}:{idempotency_key}"},
    )
