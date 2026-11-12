"""One immutable account turn per client uuid; replays acknowledge its receipt.

The account state owns sequence and deletion ordering. Only the first unsettled
turn has a job. Context is resolved when that job begins, never frozen here.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import cast, get_args
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from nexus.db.models import ChatRun, Message
from nexus.db.retries import TransactionRestart, integrity_constraint_name, retry_serializable
from nexus.db.session import (
    get_control_session_factory,
    get_repeatable_read_db,
    get_session_factory,
)
from nexus.errors import ApiError, ApiErrorCode, ConflictError, NotFoundError
from nexus.jobs.queue import jobs_for_payload
from nexus.schemas.chat import (
    MAX_MESSAGE_CONTENT_LENGTH,
    AcceptedChatAdmission,
    ChatAdmissionReceipt,
    ChatAdmissionRejection,
    ChatRunCreateRequest,
    ChatRunResponse,
    RejectedChatAdmission,
    RejectionCode,
)
from nexus.schemas.live_reference import LiveReference
from nexus.schemas.llm import (
    GenerationSelection,
    GenerationSelectionUnavailable,
    Ineligible,
    InvalidGenerationSelection,
)
from nexus.services.chat import deletion, events, reads, selection
from nexus.services.generation.catalog import (
    Catalog,
    InvalidSelection,
    Row,
    SelectionUnavailable,
    chat_budgets,
    chat_row,
)
from nexus.services.generation.contract import GenerationSpec
from nexus.services.generation.ledger import lock_generation_owner
from nexus.services.generation.policy import chat_tool_plan
from nexus.services.search import projection
from nexus.services.suggestion_changes import record_input_change
from nexus.services.tools.run import Toolbox

_REJECTABLE = frozenset(get_args(RejectionCode))


async def create_chat_run(
    *,
    viewer_id: UUID,
    request: ChatRunCreateRequest,
    idempotency_key: str | None,
    catalog: Catalog,
    tools: Toolbox,
) -> ChatAdmissionReceipt:
    run_id = _run_id(idempotency_key)
    existing = await run_in_threadpool(_existing_run, viewer_id, run_id)
    if existing is not None:
        return ChatAdmissionReceipt(outcome=existing)
    row = await _catalog_row(catalog, request.selection)

    def build(db: Session, resolved: Row | ApiError) -> ChatRun:
        deletion.require_revision(db, viewer_id, request.expected_deletion_revision)
        if isinstance(resolved, ApiError):
            raise resolved
        if len(request.content) > MAX_MESSAGE_CONTENT_LENGTH:
            raise ApiError(
                ApiErrorCode.E_MESSAGE_TOO_LONG,
                f"Message exceeds {MAX_MESSAGE_CONTENT_LENGTH} character limit",
            )
        return _insert(
            db, viewer_id, run_id, request.content, request.attachments, resolved, tools, None
        )

    return await run_in_threadpool(_settle, viewer_id, run_id, row, build)


async def retry(
    *,
    viewer_id: UUID,
    source_run_id: UUID,
    selection: GenerationSelection,
    expected_deletion_revision: str,
    idempotency_key: str | None,
    catalog: Catalog,
    tools: Toolbox,
) -> ChatAdmissionReceipt:
    run_id = _run_id(idempotency_key)
    existing = await run_in_threadpool(_existing_run, viewer_id, run_id)
    if existing is not None:
        return ChatAdmissionReceipt(outcome=existing)
    row = await _catalog_row(catalog, selection)

    def build(db: Session, resolved: Row | ApiError) -> ChatRun:
        deletion.require_revision(db, viewer_id, expected_deletion_revision)
        source = reads.require_run(db, viewer_id=viewer_id, run_id=source_run_id)
        if not reads.can_retry(source):
            raise ApiError(
                ApiErrorCode.E_RETRY_NOT_ALLOWED, "Only failed or cancelled turns can be retried"
            )
        if isinstance(resolved, ApiError):
            raise resolved
        question = db.get_one(Message, source.user_message_id)
        return _insert(
            db,
            viewer_id,
            run_id,
            question.content,
            [LiveReference.model_validate(value) for value in question.attachments],
            resolved,
            tools,
            source.id,
        )

    return await run_in_threadpool(_settle, viewer_id, run_id, row, build)


def cancel(*, viewer_id: UUID, run_id: UUID) -> ChatRunResponse:
    """Commit stop intent; a waiting turn has no provider and settles immediately."""
    with get_control_session_factory()() as db:

        def stop() -> None:
            run = events.lock_run(db, run_id)
            if run is None or run.owner_user_id != viewer_id:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")
            if run.status in events.TERMINAL:
                return
            if run.cancel_requested_at is None:
                run.cancel_requested_at = datetime.now(UTC)
                run.updated_at = datetime.now(UTC)
            jobs = jobs_for_payload(db, kind="chat_run", match={"run_id": str(run.id)})
            if not jobs:
                events.finalize(db, run, status="cancelled", content="")

        retry_serializable(db, "cancel_chat_run", stop)
    with get_session_factory()() as db:

        def settle_dead() -> None:
            lock_generation_owner(db, kind="chat_run", id=run_id)
            generations = db.execute(
                text(
                    "SELECT outcome FROM llm_calls WHERE owner_kind='chat_run' AND owner_id=:id ORDER BY generation_seq FOR UPDATE"
                ),
                {"id": run_id},
            ).all()
            run = events.lock_run(db, run_id)
            if run is None or run.owner_user_id != viewer_id or run.status in events.TERMINAL:
                return
            dead = jobs_for_payload(
                db, kind="chat_run", match={"run_id": str(run.id)}, statuses=("dead",), lock=True
            )
            if dead and all(row.outcome is not None for row in generations):
                events.finalize_dead(db, run)

        retry_serializable(db, "cancel_chat_run_settle", settle_dead)
        return reads.run_response(db, viewer_id=viewer_id, run_id=run_id)


def _run_id(raw: str | None) -> UUID:
    if not raw:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is required")
    try:
        return UUID(raw.strip())
    except ValueError:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key must be a uuid") from None


def _accepted(run: ChatRun) -> AcceptedChatAdmission:
    return AcceptedChatAdmission(
        run_id=run.id,
        user_message_id=run.user_message_id,
        assistant_message_id=run.assistant_message_id,
    )


def _existing_run(viewer_id: UUID, run_id: UUID) -> AcceptedChatAdmission | None:
    with get_session_factory()() as db:
        get_repeatable_read_db(db)
        run = db.get(ChatRun, run_id)
        if run is None:
            return None
        if run.owner_user_id != viewer_id:
            raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Run id is taken")
        return _accepted(run)


async def _catalog_row(catalog: Catalog, selected: GenerationSelection) -> Row | ApiError:
    try:
        return chat_row(await catalog.read(), selected)
    except InvalidSelection:
        failure = InvalidGenerationSelection(
            field="selection",
            explanation="The exact generation selection is not in the configured catalog.",
        )
        return ApiError(
            ApiErrorCode.E_INVALID_GENERATION_SELECTION,
            failure.explanation,
            details=failure.model_dump(mode="json"),
        )
    except SelectionUnavailable as error:
        if not isinstance(error.state, Ineligible):
            return ApiError(
                ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE,
                "The selected generation route is unavailable; retry the same command",
            )
        details = GenerationSelectionUnavailable(selection=error.selection, state=error.state)
        return ApiError(
            ApiErrorCode.E_GENERATION_SELECTION_UNAVAILABLE,
            "The exact generation selection is not currently runnable",
            details=details.model_dump(mode="json"),
        )


def _settle(
    viewer_id: UUID,
    run_id: UUID,
    row: Row | ApiError,
    build: Callable[[Session, Row | ApiError], ChatRun],
) -> ChatAdmissionReceipt:
    with get_session_factory()() as db:

        def attempt() -> ChatAdmissionReceipt:
            db.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                {"key": f"chat_admission:{run_id}"},
            )
            run = db.get(ChatRun, run_id)
            if run is not None and run.owner_user_id != viewer_id:
                raise ConflictError(ApiErrorCode.E_RESOURCE_CONFLICT, "Run id is taken")
            if run is None:
                try:
                    run = build(db, row)
                except IntegrityError as error:
                    if integrity_constraint_name(error) != "chat_runs_pkey":
                        raise
                    raise TransactionRestart("chat admission committed during lock wait") from error
            return ChatAdmissionReceipt(outcome=_accepted(run))

        try:
            return retry_serializable(db, "chat_admission", attempt)
        except ApiError as error:
            if error.code.value not in _REJECTABLE:
                raise
            return ChatAdmissionReceipt(
                outcome=RejectedChatAdmission(
                    reason=ChatAdmissionRejection(code=cast(RejectionCode, error.code.value))
                )
            )


def _insert(
    db: Session,
    viewer_id: UUID,
    run_id: UUID,
    content: str,
    attachments: list[LiveReference],
    row: Row,
    tools: Toolbox,
    retry_of_run_id: UUID | None,
) -> ChatRun:
    """The caller holds librarian_state. Pair, queue head and choice commit together."""
    context_budget, output_budget = chat_budgets(row)
    plan = chat_tool_plan(
        tools.memory_config,
        user_id=viewer_id,
        processors=row.presentation.processor_chain.processors,
    )
    if tools.plans[plan].unavailable():
        raise ApiError(
            ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE,
            "The selected generation route cannot run its complete tool plan",
        )
    spec = GenerationSpec(
        operation="chat",
        selection=row.selection,
        display_at_dispatch=row.presentation,
        tool_plan=plan,
        tool_scope=(),
        effect_mode="AdditiveWrites",
        context_budget_tokens=context_budget,
        output_budget_tokens=output_budget,
    )
    seq = db.execute(
        text(
            "UPDATE librarian_state SET next_seq=next_seq+2 WHERE user_id=:viewer RETURNING next_seq-2"
        ),
        {"viewer": viewer_id},
    ).scalar_one()
    user = Message(
        owner_user_id=viewer_id,
        seq=seq,
        role="user",
        content=content,
        attachments=[reference.model_dump(mode="json") for reference in attachments],
        status="complete",
    )
    assistant = Message(
        owner_user_id=viewer_id,
        seq=seq + 1,
        role="assistant",
        content="",
        attachments=[],
        status="pending",
    )
    db.add_all([user, assistant])
    db.flush()
    run = ChatRun(
        id=run_id,
        owner_user_id=viewer_id,
        user_message_id=user.id,
        assistant_message_id=assistant.id,
        retry_of_run_id=retry_of_run_id,
        status="queued",
        generation_spec=spec.model_dump(mode="json"),
    )
    db.add(run)
    db.flush()
    projection.refresh(db, "message", [user.id])
    if retry_of_run_id is None:
        record_input_change(db, owners=[f"message:{user.id}"])
    selection.remember(db, user_id=viewer_id, admitted=row)
    events.enqueue_head(db, viewer_id)
    return run
