"""Exact-selection sibling candidates for terminal Chat answers."""

from __future__ import annotations

from typing import Literal
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ChatRunTurnContext, Conversation, Message
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.jobs.queue import enqueue_job, lock_chat_generation_admission_in_current_transaction
from nexus.schemas.conversation import AcceptedChatAdmission, ChatRunResponse
from nexus.services import generation_policy
from nexus.services.chat_failure import rerun_eligibility
from nexus.services.chat_run_event_store import ChatRunEventEmitter
from nexus.services.chat_run_idempotency import (
    accepted_chat_admission,
    candidate_request_bytes,
    lock_idempotency_key,
    log_chat_admission,
    lookup_chat_admission,
    normalize_idempotency_key,
    record_chat_admission,
)
from nexus.services.chat_run_message_blocks import message_document
from nexus.services.chat_run_response import read_chat_run_response
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
    request_bytes = candidate_request_bytes(
        operation=operation,
        source_assistant_message_id=assistant_message_id,
        catalog_definition_revision=catalog_definition_revision,
        selection=selection,
        tool_authority=tool_authority,
    )
    try:
        lock_idempotency_key(db, viewer_id, normalized_key)
        receipt = lookup_chat_admission(
            db, viewer_id=viewer_id, idempotency_key=normalized_key, request_bytes=request_bytes
        )
    finally:
        db.rollback()
    if receipt is not None:
        if not isinstance(receipt.outcome, AcceptedChatAdmission):
            raise AssertionError("candidate admission has a rejected receipt")
        log_chat_admission(receipt, viewer_id=viewer_id, replayed=True)
        snapshot = await catalog.read_chat()
        return read_chat_run_response(
            db, viewer_id, receipt.outcome.run_id, catalog_snapshot=snapshot
        )

    pair: ResolvedCatalogPair | None = None
    catalog_error: ApiError | None = None
    try:
        pair = await admit_chat_selection(
            catalog,
            catalog_definition_revision=catalog_definition_revision,
            selection=selection,
        )
    except ApiError as exc:
        catalog_error = exc
    generation_service = GenerationService(
        catalog=catalog,
        policy=generation_policy.GENERATION_POLICY,
        tools=tool_runtime,
    )
    try:
        lock_chat_generation_admission_in_current_transaction(db)
        lock_idempotency_key(db, viewer_id, normalized_key)
        receipt = lookup_chat_admission(
            db, viewer_id=viewer_id, idempotency_key=normalized_key, request_bytes=request_bytes
        )
        replayed = receipt is not None
        if receipt is None:
            if catalog_error is not None:
                raise catalog_error
            if pair is None:
                raise AssertionError("catalog admission lost its resolved selection")
            source_assistant, _, source_run, source_user = _resolve_source(
                db, viewer_id=viewer_id, assistant_message_id=assistant_message_id
            )
            _assert_repeat_eligible(operation, source_run, source_assistant)
            run = _create_sibling_candidate(
                db,
                viewer_id=viewer_id,
                source_run=source_run,
                source_user_message=source_user,
                catalog_definition_revision=catalog_definition_revision,
                pair=pair,
                generation_service=generation_service,
            )
            receipt = accepted_chat_admission(run, normalized_key)
            record_chat_admission(
                db, viewer_id=viewer_id, request_bytes=request_bytes, receipt=receipt
            )
        if not isinstance(receipt.outcome, AcceptedChatAdmission):
            raise AssertionError("candidate admission has a rejected receipt")
        run_id = receipt.outcome.run_id
        db.commit()
    except Exception:
        db.rollback()
        raise
    log_chat_admission(receipt, viewer_id=viewer_id, replayed=replayed)
    snapshot = await catalog.read_chat()
    return read_chat_run_response(db, viewer_id, run_id, catalog_snapshot=snapshot)


def _resolve_source(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
) -> tuple[Message, Conversation, ChatRun, Message]:
    # Source deletion takes the same parent lock. Once first admission resolves
    # its source, deletion cannot invalidate its snapshot before publication.
    conversation = db.scalar(
        select(Conversation)
        .join(Message, Message.conversation_id == Conversation.id)
        .where(
            Message.id == assistant_message_id,
            Message.role == "assistant",
            Conversation.owner_user_id == viewer_id,
        )
        .with_for_update(of=Conversation)
    )
    if conversation is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    assistant_message = db.get(Message, assistant_message_id)
    if assistant_message is None:
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
    catalog_definition_revision: str,
    pair: ResolvedCatalogPair,
    generation_service: GenerationService,
) -> ChatRun:
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
    return run


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
