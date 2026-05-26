"""Idempotency-key handling for chat runs: hashing, lookup, mismatch, and advisory locking."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message, MessageContextItem
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.schemas.conversation import (
    BranchAnchorRequest,
    ContextItem,
)
from nexus.services.redact import safe_kv

logger = get_logger(__name__)


def compute_payload_hash(
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    contexts: Sequence[ContextItem],
    conversation_id: UUID,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
) -> str:
    sorted_contexts = sorted(
        (ctx.model_dump(mode="json") for ctx in contexts),
        key=lambda payload: json.dumps(payload, sort_keys=True, separators=(",", ":")),
    )
    payload_anchor = branch_anchor.model_dump(mode="json")
    payload = (
        f"{conversation_id}|{parent_message_id}|{payload_anchor}|{content}|{model_id}|{reasoning}|"
        f"{key_mode}|{sorted_contexts}|"
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def compute_retry_payload_hash(
    *,
    failed_assistant_message_id: UUID,
    source_run: ChatRun,
    source_user_message: Message,
    context_rows: Sequence[MessageContextItem],
) -> str:
    contexts = [
        {
            "id": str(row.id),
            "ordinal": row.ordinal,
            "context_kind": row.context_kind,
            "object_type": row.object_type,
            "object_id": str(row.object_id) if row.object_id is not None else None,
            "source_media_id": str(row.source_media_id) if row.source_media_id else None,
            "locator_json": row.locator_json,
            "context_snapshot": row.context_snapshot_json,
        }
        for row in context_rows
    ]
    payload = {
        "operation": "chat_response_retry",
        "failed_assistant_message_id": str(failed_assistant_message_id),
        "source_run_id": str(source_run.id),
        "source_conversation_id": str(source_run.conversation_id),
        "source_user_message_id": str(source_user_message.id),
        "source_user_parent_message_id": (
            str(source_user_message.parent_message_id)
            if source_user_message.parent_message_id is not None
            else None
        ),
        "source_prompt_content": source_user_message.content,
        "source_model_id": str(source_run.model_id),
        "source_reasoning": source_run.reasoning,
        "source_key_mode": source_run.key_mode,
        "source_contexts": contexts,
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
