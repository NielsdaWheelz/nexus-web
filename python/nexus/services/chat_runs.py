"""Durable chat-run service.

 One chat send is one durable run. HTTP creates/cancels/reads runs; the worker
executes a typed ChatTools command through the Codex host and tails persisted
events for the stream route.
"""

from __future__ import annotations

import asyncio
import dataclasses
import time
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any, Literal, cast
from uuid import UUID, uuid4

from llm_tools import WebSearchProvider
from pydantic import JsonValue, SecretStr
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import Settings
from nexus.db.models import (
    ChatRun,
    ChatRunTurnContext,
    Conversation,
    ConversationActivePath,
    Message,
)
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    NotFoundError,
    exception_error_detail,
)
from nexus.jobs.queue import (
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    current_dead_job_for_payload,
    enqueue_job,
    lock_chat_generation_admission_in_current_transaction,
    requeue_dead_job,
)
from nexus.logging import get_logger, set_flow_id
from nexus.schemas import presence as owned_presence
from nexus.schemas.chat_reader_selection import ReaderSelectionInput
from nexus.schemas.conversation import (
    CHAT_RUN_STATUS_FILTER,
    BranchAnchorRequest,
    ChatDestination,
    ChatRunResponse,
    EmptyInsertion,
    ExistingChatDestination,
    NoBranchAnchorRequest,
    ReplyInsertion,
)
from nexus.services import generation_policy
from nexus.services.agent_tool_grants import issue_chat_generation_grant
from nexus.services.chat_reader_selection import (
    build_reader_selection_snapshot,
    compute_reader_selection_revision,
    encode_reader_selection_snapshot,
    reader_selection_out,
)
from nexus.services.chat_run_access import get_run_for_owner
from nexus.services.chat_run_citations import (
    DegradedCitations,
    PublishedCitations,
    persist_attached_citations,
    publish_chat_citations,
)
from nexus.services.chat_run_event_store import (
    TERMINAL_RUN_STATUSES,
    ChatRunEventEmitter,
    is_cancel_requested,
    lock_chat_run_for_update,
    mark_running,
)
from nexus.services.chat_run_finalize import (
    finalize_cancelled,
    finalize_run,
)
from nexus.services.chat_run_idempotency import (
    compute_payload_hash,
    get_run_by_idempotency_key,
    lock_idempotency_key,
    normalize_idempotency_key,
    raise_if_payload_mismatch,
)
from nexus.services.chat_run_message_prep import prepare_messages
from nexus.services.chat_run_prompt_tracking import reconcile_prompt_retrievals
from nexus.services.chat_run_response import build_chat_run_response
from nexus.services.chat_run_steps import (
    AssistantTurn,
    CancelledGeneration,
    ChatStepRuntime,
    ExpectedFailure,
    GenerationStepResultEnvelope,
    PreparedChatRun,
    PublicationRequest,
    PublicationStepResult,
    assistant_turn_result,
    chat_tool_profile_admission,
    decode_prepared,
    step_fingerprint,
    validate_chat_tool_profile,
)
from nexus.services.chat_run_validation import validate_pre_phase
from nexus.services.codex_generation_contract import (
    ChatOperation,
    GenerationCommand,
    GenerationFrame,
    GenerationTerminal,
    GenerationText,
    GenerationToolUse,
    GenerationUsageEvent,
    normalized_failure,
    request_fingerprint,
)
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_collection_revision,
)
from nexus.services.context_assembler import (
    assemble_chat_context,
    persist_prompt_assembly,
)
from nexus.services.conversations import DEFAULT_CONVERSATION_TITLE
from nexus.services.durable_step_journal import (
    Completed,
    Prepared,
    ReplayPolicy,
    StepReplayState,
    decode_step_result,
    encode_step_result,
    stable_generation_id,
)
from nexus.services.generation_intent import BearerToolGrant
from nexus.services.llm_execution import (
    EncodedGenerationTerminal,
    ExecutionRuntime,
    GenerationExecutionRequest,
    JobGenerationJournal,
    execute_generation,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.prompt_budget import ContextBudgetError
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.redact import safe_kv
from nexus.services.resource_graph.context import (
    add_context_ref_without_commit,
    list_context_refs,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.tool_runtime.composition import (
    FrozenToolOperation,
    compose_product_tool_runtime,
)

logger = get_logger(__name__)


CHAT_TEXT_FLUSH_INTERVAL_MS = 33
CHAT_TEXT_FLUSH_MAX_CHARS = 512
CHAT_TEXT_FLUSH_MAX_BYTES = 2048
CHAT_CANCEL_POLL_INTERVAL_SECONDS = 0.25
CHAT_CAPACITY_WAIT_DELAYS_SECONDS = (5, 10)


class _ChatTextCoalescer:
    """Own the one bounded host-frame to durable-SSE text fold."""

    def __init__(self, emitter: ChatRunEventEmitter) -> None:
        self._emitter = emitter
        self._text = ""
        self._sequence_start: int | None = None
        self._sequence_end: int | None = None
        self._timer: asyncio.Task[None] | None = None
        self._failure: BaseException | None = None

    async def add(self, *, text: str, sequence: int) -> None:
        self._raise_if_failed()
        if not text:
            return
        remaining = text
        while remaining:
            prefix = _bounded_text_prefix(
                remaining,
                max_chars=CHAT_TEXT_FLUSH_MAX_CHARS - len(self._text),
                max_bytes=CHAT_TEXT_FLUSH_MAX_BYTES - len(self._text.encode("utf-8")),
            )
            if not prefix:
                await self.flush()
                continue
            if self._sequence_start is None:
                self._sequence_start = sequence
            self._sequence_end = sequence
            self._text += prefix
            remaining = remaining[len(prefix) :]
            if (
                remaining
                or len(self._text) == CHAT_TEXT_FLUSH_MAX_CHARS
                or len(self._text.encode("utf-8")) == CHAT_TEXT_FLUSH_MAX_BYTES
            ):
                await self.flush()
        if self._text and self._timer is None:
            self._timer = asyncio.create_task(self._flush_after_interval())

    async def flush(self) -> None:
        timer = self._timer
        self._timer = None
        if timer is not None and timer is not asyncio.current_task():
            timer.cancel()
            with suppress(asyncio.CancelledError):
                await timer
        self._raise_if_failed()
        self._flush_now()

    async def close(self) -> None:
        await self.flush()

    async def _flush_after_interval(self) -> None:
        try:
            await asyncio.sleep(CHAT_TEXT_FLUSH_INTERVAL_MS / 1_000)
            self._timer = None
            self._flush_now()
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            self._failure = exc

    def _flush_now(self) -> None:
        if not self._text:
            return
        if self._sequence_start is None or self._sequence_end is None:
            raise AssertionError("buffered Chat text has no provider sequence")
        if (
            len(self._text) > CHAT_TEXT_FLUSH_MAX_CHARS
            or len(self._text.encode("utf-8")) > CHAT_TEXT_FLUSH_MAX_BYTES
        ):
            raise AssertionError("buffered Chat text exceeds its durable SSE bound")
        self._emitter.assistant_text_delta(
            text=self._text,
            provider_event_seq_start=self._sequence_start,
            provider_event_seq_end=self._sequence_end,
        )
        self._text = ""
        self._sequence_start = None
        self._sequence_end = None

    def _raise_if_failed(self) -> None:
        if self._failure is not None:
            raise RuntimeError("Chat SSE text flush failed") from self._failure


def _bounded_text_prefix(text: str, *, max_chars: int, max_bytes: int) -> str:
    """Take the largest whole-code-point prefix inside both SSE limits."""

    if max_chars < 1 or max_bytes < 1:
        return ""
    byte_count = 0
    end = 0
    for character in text[:max_chars]:
        encoded_bytes = len(character.encode("utf-8"))
        if byte_count + encoded_bytes > max_bytes:
            break
        byte_count += encoded_bytes
        end += 1
    return text[:end]


@dataclasses.dataclass(frozen=True, slots=True)
class PublishedChatExecution:
    run_id: UUID
    message_id: UUID
    citation_count: int
    kind: Literal["Published"] = "Published"


@dataclasses.dataclass(frozen=True, slots=True)
class DegradedChatExecution:
    run_id: UUID
    message_id: UUID
    warning_code: Literal["CitationsUnavailable"]
    support_id: str
    kind: Literal["Degraded"] = "Degraded"


@dataclasses.dataclass(frozen=True, slots=True)
class FailedChatExecution:
    run_id: UUID
    error_code: owned_presence.Presence[str]
    support_id: owned_presence.Presence[str]
    kind: Literal["Failed"] = "Failed"


@dataclasses.dataclass(frozen=True, slots=True)
class CancelledChatExecution:
    run_id: UUID
    kind: Literal["Cancelled"] = "Cancelled"


@dataclasses.dataclass(frozen=True, slots=True)
class SkippedChatExecution:
    reason: Literal["MissingRun", "Terminal"]
    kind: Literal["Skipped"] = "Skipped"


type ChatExecutionOutcome = (
    PublishedChatExecution
    | DegradedChatExecution
    | FailedChatExecution
    | CancelledChatExecution
    | SkippedChatExecution
)

type ChatExecutionResult = ChatExecutionOutcome | RescheduleRequested


def _presence(value: str | None) -> owned_presence.Presence[str]:
    return (
        owned_presence.Present[str](value=value) if value is not None else owned_presence.Absent()
    )


def _failed_chat_execution(
    db: Session,
    *,
    run_id: UUID,
    error_code: str | None,
) -> FailedChatExecution:
    support_id = db.execute(
        select(ChatRun.support_id).where(ChatRun.id == run_id)
    ).scalar_one_or_none()
    return FailedChatExecution(
        run_id=run_id,
        error_code=_presence(error_code),
        support_id=_presence(support_id),
    )


def _log_chat_run_finished(
    db: Session,
    *,
    run_id: UUID,
    outcome: Literal["Published", "Degraded", "Failed", "Cancelled"],
    citation_finalize_ms: int | None = None,
    first_visible_text_ms: int | None = None,
    provider_event_count: int = 0,
) -> None:
    run = db.get(ChatRun, run_id)
    # justify-service-invariant-check: a receipt is emitted only after the
    # durable run was found and terminalized by this execution boundary.
    assert run is not None, f"terminal chat run {run_id} disappeared"
    queue_wait_ms = (
        max(0, int((run.started_at - run.created_at).total_seconds() * 1000))
        if run.started_at is not None
        else None
    )
    execution_ms = (
        max(0, int((run.completed_at - run.started_at).total_seconds() * 1000))
        if run.started_at is not None and run.completed_at is not None
        else None
    )
    logger.info(
        "ChatRun.Finished",
        **{
            "nexus.chat_run.id": str(run.id),
            "nexus.conversation.id": str(run.conversation_id),
            "nexus.chat_run.outcome": outcome,
            "nexus.chat_run.error_code": run.error_code,
            "nexus.chat_run.warning_code": run.publication_warning_code,
            "nexus.chat_run.support_id": run.support_id,
            "nexus.llm.backend": "codex",
            "nexus.llm.model": run.model_name,
            "nexus.llm.reasoning": run.reasoning_effort,
            "nexus.chat_run.queue_wait_ms": queue_wait_ms,
            "nexus.chat_run.execution_ms": execution_ms,
            "nexus.chat_run.citation_finalize_ms": citation_finalize_ms,
            "nexus.chat_run.first_visible_text_ms": first_visible_text_ms,
            "nexus.chat_run.generation_event_count": provider_event_count,
        },
    )


def _chat_tool_operation(
    web_search_provider: WebSearchProvider | None,
) -> FrozenToolOperation:
    return compose_product_tool_runtime(web_search_provider).operations["chat"]


def create_chat_run(
    db: Session,
    *,
    viewer_id: UUID,
    destination: ChatDestination,
    reader_selection: ReaderSelectionInput | None,
    content: str,
    profile_id: str,
    idempotency_key: str | None,
) -> ChatRunResponse:
    normalized_key = normalize_idempotency_key(idempotency_key)
    selection_key = reader_selection.key if reader_selection is not None else None

    # 1. Hash answer-determining identity only — no live source resolution.
    payload_hash = compute_payload_hash(
        destination=destination,
        content=content,
        profile_id=profile_id,
        reader_selection_key=selection_key,
    )

    existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
    if existing is not None:
        raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
        return build_chat_run_response(db, viewer_id, existing)

    # Model/rate + destination fast-fail (no selection resolution: a replay
    # whose live source has since changed must still return before we touch it).
    validate_pre_phase(
        db,
        viewer_id,
        destination=destination,
        content=content,
        profile_id=profile_id,
    )
    tool_admission = chat_tool_profile_admission(_chat_tool_operation(None))

    try:
        # 2. Idempotency lock; a matching replay returns before source/revision
        #    validation, while a payload mismatch fails.
        lock_chat_generation_admission_in_current_transaction(db)
        lock_idempotency_key(db, viewer_id, normalized_key)
        existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
        if existing is not None:
            raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
            db.commit()
            return build_chat_run_response(db, viewer_id, existing)

        # 3. Resolve the destination conversation + insertion inside the tx.
        conversation_id, parent_message_id, branch_anchor = _resolve_destination(
            db, viewer_id, destination
        )

        # 4. Selection: lock+authorize the Highlight, snapshot, derive
        #    subject/companion, verify the compare-on-send revision.
        snapshot_json: dict[str, object] | None = None
        subject_ref: ResourceRef | None = None
        companion_ref: ResourceRef | None = None
        if reader_selection is not None:
            db.execute(
                text("SELECT id FROM highlights WHERE id = :id FOR UPDATE"),
                {"id": reader_selection.key.highlight_id},
            )
            snapshot = build_reader_selection_snapshot(
                db, viewer_id=viewer_id, key=reader_selection.key
            )
            fresh_revision = compute_reader_selection_revision(snapshot)
            if fresh_revision != reader_selection.revision:
                # Stale precondition: raise before creating any run/replay row so
                # the idempotency key remains unconsumed and the UI can refresh
                # and explicitly resend.
                preview = reader_selection_out(db, viewer_id=viewer_id, snapshot=snapshot)
                raise ApiError(
                    ApiErrorCode.E_READER_SELECTION_STALE,
                    "Reader selection changed since it was previewed",
                    details={
                        "preview": {
                            **preview.model_dump(mode="json"),
                            "revision": fresh_revision,
                        }
                    },
                )
            snapshot_json = encode_reader_selection_snapshot(snapshot)
            subject_ref = ResourceRef(scheme="highlight", id=reader_selection.key.highlight_id)
            companion_ref = ResourceRef(scheme="media", id=reader_selection.key.media_id)

        # 5 + 6. Derived subject/companion context edges (selection turns only).
        subject_context_edge_id: UUID | None = None
        if subject_ref is not None:
            assert companion_ref is not None
            subject_edge = add_context_ref_without_commit(
                db,
                viewer_id=viewer_id,
                conversation_id=conversation_id,
                target=subject_ref,
                origin="user",
            )
            subject_context_edge_id = subject_edge.edge_id
            add_context_ref_without_commit(
                db,
                viewer_id=viewer_id,
                conversation_id=conversation_id,
                target=companion_ref,
                origin="system",
            )

        # 7. User message (with snapshot), pending assistant, run, turn context.
        prepared = prepare_messages(
            db,
            viewer_id,
            conversation_id,
            parent_message_id,
            branch_anchor,
            content,
            snapshot_json,
        )
        run = ChatRun(
            owner_user_id=viewer_id,
            conversation_id=prepared.conversation.id,
            user_message_id=prepared.user_message.id,
            assistant_message_id=prepared.assistant_message.id,
            idempotency_key=normalized_key,
            payload_hash=payload_hash,
            status="queued",
            profile_id=profile_id,
            tool_profile_id=tool_admission.profile_id,
            tool_profile_revision=tool_admission.profile_revision,
            tool_profile_snapshot=tool_admission.snapshot,
        )
        db.add(run)
        db.flush()
        if subject_ref is not None:
            db.add(
                ChatRunTurnContext(
                    chat_run_id=run.id,
                    requested_subject_scheme=subject_ref.scheme,
                    requested_subject_id=subject_ref.id,
                    subject_scheme=subject_ref.scheme,
                    subject_id=subject_ref.id,
                    subject_context_edge_id=subject_context_edge_id,
                )
            )
        ChatRunEventEmitter(db, run).meta(
            {
                "run_id": str(run.id),
                "conversation_id": str(prepared.conversation.id),
                "user_message_id": str(prepared.user_message.id),
                "assistant_message_id": str(prepared.assistant_message.id),
                "profile_id": profile_id,
                "chat_subject": (
                    {
                        "requested_resource_ref": subject_ref.uri,
                        "resource_ref": subject_ref.uri,
                        "context_edge_id": (
                            str(subject_context_edge_id)
                            if subject_context_edge_id is not None
                            else None
                        ),
                        "companions": [companion_ref.uri] if companion_ref is not None else [],
                    }
                    if subject_ref is not None
                    else None
                ),
            }
        )
        enqueue_job(
            db,
            kind="chat_run",
            payload={"run_id": str(run.id), "capacity_wait_index": 0},
            priority=50,
            max_attempts=3,
            dedupe_key=f"chat_run:{run.id}",
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return build_chat_run_response(db, viewer_id, run)


def _resolve_destination(
    db: Session,
    viewer_id: UUID,
    destination: ChatDestination,
) -> tuple[UUID, UUID | None, BranchAnchorRequest]:
    """Materialize the target conversation + insertion inside the create tx.

    ``New`` creates an unpublished private conversation. ``Existing.Empty`` locks
    the conversation row and linearizes against concurrent message creation,
    returning ``E_CONVERSATION_NO_LONGER_EMPTY`` (with the current active leaf) if
    another writer won — it never silently replies to a raced head.
    ``Existing.Reply`` yields the parent/branch for an ordinary continuation.
    """
    if isinstance(destination, ExistingChatDestination):
        conversation_id = destination.conversation_id
        insertion = destination.insertion
        if isinstance(insertion, ReplyInsertion):
            return conversation_id, insertion.parent_message_id, insertion.branch_anchor
        assert isinstance(insertion, EmptyInsertion)
        conversation = db.execute(
            select(Conversation).where(Conversation.id == conversation_id).with_for_update()
        ).scalar_one_or_none()
        if conversation is None or conversation.owner_user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
        message_count = db.scalar(
            select(func.count())
            .select_from(Message)
            .where(Message.conversation_id == conversation_id)
        )
        if message_count:
            active_leaf = db.scalar(
                select(ConversationActivePath.active_leaf_message_id).where(
                    ConversationActivePath.conversation_id == conversation_id,
                    ConversationActivePath.viewer_user_id == viewer_id,
                )
            )
            raise ApiError(
                ApiErrorCode.E_CONVERSATION_NO_LONGER_EMPTY,
                "Conversation is no longer empty; resend as a reply to its active leaf",
                details={
                    "conversation_id": str(conversation_id),
                    "active_leaf_message_id": str(active_leaf) if active_leaf else None,
                },
            )
        return conversation_id, None, NoBranchAnchorRequest()

    conversation = Conversation(
        owner_user_id=viewer_id,
        title=DEFAULT_CONVERSATION_TITLE,
        sharing="private",
        next_seq=1,
    )
    db.add(conversation)
    db.flush()
    bump_collection_revision(
        db,
        viewer_id=viewer_id,
        family=CollectionFamily.ConversationIndex,
    )
    return conversation.id, None, NoBranchAnchorRequest()


def get_chat_run(db: Session, *, viewer_id: UUID, run_id: UUID) -> ChatRunResponse:
    run = get_run_for_owner(db, viewer_id, run_id)
    return build_chat_run_response(db, viewer_id, run)


def list_chat_runs_for_conversation(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    status: CHAT_RUN_STATUS_FILTER,
) -> list[ChatRunResponse]:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

    # "active" means non-terminal; every other value is an exact status match. The
    # filter vocabulary is validated once at the boundary by CHAT_RUN_STATUS_FILTER.
    if status == "active":
        filters = [ChatRun.status.notin_(TERMINAL_RUN_STATUSES)]
    else:
        filters = [ChatRun.status == status]

    runs = (
        db.execute(
            select(ChatRun)
            .where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.conversation_id == conversation_id,
                *filters,
            )
            .order_by(ChatRun.created_at.asc(), ChatRun.id.asc())
        )
        .scalars()
        .all()
    )
    return [build_chat_run_response(db, viewer_id, run) for run in runs]


def cancel_chat_run(db: Session, *, viewer_id: UUID, run_id: UUID) -> ChatRunResponse:
    owned = get_run_for_owner(db, viewer_id, run_id)
    lock_chat_generation_admission_in_current_transaction(db)
    run = lock_chat_run_for_update(db, owned.id)
    if run is None or run.owner_user_id != viewer_id:
        raise AssertionError("owned chat run disappeared before cancellation")
    if run.status in TERMINAL_RUN_STATUSES:
        return build_chat_run_response(db, viewer_id, run)
    if run.cancel_requested_at is None:
        run.cancel_requested_at = datetime.now(UTC)
        run.updated_at = datetime.now(UTC)
    dead_job = current_dead_job_for_payload(
        db,
        kind="chat_run",
        expected_payload_match={"run_id": str(run.id)},
    )
    if dead_job is not None and not requeue_dead_job(db, job_id=dead_job.id):
        raise AssertionError("suspended chat job changed while locked")
    db.commit()
    logger.info(
        "chat_run.cancel_requested",
        **safe_kv(chat_run_id=str(run.id), status=run.status),
    )
    return build_chat_run_response(db, viewer_id, run)


def assert_chat_run_owner(db: Session, *, viewer_id: UUID, run_id: UUID) -> None:
    get_run_for_owner(db, viewer_id, run_id)


async def _watch_chat_run_cancel(
    session_factory: sessionmaker[Session],
    *,
    run_id: UUID,
    cancel_signal: asyncio.Event,
) -> None:
    # justify-polling: cancel_requested_at is an UPDATE on the run row, while the
    # existing SSE push channel only notifies appended event rows. This watcher is
    # scoped to one active generation stream and exits as soon as the stream ends.
    while not cancel_signal.is_set():
        with session_factory() as cancel_db:
            cancelled = is_cancel_requested(cancel_db, run_id)
        if cancelled:
            cancel_signal.set()
            return
        await asyncio.sleep(CHAT_CANCEL_POLL_INTERVAL_SECONDS)


async def execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    job: JobRow,
    execution_context: JobExecutionContext,
    session_factory: sessionmaker[Session],
    runtime: ExecutionRuntime,
    settings: Settings,
    web_search_provider: WebSearchProvider | None = None,
) -> ChatExecutionResult:
    """Execute one claimed chat job; defects escape into queue recovery."""
    operation = _chat_tool_operation(web_search_provider)
    steps = ChatStepRuntime(
        db,
        run_id=run_id,
        job=job,
        execution_context=execution_context,
        llm_runtime=runtime,
    )
    set_flow_id(str(run_id))
    try:
        return await _execute_chat_run(
            db,
            run_id=run_id,
            steps=steps,
            session_factory=session_factory,
            operation=operation,
            settings=settings,
        )
    except Exception:
        db.rollback()
        logger.exception("chat_run.attempt_failed", run_id=str(run_id), job_id=str(job.id))
        raise
    finally:
        set_flow_id(None)


async def _execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    steps: ChatStepRuntime,
    session_factory: sessionmaker[Session],
    operation: FrozenToolOperation,
    settings: Settings,
) -> ChatExecutionResult:
    run = db.get(ChatRun, run_id)
    if run is None:
        steps.clear()
        return SkippedChatExecution(reason="MissingRun")
    if run.status in TERMINAL_RUN_STATUSES:
        steps.clear()
        return SkippedChatExecution(reason="Terminal")
    validate_chat_tool_profile(run, operation)

    profile = run.profile_id
    if profile not in generation_policy.CHAT_PROFILES:
        raise AssertionError("chat run profile_id is missing or unknown")
    policy = generation_policy.chat_policy(profile)
    mark_running(
        db,
        run.id,
        model_name=policy.model,
        reasoning_effort=policy.effort,
    )
    run = db.get(ChatRun, run.id)
    if run is None:
        raise AssertionError("running chat run disappeared")
    if run.status in TERMINAL_RUN_STATUSES:
        steps.clear()
        return SkippedChatExecution(reason="Terminal")
    if is_cancel_requested(db, run.id):
        return _finalize_cancelled_execution(db, run=run, steps=steps)

    rate_limiter = get_rate_limiter()
    rate_limiter.acquire_inflight_slot(run.owner_user_id)
    try:
        try:
            prepared = _prepare_chat_run(
                db,
                run=run,
                steps=steps,
                profile=profile,
            )
        except ContextBudgetError as exc:
            logger.warning(
                "chat_run.context_budget_exceeded",
                run_id=str(run.id),
                lane=exc.lane,
                item_key=exc.item_key,
                requested_tokens=exc.requested_tokens,
                remaining_tokens=exc.remaining_tokens,
            )
            finalize_run(
                db,
                run_id=run.id,
                assistant_content="",
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code="context_too_large",
                support_id=uuid4().hex[:12],
                error_detail=exception_error_detail(exc),
                commit=False,
            )
            steps.clear()
            _log_chat_run_finished(db, run_id=run.id, outcome="Failed")
            return _failed_chat_execution(
                db,
                run_id=run.id,
                error_code="context_too_large",
            )

        full_content = ""
        final_usage: dict[str, JsonValue] | None = None
        last_provider_event_seq: int | None = None
        emitter = ChatRunEventEmitter(db, run, lease_fence=steps.lock_active_attempt)
        generation_path = "generation/1"
        generation_state = steps.read(generation_path, ReplayPolicy.BilledOnce)
        if generation_state is None:
            generation_state = steps.prepare(
                generation_path,
                request_fingerprint(
                    _chat_command_draft(
                        prepared.generate_intent,
                        profile,
                        generation_state_id=stable_generation_id(run.id, generation_path),
                    )
                ),
            )
        elif generation_state.dispatch_phase not in {Prepared, Completed}:
            raise AssertionError("chat generation step is not dispatchable")

        generation_result = await _dispatch_generation_step(
            db,
            run=run,
            steps=steps,
            path=generation_path,
            generation_id=generation_state.generation_id,
            intent=prepared.generate_intent,
            profile=profile,
            operation=operation,
            admitted_resource_uris=prepared.admitted_resource_uris,
            session_factory=session_factory,
            settings=settings,
            emitter=emitter,
        )
        if isinstance(generation_result, RescheduleRequested):
            return generation_result
        terminal = _fold_generation_terminal(db, run=run, steps=steps, result=generation_result)
        if terminal is not None:
            return terminal
        assert isinstance(generation_result, AssistantTurn)
        full_content = generation_result.text
        final_usage = _owned_value(generation_result.usage)
        last_provider_event_seq = _owned_value(generation_result.last_provider_event_seq)

        if is_cancel_requested(db, run.id):
            return _finalize_cancelled_execution(
                db,
                run=run,
                steps=steps,
                assistant_content=full_content,
                usage=final_usage,
                last_provider_event_seq=last_provider_event_seq,
            )
        return _publish_chat_run(
            db,
            run=run,
            steps=steps,
            emitter=emitter,
            full_content=full_content,
            usage=final_usage,
            last_provider_event_seq=last_provider_event_seq,
        )
    finally:
        rate_limiter.release_inflight_slot(run.owner_user_id)


def _prepare_chat_run(
    db: Session,
    *,
    run: ChatRun,
    steps: ChatStepRuntime,
    profile: str,
) -> PreparedChatRun:
    state = steps.read("prepare", ReplayPolicy.ReDispatchable)
    if state is not None:
        if state.dispatch_phase is not Completed:
            raise AssertionError("prepare database step is not completed")
        prepared = decode_prepared(state)
        _assert_step_fingerprint(state, step_fingerprint(prepared))
        return prepared

    conversation = db.get(Conversation, run.conversation_id)
    user_message = db.get(Message, run.user_message_id)
    if conversation is None or user_message is None:
        raise AssertionError("chat run conversation or user message is missing")

    assembly = assemble_chat_context(
        db,
        run=run,
        profile=profile,
    )
    persist_prompt_assembly(db, run=run, assembly=assembly)
    reconcile_prompt_retrievals(db, run=run, assembly=assembly)
    attached_numbering = persist_attached_citations(db, run, assembly.attached_citations)
    admitted_resource_uris = tuple(
        dict.fromkeys(
            context.target.uri
            for context in list_context_refs(
                db,
                viewer_id=run.owner_user_id,
                conversation_id=run.conversation_id,
            )
        )
    )
    prepared = PreparedChatRun(
        generate_intent=assembly.generate_intent,
        admitted_resource_uris=admitted_resource_uris,
        initial_citation_ordinal=attached_numbering.next_ordinal,
        initial_tool_call_index=0,
    )
    fingerprint = step_fingerprint(prepared)
    steps.complete_database_step("prepare", fingerprint=fingerprint, result=prepared)
    return prepared


async def _dispatch_generation_step(
    db: Session,
    *,
    run: ChatRun,
    steps: ChatStepRuntime,
    path: str,
    generation_id: UUID,
    intent: Any,
    profile: str,
    operation: FrozenToolOperation,
    admitted_resource_uris: tuple[str, ...],
    session_factory: sessionmaker[Session],
    settings: Settings,
    emitter: ChatRunEventEmitter,
) -> AssistantTurn | ExpectedFailure | CancelledGeneration | RescheduleRequested:
    """Execute one app-owned ChatTools command; MCP owns tool execution."""
    draft = _chat_command_draft(intent, profile, generation_state_id=generation_id)
    request_fp = request_fingerprint(draft)
    with session_factory() as clock_db:
        now = clock_db.scalar(text("SELECT clock_timestamp()"))
    if not isinstance(now, datetime):
        raise AssertionError("database clock did not return a timestamp")
    grant = issue_chat_generation_grant(
        user_id=run.owner_user_id,
        run_id=run.id,
        job_id=steps.execution_context.job_id,
        worker_id=steps.execution_context.worker_id,
        attempt_no=steps.execution_context.attempt_no,
        generation_id=generation_id,
        tool_plan_revision=generation_policy.TOOL_PLAN_REVISION,
        request_fingerprint=request_fp,
        signing_key=settings.effective_agent_tool_grant_signing_key,
        now=now if now.tzinfo is not None else now.replace(tzinfo=UTC),
    )
    command = draft.model_copy(update={"tool_grant": BearerToolGrant(token=grant)})

    capacity_wait_index = _chat_capacity_wait_index(steps.job)
    observed_text_parts: list[str] = []
    observed_usage: dict[str, JsonValue] | None = None
    last_sequence: int | None = None
    text_coalescer = _ChatTextCoalescer(emitter)

    async def observe(frame: GenerationFrame) -> None:
        nonlocal observed_usage, last_sequence
        last_sequence = frame.sequence
        if isinstance(frame.event, GenerationText):
            observed_text_parts.append(frame.event.text)
            await text_coalescer.add(
                text=frame.event.text,
                sequence=frame.sequence,
            )
            return
        await text_coalescer.flush()
        if isinstance(frame.event, GenerationToolUse):
            emitter.assistant_activity(
                phase="tool_calling",
                provider_event_seq_start=frame.sequence,
                provider_event_seq_end=frame.sequence,
            )
        elif isinstance(frame.event, GenerationUsageEvent):
            observed_usage = frame.event.usage.model_dump(mode="json")

    from nexus.services.agent_tools_mcp import AgentToolAuthority

    authority = AgentToolAuthority.from_claimed_chat_attempt(
        session_factory=session_factory,
        run_id=run.id,
        job_id=steps.execution_context.job_id,
        attempt_no=steps.execution_context.attempt_no,
        resource_class=steps.execution_context.resource_class,
        operation=operation,
        worker_id=steps.execution_context.worker_id,
        generation_id=generation_id,
        admitted_resource_uris=admitted_resource_uris,
    )
    cancel_signal = asyncio.Event()
    cancel_watcher: asyncio.Task[None] | None = None

    # First dispatch commits through the prepare step, while a Prepared capacity
    # replay arrives with the post-mark-running read transaction still active.
    # Close both shapes before health, UDS, or MCP I/O begins.
    db.commit()

    def resolve_terminal(
        terminal_db: Session,
        terminal: GenerationTerminal,
    ) -> GenerationTerminal:
        locked_run = lock_chat_run_for_update(terminal_db, run.id)
        if locked_run is None:
            raise AssertionError("chat run disappeared before generation terminal")
        if locked_run.cancel_requested_at is None or terminal.status == "cancelled":
            return terminal
        cancel_signal.set()
        return terminal.model_copy(
            update={
                "status": "cancelled",
                "failure": None,
                "final_text": "",
                "structured_output": None,
                "diagnostics": ("worker: durable chat cancellation won terminal linearization",),
            }
        )

    try:
        cancel_watcher = asyncio.create_task(
            _watch_chat_run_cancel(
                session_factory,
                run_id=run.id,
                cancel_signal=cancel_signal,
            )
        )
        result = await execute_generation(
            GenerationExecutionRequest(
                owner=LlmCallOwner(kind="chat_run", id=run.id),
                command=command,
                journal=JobGenerationJournal(
                    context=steps.execution_context,
                    step_path=path,
                    capacity_wait_index=capacity_wait_index,
                    lock_dispatch=steps.lock_dispatch,
                ),
                capacity_wait_index=capacity_wait_index,
                capacity_wait_delays_seconds=CHAT_CAPACITY_WAIT_DELAYS_SECONDS,
                streaming=True,
            ),
            session_factory=session_factory,
            runtime=steps.llm_runtime,
            observe_frame=observe,
            cancel_signal=cancel_signal,
            before_terminal=authority.wait_until_idle,
            resolve_terminal=resolve_terminal,
            encode_terminal=lambda terminal: EncodedGenerationTerminal(
                terminal_result=encode_step_result(
                    GenerationStepResultEnvelope(
                        root=_chat_generation_terminal_result(
                            terminal,
                            observed_text="".join(observed_text_parts),
                            observed_usage=observed_usage,
                            last_sequence=last_sequence,
                            generation_id=generation_id,
                        )
                    )
                )
            ),
            encode_preaccept_failure=lambda code, detail: _encode_chat_preaccept_failure(
                code,
                detail=detail,
                generation_id=generation_id,
            ),
        )
    finally:
        try:
            await text_coalescer.close()
        finally:
            try:
                if cancel_watcher is not None:
                    cancel_watcher.cancel()
                    with suppress(asyncio.CancelledError):
                        await cancel_watcher
            finally:
                try:
                    await authority.wait_until_idle()
                finally:
                    authority.close()

    # The host terminal cannot discharge a tool effect whose worker-owned
    # journal remained ambiguous. Preserve that journal and suspend the job
    # before any run terminal or publication can clear it.
    steps.assert_no_uncertain_tool_effect()

    if isinstance(result, RescheduleRequested):
        return result
    return decode_step_result(result.terminal_result, GenerationStepResultEnvelope).root


def _chat_capacity_wait_index(job: JobRow) -> int:
    value = job.payload.get("capacity_wait_index")
    if type(value) is not int or not 0 <= value <= len(CHAT_CAPACITY_WAIT_DELAYS_SECONDS):
        raise AssertionError("chat job has an invalid capacity_wait_index")
    return value


def _chat_generation_terminal_result(
    terminal: GenerationTerminal,
    *,
    observed_text: str,
    observed_usage: dict[str, JsonValue] | None,
    last_sequence: int | None,
    generation_id: UUID,
) -> AssistantTurn | ExpectedFailure | CancelledGeneration:
    if terminal.status == "succeeded" and terminal.final_text != observed_text:
        raise AssertionError("Chat terminal text differs from its streamed text fold")
    if terminal.status != "succeeded" and terminal.final_text:
        raise AssertionError("non-success Chat terminal exposed provider text")
    content = observed_text
    usage = terminal.usage.model_dump(mode="json") if terminal.usage is not None else observed_usage
    if terminal.status == "cancelled":
        return CancelledGeneration(
            assistant_content=content,
            usage=_owned_usage(usage),
            last_provider_event_seq=_owned_sequence(last_sequence),
        )
    if terminal.status == "failed":
        if terminal.failure is None:
            raise AssertionError("failed generation omitted failure")
        return ExpectedFailure(
            assistant_content=content,
            error_code=normalized_failure(terminal.failure.kind),
            usage=_owned_usage(usage),
            support_id=_owned_text(generation_id.hex[:12]),
            last_provider_event_seq=_owned_sequence(last_sequence),
        )
    return assistant_turn_result(
        text=content,
        tool_calls=(),
        usage=usage,
        support_id=generation_id.hex[:12],
        last_provider_event_seq=last_sequence,
    )


def _encode_chat_preaccept_failure(
    code: str,
    *,
    detail: str,
    generation_id: UUID,
) -> str:
    del detail
    return encode_step_result(
        GenerationStepResultEnvelope(
            root=ExpectedFailure(
                assistant_content="",
                error_code=code,
                usage=owned_presence.absent(),
                support_id=_owned_text(generation_id.hex[:12]),
                last_provider_event_seq=owned_presence.absent(),
            )
        )
    )


def _chat_command_draft(
    intent: Any,
    profile: str,
    *,
    generation_state_id: UUID | None,
) -> GenerationCommand:
    """Build the grant-independent command used for journal identity."""
    request_id = generation_state_id or uuid4()
    return GenerationCommand(
        request_id=request_id,
        operation=ChatOperation(
            kind="chat",
            revision=generation_policy.operation_revision("chat", profile=profile),
            profile=cast(Any, profile),
        ),
        policy_revision=generation_policy.POLICY_REVISION,
        policy_fingerprint=generation_policy.POLICY_FINGERPRINT,
        intent=intent,
        tool_grant=BearerToolGrant(token=SecretStr("pending")),
    )


def _fold_generation_terminal(
    db: Session,
    *,
    run: ChatRun,
    steps: ChatStepRuntime,
    result: AssistantTurn | ExpectedFailure | CancelledGeneration,
) -> ChatExecutionOutcome | None:
    if isinstance(result, AssistantTurn):
        return None
    usage = _owned_value(result.usage)
    last_seq = _owned_value(result.last_provider_event_seq)
    if isinstance(result, CancelledGeneration):
        return _finalize_cancelled_execution(
            db,
            run=run,
            steps=steps,
            assistant_content=result.assistant_content,
            usage=usage,
            last_provider_event_seq=last_seq,
        )
    locked_run = lock_chat_run_for_update(db, run.id)
    if locked_run is None:
        raise AssertionError("chat run disappeared before terminal fold")
    if locked_run.cancel_requested_at is not None:
        return _finalize_cancelled_execution(
            db,
            run=locked_run,
            steps=steps,
            assistant_content=result.assistant_content,
            usage=usage,
            last_provider_event_seq=last_seq,
        )
    finalize_run(
        db,
        run_id=locked_run.id,
        assistant_content=result.assistant_content,
        assistant_status="error",
        run_status="error",
        done_status="error",
        error_code=result.error_code,
        support_id=_owned_value(result.support_id),
        usage=usage,
        last_provider_event_seq=last_seq,
        commit=False,
    )
    steps.clear()
    _log_chat_run_finished(db, run_id=run.id, outcome="Failed")
    return _failed_chat_execution(db, run_id=run.id, error_code=result.error_code)


def _publish_chat_run(
    db: Session,
    *,
    run: ChatRun,
    steps: ChatStepRuntime,
    emitter: ChatRunEventEmitter,
    full_content: str,
    usage: dict[str, JsonValue] | None,
    last_provider_event_seq: int | None,
) -> ChatExecutionOutcome:
    request = PublicationRequest(
        generated_markdown=full_content,
        usage=_owned_usage(usage),
        last_provider_event_seq=_owned_sequence(last_provider_event_seq),
    )
    fingerprint = step_fingerprint(request)
    state = steps.read("publication", ReplayPolicy.ReDispatchable)
    if state is None:
        state = steps.prepare("publication", fingerprint)
    else:
        _assert_step_fingerprint(state, fingerprint)
    if state.dispatch_phase is not Prepared:
        raise AssertionError("publication step cannot be replayed on an active run")

    # Publication is the final domain-effect boundary.  Lock the run before the
    # queue claim so cancellation and every publication effect share one global
    # run -> job order.  The earlier cancellation read is only an advisory fast
    # path; this locked read is the authority immediately before citations and
    # assistant content become reader-visible.
    locked_run = lock_chat_run_for_update(db, run.id)
    if locked_run is None:
        raise AssertionError("chat run disappeared before publication")
    steps.lock_active_attempt()
    if locked_run.cancel_requested_at is not None:
        return _finalize_cancelled_execution(
            db,
            run=locked_run,
            steps=steps,
            assistant_content=full_content,
            usage=usage,
            last_provider_event_seq=last_provider_event_seq,
        )

    citation_started_at = time.monotonic()
    citation_result = publish_chat_citations(
        db,
        run=locked_run,
        generated_markdown=full_content,
        emitter=emitter,
    )
    citation_finalize_ms = round((time.monotonic() - citation_started_at) * 1000)
    degraded_support_id: str | None = None
    if isinstance(citation_result, DegradedCitations):
        degraded_support_id = uuid4().hex[:12]
        finalize_run(
            db,
            run_id=locked_run.id,
            assistant_content=citation_result.content_md,
            assistant_status="complete",
            run_status="complete",
            done_status="complete",
            error_code=None,
            support_id=degraded_support_id,
            publication_warning_code=citation_result.warning_code,
            error_detail=citation_result.detail,
            usage=usage,
            last_provider_event_seq=last_provider_event_seq,
            commit=False,
        )
        outcome_kind: Literal["Published", "Degraded"] = "Degraded"
    else:
        if not isinstance(citation_result, PublishedCitations):
            raise AssertionError("unknown citation publication result")
        finalize_run(
            db,
            run_id=locked_run.id,
            assistant_content=citation_result.content_md,
            assistant_status="complete",
            run_status="complete",
            done_status="complete",
            error_code=None,
            usage=usage,
            last_provider_event_seq=last_provider_event_seq,
            commit=False,
        )
        outcome_kind = "Published"

    terminal_event_seq = db.execute(
        text(
            "SELECT seq FROM chat_run_events "
            "WHERE run_id = :run_id AND event_type = 'done' ORDER BY seq DESC LIMIT 1"
        ),
        {"run_id": locked_run.id},
    ).scalar_one()
    steps.complete_publication(
        PublicationStepResult(
            outcome=outcome_kind,
            message_id=locked_run.assistant_message_id,
            terminal_event_seq=terminal_event_seq,
        )
    )
    _log_chat_run_finished(
        db,
        run_id=locked_run.id,
        outcome=outcome_kind,
        citation_finalize_ms=citation_finalize_ms,
    )
    if isinstance(citation_result, DegradedCitations):
        if degraded_support_id is None:
            raise AssertionError("degraded publication is missing a support id")
        return DegradedChatExecution(
            run_id=locked_run.id,
            message_id=locked_run.assistant_message_id,
            warning_code=citation_result.warning_code,
            support_id=degraded_support_id,
        )
    return PublishedChatExecution(
        run_id=locked_run.id,
        message_id=locked_run.assistant_message_id,
        citation_count=citation_result.citation_count,
    )


def _finalize_cancelled_execution(
    db: Session,
    *,
    run: ChatRun,
    steps: ChatStepRuntime,
    assistant_content: str = "",
    usage: dict[str, JsonValue] | None = None,
    last_provider_event_seq: int | None = None,
) -> CancelledChatExecution:
    finalize_cancelled(
        db,
        run,
        assistant_content=assistant_content,
        usage=usage,
        last_provider_event_seq=last_provider_event_seq,
        commit=False,
    )
    steps.clear()
    _log_chat_run_finished(db, run_id=run.id, outcome="Cancelled")
    return CancelledChatExecution(run_id=run.id)


def _assert_step_fingerprint(state: StepReplayState, expected: str) -> None:
    fingerprint = state.request_fingerprint
    if not isinstance(fingerprint, owned_presence.Present):
        raise AssertionError("durable chat step has no request fingerprint")
    if fingerprint.value != expected:
        raise AssertionError("durable chat step request fingerprint changed")


def _owned_usage(
    value: dict[str, JsonValue] | None,
) -> owned_presence.Presence[dict[str, JsonValue]]:
    if value is None:
        return owned_presence.absent()
    return owned_presence.Present[dict[str, JsonValue]](value=value)


def _owned_sequence(value: int | None) -> owned_presence.Presence[int]:
    if value is None:
        return owned_presence.absent()
    return owned_presence.Present[int](value=value)


def _owned_text(value: str | None) -> owned_presence.Presence[str]:
    if value is None:
        return owned_presence.absent()
    return owned_presence.Present[str](value=value)


def _owned_value[T](value: owned_presence.Presence[T]) -> T | None:
    return value.value if isinstance(value, owned_presence.Present) else None
