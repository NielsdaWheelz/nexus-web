"""Idempotency-key handling for chat runs: hashing, lookup, mismatch, and advisory locking."""

from __future__ import annotations

import hashlib
import json
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.schemas.chat_reader_selection import ReaderSelectionKey
from nexus.schemas.conversation import AcceptedChatAdmission, ChatAdmissionReceipt, ChatDestination
from nexus.services.generation_selection import CodexPersonalSelection, ProviderApiSelection
from nexus.services.resource_mutation_replay import lookup_replay, record_replay

CHAT_ADMISSION_SCOPE = "chat:admission"

type ChatGenerationSelection = CodexPersonalSelection | ProviderApiSelection
type ChatToolAuthority = Literal["ReadOnly", "AdditiveWrites"]

logger = get_logger(__name__)


def chat_run_request_bytes(
    *,
    destination: ChatDestination,
    content: str,
    catalog_definition_revision: str,
    selection: ChatGenerationSelection,
    tool_authority: ChatToolAuthority,
    reader_selection_key: ReaderSelectionKey | None,
) -> bytes:
    """Canonical send-idempotency bytes over answer-determining identity only.

    Uses the canonical destination/insertion, content, complete exact generation
    selection and authority, and the durable ``ReaderSelectionKey``. It never hashes the live
    ``ReaderSelectionRevision`` or any live-resolved quote field — the server
    re-resolves and snapshots under the Highlight row lock at send, so hashing
    those would create false replay mismatches (breaking replay-after-source-
    change). Tagged unions serialize as canonical JSON; keys are sorted and
    UUIDs are lowercase-hyphenated before SHA-256.
    """
    payload = {
        "destination": destination.model_dump(mode="json"),
        "content": content,
        "catalog_definition_revision": catalog_definition_revision,
        "selection": selection.model_dump(mode="json"),
        "tool_authority": tool_authority,
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
    return encoded.encode("utf-8")


def candidate_request_bytes(
    *,
    operation: Literal["rerun", "regenerate"],
    source_assistant_message_id: UUID,
    catalog_definition_revision: str,
    selection: ChatGenerationSelection,
    tool_authority: Literal["ReadOnly"],
) -> bytes:
    """Immutable incoming candidate identity, independent of deletable rows.

    The source assistant ID names the frozen source turn. Source prompt/branch
    facts are validated only on first admission, not reconstructed for replay.
    """
    payload = {
        "operation": operation,
        "source_assistant_message_id": str(source_assistant_message_id),
        "catalog_definition_revision": catalog_definition_revision,
        "selection": selection.model_dump(mode="json"),
        "tool_authority": tool_authority,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return encoded.encode("utf-8")


def normalize_idempotency_key(idempotency_key: str | None) -> str:
    normalized_key = (idempotency_key or "").strip()
    if not normalized_key:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is required")
    if len(normalized_key) > 128:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is too long")
    return normalized_key


def lookup_chat_admission(
    db: Session, *, viewer_id: UUID, idempotency_key: str, request_bytes: bytes
) -> ChatAdmissionReceipt | None:
    stored = lookup_replay(
        db,
        viewer_id=viewer_id,
        scope=CHAT_ADMISSION_SCOPE,
        client_mutation_id=hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest(),
        request_bytes=request_bytes,
    )
    if stored is None:
        return None
    receipt = ChatAdmissionReceipt.model_validate(stored)
    # justify-defect: the indexed operation identity and its immutable receipt
    # are written atomically; inconsistent persisted identity cannot be replayed.
    if receipt.idempotency_key != idempotency_key:
        raise AssertionError("chat admission receipt identity differs from its ledger key")
    return receipt


def accepted_chat_admission(run: ChatRun, idempotency_key: str) -> ChatAdmissionReceipt:
    return ChatAdmissionReceipt(
        idempotency_key=idempotency_key,
        outcome=AcceptedChatAdmission(
            conversation_id=run.conversation_id,
            run_id=run.id,
            assistant_message_id=run.assistant_message_id,
        ),
    )


def record_chat_admission(
    db: Session, *, viewer_id: UUID, request_bytes: bytes, receipt: ChatAdmissionReceipt
) -> None:
    record_replay(
        db,
        viewer_id=viewer_id,
        scope=CHAT_ADMISSION_SCOPE,
        client_mutation_id=hashlib.sha256(receipt.idempotency_key.encode("utf-8")).hexdigest(),
        request_bytes=request_bytes,
        response_json=receipt.model_dump(mode="json"),
        changed_lanes={},
    )


def log_chat_admission(receipt: ChatAdmissionReceipt, *, viewer_id: UUID, replayed: bool) -> None:
    """Correlate a committed decision without exposing opaque caller input."""
    outcome = receipt.outcome
    logger.info(
        "chat.admission.decided",
        viewer_id=str(viewer_id),
        command_key_sha256=hashlib.sha256(receipt.idempotency_key.encode("utf-8")).hexdigest(),
        decision=outcome.kind,
        replayed=replayed,
        run_id=str(outcome.run_id) if isinstance(outcome, AcceptedChatAdmission) else None,
        rejection_code=outcome.reason.code
        if not isinstance(outcome, AcceptedChatAdmission)
        else None,
    )


def lock_idempotency_key(db: Session, viewer_id: UUID, idempotency_key: str) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": f"chat_run:{viewer_id}:{idempotency_key}"},
    )
