"""Rerun a terminal chat run's assistant turn.

The single replacement for the old retry/resend pair (§10): one verb, one
route, one eligibility policy (`chat_failure.rerun_eligibility`), which this
module re-evaluates against freshly queried facts inside the rerun
transaction — an earlier read's `can_rerun` is never authority for the
mutation itself.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ChatRunTurnContext, Conversation, Message
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.jobs.queue import enqueue_job
from nexus.schemas.conversation import ChatRunResponse
from nexus.services.chat_failure import (
    compute_has_write_tool_attempt,
    profile_selection_active,
    rerun_eligibility,
)
from nexus.services.chat_run_event_store import ChatRunEventEmitter
from nexus.services.chat_run_idempotency import (
    compute_rerun_payload_hash,
    get_run_by_idempotency_key,
    lock_idempotency_key,
    normalize_idempotency_key,
    raise_if_payload_mismatch,
)
from nexus.services.chat_run_message_blocks import message_document
from nexus.services.chat_run_response import build_chat_run_response
from nexus.services.conversation_branches import ensure_branch_metadata, persist_active_leaf
from nexus.services.llm_profiles import LlmProfile
from nexus.services.llm_profiles import profile as lookup_profile
from nexus.services.seq import assign_next_message_seq


def rerun_assistant_response(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
    idempotency_key: str | None,
) -> ChatRunResponse:
    normalized_key = normalize_idempotency_key(idempotency_key)
    try:
        lock_idempotency_key(db, viewer_id, normalized_key)

        assistant_message = db.get(Message, assistant_message_id)
        if assistant_message is None or assistant_message.role != "assistant":
            raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
        conversation = db.get(Conversation, assistant_message.conversation_id)
        if conversation is None or conversation.owner_user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")

        source_run = _load_source_run(db, viewer_id=viewer_id, assistant_message=assistant_message)
        source_user_message = db.get(Message, source_run.user_message_id)
        if source_user_message is None or source_user_message.role != "user":
            raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Rerun source prompt not found")

        payload_hash = compute_rerun_payload_hash(
            source_assistant_message_id=assistant_message_id,
            source_run=source_run,
            source_user_message=source_user_message,
        )

        existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
        if existing is not None:
            raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
            db.commit()
            return build_chat_run_response(db, viewer_id, existing)

        _assert_rerun_eligible(db, source_run)
        assert source_run.profile_id is not None
        assert source_run.reasoning_option_id is not None

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

        assistant_rerun_message = Message(
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
        db.add(assistant_rerun_message)
        db.flush()
        persist_active_leaf(
            db,
            viewer_id=viewer_id,
            conversation_id=source_run.conversation_id,
            active_leaf_message_id=assistant_rerun_message.id,
        )

        run = ChatRun(
            owner_user_id=viewer_id,
            conversation_id=source_run.conversation_id,
            user_message_id=user_message.id,
            assistant_message_id=assistant_rerun_message.id,
            idempotency_key=normalized_key,
            payload_hash=payload_hash,
            status="queued",
            profile_id=source_run.profile_id,
            reasoning_option_id=source_run.reasoning_option_id,
        )
        db.add(run)
        db.flush()

        source_turn_context = db.get(ChatRunTurnContext, source_run.id)
        if source_turn_context is not None:
            db.add(
                ChatRunTurnContext(
                    chat_run_id=run.id,
                    requested_subject_scheme=source_turn_context.requested_subject_scheme,
                    requested_subject_id=source_turn_context.requested_subject_id,
                    subject_scheme=source_turn_context.subject_scheme,
                    subject_id=source_turn_context.subject_id,
                    subject_context_edge_id=source_turn_context.subject_context_edge_id,
                )
            )
        ChatRunEventEmitter(db, run).meta(
            {
                "run_id": str(run.id),
                "conversation_id": str(source_run.conversation_id),
                "user_message_id": str(user_message.id),
                "assistant_message_id": str(assistant_rerun_message.id),
                "profile_id": run.profile_id,
                "reasoning_option_id": run.reasoning_option_id,
                "chat_subject": None,
            }
        )
        enqueue_job(
            db,
            kind="chat_run",
            payload={"run_id": str(run.id)},
            priority=50,
            max_attempts=3,
            dedupe_key=f"chat_run:{run.id}",
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return build_chat_run_response(db, viewer_id, run)


def _load_source_run(db: Session, *, viewer_id: UUID, assistant_message: Message) -> ChatRun:
    run = (
        db.execute(
            select(ChatRun)
            .where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.assistant_message_id == assistant_message.id,
            )
            .order_by(ChatRun.created_at.desc(), ChatRun.id.desc())
        )
        .scalars()
        .first()
    )
    if run is None:
        raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Rerun source run not found")
    if run.conversation_id != assistant_message.conversation_id:
        raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Rerun source run is invalid")
    return run


def _assert_rerun_eligible(db: Session, source_run: ChatRun) -> None:
    """Re-evaluate `rerun_eligibility` against freshly queried facts — never
    trusting an earlier `can_rerun` read as authority for the mutation."""
    if source_run.profile_id is None or source_run.reasoning_option_id is None:
        raise ApiError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Assistant response has no resolved profile to rerun",
        )
    error_code = "cancelled" if source_run.status == "cancelled" else source_run.error_code
    if error_code is None:
        raise ApiError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Assistant response is not a terminal failed or cancelled run",
        )
    # Same drift-aware eligibility the projection uses (retired/uncertified/
    # changed profile, or a reasoning option no longer offered → not
    # rerunnable), re-evaluated here against freshly queried facts.
    active_profile = lookup_profile(source_run.profile_id)
    profile_active = profile_selection_active(source_run)
    has_write_tool_attempt = compute_has_write_tool_attempt(db, source_run)
    eligible = rerun_eligibility(
        error_code=error_code,
        run_status=source_run.status,
        profile_active=profile_active,
        has_write_tool_attempt=has_write_tool_attempt,
    )
    if not eligible:
        raise ApiError(ApiErrorCode.E_RETRY_NOT_ALLOWED, "Assistant response is not rerunnable")

    # Defense in depth (§10: "rerun never remaps a historical target"): the
    # projection compares the run's stored resolved-target snapshot, which a run
    # may not have recorded. The authoritative historical target lives on the
    # run's terminal `llm_calls` ledger row; if the current profile now resolves
    # to a different provider/model, the rerun would silently execute elsewhere.
    if active_profile is not None and _ledger_target_drifted(db, source_run, active_profile):
        raise ApiError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Assistant response's profile now resolves to a different target",
        )


def _ledger_target_drifted(db: Session, source_run: ChatRun, active_profile: LlmProfile) -> bool:
    """Whether the run's historical resolved target (its terminal `llm_calls`
    row's provider/model_name — always the logical target the plan resolved to)
    differs from what the current profile resolves to. No ledger row (a run that
    failed before any call) ⇒ no drift evidence."""
    row = db.execute(
        text(
            "SELECT provider, model_name FROM llm_calls "
            "WHERE owner_kind = 'chat_run' AND owner_id = :run_id "
            "ORDER BY call_seq DESC LIMIT 1"
        ),
        {"run_id": source_run.id},
    ).first()
    if row is None:
        return False
    provider, model_name = row
    if provider is not None and provider != active_profile.target.provider:
        return True
    if model_name is not None and model_name != active_profile.target.model:
        return True
    return False
