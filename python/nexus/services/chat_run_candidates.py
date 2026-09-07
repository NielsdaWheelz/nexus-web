"""Exact-selection sibling candidates for terminal Chat answers."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ChatRunTurnContext, Conversation, Message
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.jobs.queue import enqueue_job, lock_chat_generation_admission_in_current_transaction
from nexus.schemas.conversation import ChatRunResponse
from nexus.services import generation_policy
from nexus.services.chat_failure import rerun_eligibility
from nexus.services.chat_run_event_store import ChatRunEventEmitter
from nexus.services.chat_run_idempotency import (
    compute_regeneration_payload_hash,
    compute_rerun_payload_hash,
    get_run_by_idempotency_key,
    lock_idempotency_key,
    normalize_idempotency_key,
    raise_if_payload_mismatch,
)
from nexus.services.chat_run_message_blocks import message_document
from nexus.services.chat_run_response import build_chat_run_response
from nexus.services.chat_run_selection import run_selection_out
from nexus.services.chat_runs import (
    ExactChatSelection,
    admit_chat_selection,
    persist_frozen_chat_admission_in_current_transaction,
)
from nexus.services.conversation_branches import ensure_branch_metadata, persist_active_leaf
from nexus.services.generation_catalog import GenerationCatalogService, ResolvedCatalogPair
from nexus.services.generation_service import GenerationService
from nexus.services.seq import assign_next_message_seq
from nexus.services.tool_runtime.composition import ComposedToolRuntime

type RepeatOperation = Literal["rerun", "regenerate"]


async def rerun_assistant_response(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
    catalog_definition_revision: str,
    selection: ExactChatSelection,
    tool_authority: Literal["ReadOnly"],
    idempotency_key: str | None,
    catalog: GenerationCatalogService,
    tool_runtime: ComposedToolRuntime,
) -> ChatRunResponse:
    return await _repeat_assistant_response(
        db,
        operation="rerun",
        viewer_id=viewer_id,
        assistant_message_id=assistant_message_id,
        catalog_definition_revision=catalog_definition_revision,
        selection=selection,
        tool_authority=tool_authority,
        idempotency_key=idempotency_key,
        catalog=catalog,
        tool_runtime=tool_runtime,
    )


async def regenerate_assistant_response(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
    catalog_definition_revision: str,
    selection: ExactChatSelection,
    tool_authority: Literal["ReadOnly"],
    idempotency_key: str | None,
    catalog: GenerationCatalogService,
    tool_runtime: ComposedToolRuntime,
) -> ChatRunResponse:
    return await _repeat_assistant_response(
        db,
        operation="regenerate",
        viewer_id=viewer_id,
        assistant_message_id=assistant_message_id,
        catalog_definition_revision=catalog_definition_revision,
        selection=selection,
        tool_authority=tool_authority,
        idempotency_key=idempotency_key,
        catalog=catalog,
        tool_runtime=tool_runtime,
    )


async def _repeat_assistant_response(
    db: Session,
    *,
    operation: RepeatOperation,
    viewer_id: UUID,
    assistant_message_id: UUID,
    catalog_definition_revision: str,
    selection: ExactChatSelection,
    tool_authority: Literal["ReadOnly"],
    idempotency_key: str | None,
    catalog: GenerationCatalogService,
    tool_runtime: ComposedToolRuntime,
) -> ChatRunResponse:
    normalized_key = normalize_idempotency_key(idempotency_key)
    source_assistant, _, source_run, source_user = _resolve_source(
        db,
        viewer_id=viewer_id,
        assistant_message_id=assistant_message_id,
    )
    payload_hash = _repeat_payload_hash(
        operation=operation,
        assistant_message_id=assistant_message_id,
        source_run=source_run,
        source_user=source_user,
        catalog_definition_revision=catalog_definition_revision,
        selection=selection,
        tool_authority=tool_authority,
    )
    existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
    if existing is not None:
        raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
        existing_id = existing.id
        db.rollback()
        snapshot = await catalog.read_chat()
        replay = db.get(ChatRun, existing_id)
        if replay is None or replay.owner_user_id != viewer_id:
            raise AssertionError("idempotent Chat candidate disappeared")
        return build_chat_run_response(
            db,
            viewer_id,
            replay,
            run_selection=run_selection_out(replay, catalog_snapshot=snapshot),
        )
    _assert_repeat_eligible(operation, source_run, source_assistant)

    # Catalog/readiness I/O never spans a database transaction. The mutation
    # transaction below re-resolves every source authority fact.
    db.rollback()
    pair = await admit_chat_selection(
        catalog,
        catalog_definition_revision=catalog_definition_revision,
        selection=selection,
    )
    generation_service = GenerationService(
        catalog=catalog,
        policy=generation_policy.GENERATION_POLICY,
        tools=tool_runtime,
    )

    try:
        lock_chat_generation_admission_in_current_transaction(db)
        lock_idempotency_key(db, viewer_id, normalized_key)
        source_assistant, _, source_run, source_user = _resolve_source(
            db,
            viewer_id=viewer_id,
            assistant_message_id=assistant_message_id,
        )
        payload_hash = _repeat_payload_hash(
            operation=operation,
            assistant_message_id=assistant_message_id,
            source_run=source_run,
            source_user=source_user,
            catalog_definition_revision=catalog_definition_revision,
            selection=selection,
            tool_authority=tool_authority,
        )
        existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
        if existing is not None:
            raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
            db.commit()
            return build_chat_run_response(
                db,
                viewer_id,
                existing,
                run_selection=run_selection_out(
                    existing,
                    pair=pair,
                    observed_at=datetime.now(UTC),
                ),
            )
        _assert_repeat_eligible(operation, source_run, source_assistant)
        return _create_sibling_candidate(
            db,
            viewer_id=viewer_id,
            source_run=source_run,
            source_user_message=source_user,
            normalized_key=normalized_key,
            payload_hash=payload_hash,
            catalog_definition_revision=catalog_definition_revision,
            pair=pair,
            generation_service=generation_service,
        )
    except Exception:
        db.rollback()
        raise


def _repeat_payload_hash(
    *,
    operation: RepeatOperation,
    assistant_message_id: UUID,
    source_run: ChatRun,
    source_user: Message,
    catalog_definition_revision: str,
    selection: ExactChatSelection,
    tool_authority: Literal["ReadOnly"],
) -> str:
    compute = (
        compute_rerun_payload_hash if operation == "rerun" else compute_regeneration_payload_hash
    )
    return compute(
        source_assistant_message_id=assistant_message_id,
        source_run=source_run,
        source_user_message=source_user,
        catalog_definition_revision=catalog_definition_revision,
        selection=selection,
        tool_authority=tool_authority,
    )


def _resolve_source(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
) -> tuple[Message, Conversation, ChatRun, Message]:
    assistant_message = db.get(Message, assistant_message_id)
    if assistant_message is None or assistant_message.role != "assistant":
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    conversation = db.get(Conversation, assistant_message.conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    owning_runs = list(
        db.scalars(
            select(ChatRun).where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.assistant_message_id == assistant_message_id,
            )
        )
    )
    if len(owning_runs) != 1:
        raise AssertionError(
            f"assistant message {assistant_message_id} maps to {len(owning_runs)} Chat runs"
        )
    source_run = owning_runs[0]
    source_user_message = db.get(Message, source_run.user_message_id)
    if source_user_message is None or source_user_message.role != "user":
        raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Source prompt not found")
    return assistant_message, conversation, source_run, source_user_message


def _create_sibling_candidate(
    db: Session,
    *,
    viewer_id: UUID,
    source_run: ChatRun,
    source_user_message: Message,
    normalized_key: str,
    payload_hash: str,
    catalog_definition_revision: str,
    pair: ResolvedCatalogPair,
    generation_service: GenerationService,
) -> ChatRunResponse:
    user_message = Message(
        conversation_id=source_run.conversation_id,
        seq=assign_next_message_seq(db, source_run.conversation_id),
        role="user",
        content=source_user_message.content,
        message_document=message_document("user", source_user_message.content),
        status="complete",
        parent_message_id=source_user_message.parent_message_id,
        branch_root_message_id=source_user_message.branch_root_message_id,
        branch_anchor_kind=source_user_message.branch_anchor_kind,
        branch_anchor=dict(source_user_message.branch_anchor or {}),
        reader_selection_snapshot=(
            dict(source_user_message.reader_selection_snapshot)
            if source_user_message.reader_selection_snapshot is not None
            else None
        ),
    )
    db.add(user_message)
    db.flush()
    if user_message.parent_message_id is not None:
        ensure_branch_metadata(
            db,
            conversation_id=source_run.conversation_id,
            branch_user_message_id=user_message.id,
        )
    assistant_message = Message(
        conversation_id=source_run.conversation_id,
        seq=assign_next_message_seq(db, source_run.conversation_id),
        role="assistant",
        content="",
        message_document=message_document("assistant", ""),
        status="pending",
        parent_message_id=user_message.id,
        branch_root_message_id=user_message.branch_root_message_id,
        branch_anchor_kind="none",
        branch_anchor={},
    )
    db.add(assistant_message)
    db.flush()
    persist_active_leaf(
        db,
        viewer_id=viewer_id,
        conversation_id=source_run.conversation_id,
        active_leaf_message_id=assistant_message.id,
    )

    run = ChatRun(
        id=uuid4(),
        owner_user_id=viewer_id,
        conversation_id=source_run.conversation_id,
        user_message_id=user_message.id,
        assistant_message_id=assistant_message.id,
        idempotency_key=normalized_key,
        payload_hash=payload_hash,
        status="queued",
    )
    source_context = db.get(ChatRunTurnContext, source_run.id)
    turn_context = (
        ChatRunTurnContext(
            chat_run_id=run.id,
            requested_subject_scheme=source_context.requested_subject_scheme,
            requested_subject_id=source_context.requested_subject_id,
            subject_scheme=source_context.subject_scheme,
            subject_id=source_context.subject_id,
            subject_context_edge_id=source_context.subject_context_edge_id,
        )
        if source_context is not None
        else None
    )
    spec, selection_out = persist_frozen_chat_admission_in_current_transaction(
        db,
        run=run,
        turn_context=turn_context,
        pair=pair,
        catalog_definition_revision=catalog_definition_revision,
        tool_authority="ReadOnly",
        generation_service=generation_service,
    )
    ChatRunEventEmitter(db, run).meta(
        {
            "run_id": str(run.id),
            "conversation_id": str(run.conversation_id),
            "user_message_id": str(user_message.id),
            "assistant_message_id": str(assistant_message.id),
            "run_selection": selection_out.model_dump(mode="python"),
            "chat_subject": None,
        }
    )
    enqueue_job(
        db,
        kind="chat_run",
        payload={
            "run_id": str(run.id),
            "generation_spec_fingerprint": spec.fingerprint,
        },
        priority=50,
        max_attempts=3,
        dedupe_key=f"chat_run:{run.id}",
    )
    db.commit()
    return build_chat_run_response(
        db,
        viewer_id,
        run,
        run_selection=selection_out,
    )


def _assert_repeat_eligible(
    operation: RepeatOperation,
    source_run: ChatRun,
    source_assistant_message: Message,
) -> None:
    if operation == "regenerate":
        if source_assistant_message.status == "complete" and source_run.status == "complete":
            return
        raise ApiError(
            ApiErrorCode.E_REGENERATION_NOT_ALLOWED,
            "Only a completed assistant answer can be regenerated",
        )
    error_code = "cancelled" if source_run.status == "cancelled" else source_run.error_code
    if error_code is not None and rerun_eligibility(
        error_code=error_code,
        run_status=source_run.status,
        selection_selectable=True,
    ):
        return
    raise ApiError(
        ApiErrorCode.E_RETRY_NOT_ALLOWED,
        "This assistant outcome cannot be rerun",
    )
