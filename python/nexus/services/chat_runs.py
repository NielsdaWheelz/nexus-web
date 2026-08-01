"""Durable chat-run service.

One chat send is one durable run. HTTP creates/cancels/reads runs; the worker
executes tools and provider streaming via ``llm_execution.
execute_generation_stream`` (the sole generation boundary); the stream route
only tails persisted events.
"""

from __future__ import annotations

import asyncio
import dataclasses
import time
from collections.abc import AsyncGenerator, Mapping
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any, Literal, cast
from uuid import UUID, uuid4

from provider_runtime import (
    CATALOG,
    Absent,
    Cancelled,
    CancelSignal,
    CanonicalTool,
    ChatModelContract,
    ContinuationArtifact,
    ContinuationDelta,
    Failed,
    Incomplete,
    PossiblyBillable,
    Presence,
    Present,
    PromptMessage,
    ReasoningLevel,
    RuntimeStreamEvent,
    StreamStart,
    Succeeded,
    TerminalEvent,
    TextDelta,
    ToolCall,
    ToolCallDelta,
    ToolCallDone,
    ToolCallStart,
    TransientExhausted,
    UsageEvent,
    failure_code,
    failure_origin,
    parse_canonical_schema,
)
from pydantic import JsonValue
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, sessionmaker
from web_search_tool.types import WebSearchProvider

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
    current_dead_job_for_payload,
    enqueue_job,
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
    ChatRunToolResultEventPayload,
    EmptyInsertion,
    ExistingChatDestination,
    NoBranchAnchorRequest,
    ReplyInsertion,
)
from nexus.services.agent_tools.app_search import (
    APP_SEARCH_TOOL_DEFINITION,
    APP_SEARCH_TOOL_NAME,
    execute_app_search,
)
from nexus.services.agent_tools.inspect_resource import (
    INSPECT_RESOURCE_TOOL_DEFINITION,
    INSPECT_RESOURCE_TOOL_NAME,
    execute_inspect_resource,
)
from nexus.services.agent_tools.read_resource import (
    READ_RESOURCE_TOOL_DEFINITION,
    READ_RESOURCE_TOOL_NAME,
    execute_read_resource,
)
from nexus.services.agent_tools.web_search import (
    WEB_SEARCH_TOOL_DEFINITION,
    WEB_SEARCH_TOOL_NAME,
    execute_web_search,
    persist_web_search_run,
)
from nexus.services.agent_tools.writes import (
    WRITE_TOOL_NAMES,
    assistant_write_tool_definitions,
    execute_write_tool,
)
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
    number_tool_citation_candidates,
    persist_attached_citations,
    persist_read_evidence_candidate,
    publish_chat_citations,
)
from nexus.services.chat_run_event_store import (
    TERMINAL_RUN_STATUSES,
    ChatRunEventEmitter,
    is_cancel_requested,
    mark_running,
)
from nexus.services.chat_run_finalize import (
    MAX_ASSISTANT_CONTENT_LENGTH,
    TRUNCATION_NOTICE,
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
    GenerateIntentState,
    PreparedChatRun,
    PublicationRequest,
    PublicationStepResult,
    ToolModelOutput,
    ToolStepRequest,
    ToolStepResult,
    UncertainChatStep,
    assistant_message_from_turn,
    assistant_turn_result,
    decode_generation,
    decode_prepared,
    decode_tool,
    step_fingerprint,
    tool_call_from_state,
    tool_replay_policy,
    tool_result_message,
)
from nexus.services.chat_run_tools import (
    app_search_tool_output,
    bind_provider_tool_call_events,
    persist_tool_call_error,
    persist_tool_call_start,
    persist_tool_call_trace,
    tool_trace_event,
)
from nexus.services.chat_run_usage import usage_provider_json
from nexus.services.chat_run_validation import validate_pre_phase
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_collection_revision,
)
from nexus.services.context_assembler import (
    assemble_chat_context,
    persist_prompt_assembly,
)
from nexus.services.conversations import DEFAULT_CONVERSATION_TITLE
from nexus.services.durable_step_journal import Completed, Prepared, ReplayPolicy, StepReplayState
from nexus.services.llm_execution import (
    ExecutionRuntime,
    GenerationRequest,
    execute_generation_stream,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.llm_profiles import LlmProfile
from nexus.services.llm_profiles import profile as lookup_profile
from nexus.services.llm_profiles import reasoning_level as lookup_reasoning_level
from nexus.services.prompt_budget import ContextBudgetError
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.redact import safe_kv
from nexus.services.resource_graph.context import (
    add_context_ref_without_commit,
)
from nexus.services.resource_graph.refs import ResourceRef

logger = get_logger(__name__)


REASONING_OUTPUT_TOKENS = 25000
DEFAULT_OUTPUT_TOKENS = 4096
MAX_TOOL_ITERATIONS = 8
CHAT_TEXT_FLUSH_INTERVAL_MS = 33
CHAT_TEXT_FLUSH_MAX_CHARS = 512
CHAT_TEXT_FLUSH_MAX_BYTES = 2048
CHAT_CANCEL_POLL_INTERVAL_SECONDS = 0.25


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
            "nexus.llm.provider": run.provider,
            "nexus.llm.model": run.model_name,
            "nexus.llm.reasoning": run.reasoning_effort,
            "nexus.chat_run.queue_wait_ms": queue_wait_ms,
            "nexus.chat_run.execution_ms": execution_ms,
            "nexus.chat_run.citation_finalize_ms": citation_finalize_ms,
            "nexus.chat_run.first_visible_text_ms": first_visible_text_ms,
            "nexus.chat_run.provider_event_count": provider_event_count,
        },
    )


def _chat_tool_specs() -> tuple[CanonicalTool, ...]:
    """The read-only tools plus the assistant write tools when enabled (AC-6),
    compiled to the runtime's canonical JSON-Schema subset exactly once here —
    the sole LLM-boundary schema compile site for chat."""
    definitions: list[tuple[str, str, Mapping[str, Any]]] = [
        (
            APP_SEARCH_TOOL_NAME,
            APP_SEARCH_TOOL_DEFINITION["description"],
            APP_SEARCH_TOOL_DEFINITION["parameters"],
        ),
        (
            WEB_SEARCH_TOOL_NAME,
            WEB_SEARCH_TOOL_DEFINITION["description"],
            WEB_SEARCH_TOOL_DEFINITION["parameters"],
        ),
        (
            READ_RESOURCE_TOOL_NAME,
            READ_RESOURCE_TOOL_DEFINITION["description"],
            READ_RESOURCE_TOOL_DEFINITION["parameters"],
        ),
        (
            INSPECT_RESOURCE_TOOL_NAME,
            INSPECT_RESOURCE_TOOL_DEFINITION["description"],
            INSPECT_RESOURCE_TOOL_DEFINITION["parameters"],
        ),
    ]
    definitions.extend(
        (definition["name"], definition["description"], definition["parameters"])
        for definition in assistant_write_tool_definitions()
    )
    return tuple(
        CanonicalTool(
            name=name,
            description=description,
            parameters=parse_canonical_schema(parameters),
        )
        for name, description, parameters in definitions
    )


def _app_search_scopes_from_tool_args(args: Mapping[str, Any]) -> tuple[list[str], str | None]:
    if "scope" in args:
        return (
            [],
            "app_search uses scopes=[...] for URI scopes; the singular scope field is invalid",
        )

    raw_scopes = args.get("scopes")
    if raw_scopes is None:
        return [], None
    if not isinstance(raw_scopes, list):
        return [], "app_search scopes must be an array of URI strings"

    scopes: list[str] = []
    for scope in raw_scopes:
        if not isinstance(scope, str):
            return [], "app_search scopes must be an array of URI strings"
        normalized_scope = scope.strip()
        if not normalized_scope:
            return [], "app_search scopes must be non-empty URI strings"
        scopes.append(normalized_scope)
    return scopes, None


def _app_search_string_array_from_tool_args(
    args: Mapping[str, Any], key: str
) -> tuple[list[str] | None, str | None]:
    raw = args.get(key)
    if raw is None:
        return None, None
    if not isinstance(raw, list):
        return None, f"app_search {key} must be an array of strings"
    values: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            return None, f"app_search {key} must be an array of strings"
        value = item.strip()
        if value:
            values.append(value)
    return (values or None), None


def _max_output_tokens_for_reasoning(contract: ChatModelContract, reasoning: ReasoningLevel) -> int:
    if reasoning != "none" and contract.pricing.reasoning_reserve_tokens > 0:
        return min(REASONING_OUTPUT_TOKENS, contract.output_limit)
    return min(DEFAULT_OUTPUT_TOKENS, contract.output_limit)


def create_chat_run(
    db: Session,
    *,
    viewer_id: UUID,
    destination: ChatDestination,
    reader_selection: ReaderSelectionInput | None,
    content: str,
    profile_id: str,
    reasoning_option_id: str,
    idempotency_key: str | None,
) -> ChatRunResponse:
    normalized_key = normalize_idempotency_key(idempotency_key)
    selection_key = reader_selection.key if reader_selection is not None else None

    # 1. Hash answer-determining identity only — no live source resolution.
    payload_hash = compute_payload_hash(
        destination=destination,
        content=content,
        profile_id=profile_id,
        reasoning_option_id=reasoning_option_id,
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
        reasoning_option_id=reasoning_option_id,
    )

    try:
        # 2. Idempotency lock; a matching replay returns before source/revision
        #    validation, while a payload mismatch fails.
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
            reasoning_option_id=reasoning_option_id,
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
                "reasoning_option_id": reasoning_option_id,
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
    run = get_run_for_owner(db, viewer_id, run_id)
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
    db: Session, *, run_id: UUID, cancel_signal: asyncio.Event
) -> None:
    # justify-polling: cancel_requested_at is an UPDATE on the run row, while the
    # existing SSE push channel only notifies appended event rows. This watcher is
    # scoped to one active provider stream and exits as soon as the stream ends.
    while not cancel_signal.is_set():
        if is_cancel_requested(db, run_id):
            cancel_signal.set()
            return
        await asyncio.sleep(CHAT_CANCEL_POLL_INTERVAL_SECONDS)


def _latest_generation_support_id(db: Session, run_id: UUID) -> str | None:
    """`llm_ledger._support_id`'s derivation (``generation_id.hex[:12]``),
    re-derived from the run's most recent llm_calls row — the terminal fold
    only receives the runtime's own ``RuntimeStreamEvent`` envelopes, which
    carry no generation id, so the ledger identity is read back here."""
    generation_id = db.execute(
        text(
            "SELECT id FROM llm_calls WHERE owner_kind = 'chat_run' AND owner_id = :run_id "
            "ORDER BY call_seq DESC LIMIT 1"
        ),
        {"run_id": run_id},
    ).scalar_one_or_none()
    return generation_id.hex[:12] if generation_id is not None else None


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
) -> ChatExecutionOutcome:
    """Execute one claimed chat job; defects escape into queue recovery."""
    steps = ChatStepRuntime(
        db,
        run_id=run_id,
        job=job,
        execution_context=execution_context,
        llm_runtime=runtime,
        web_search_provider=(
            owned_presence.absent()
            if web_search_provider is None
            else owned_presence.present(web_search_provider)
        ),
    )
    set_flow_id(str(run_id))
    try:
        return await _execute_chat_run(
            db,
            run_id=run_id,
            steps=steps,
            session_factory=session_factory,
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
    settings: Settings,
) -> ChatExecutionOutcome:
    run = db.get(ChatRun, run_id)
    if run is None:
        steps.clear()
        return SkippedChatExecution(reason="MissingRun")
    if run.status in TERMINAL_RUN_STATUSES:
        steps.clear()
        return SkippedChatExecution(reason="Terminal")

    profile = lookup_profile(run.profile_id) if run.profile_id is not None else None
    if profile is None:
        raise AssertionError("chat run profile_id is missing or unknown")
    reasoning = (
        lookup_reasoning_level(profile, run.reasoning_option_id)
        if run.reasoning_option_id is not None
        else None
    )
    if reasoning is None:
        raise AssertionError("chat run reasoning_option_id is missing or unsupported")

    contract = CATALOG.chat_contract(profile.target)
    max_output_tokens = _max_output_tokens_for_reasoning(contract, reasoning)
    mark_running(
        db,
        run.id,
        provider=profile.target.provider,
        model_name=profile.target.model,
        reasoning_effort=reasoning,
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
        tools = _chat_tool_specs()
        try:
            prepared = _prepare_chat_run(
                db,
                run=run,
                steps=steps,
                profile=profile,
                reasoning=reasoning,
                contract=contract,
                max_output_tokens=max_output_tokens,
                tools=tools,
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
                error_origin="intent",
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

        base_intent = prepared.generate_intent.to_intent()
        messages: list[PromptMessage] = list(base_intent.messages)
        full_content = ""
        final_usage: dict[str, JsonValue] | None = None
        last_provider_event_seq: int | None = None
        citation_n_next = prepared.initial_citation_ordinal
        tool_call_index_next = prepared.initial_tool_call_index
        call_owner = LlmCallOwner(kind="chat_run", id=run.id, user_id=run.owner_user_id)
        emitter = ChatRunEventEmitter(db, run, lease_fence=steps.lock_active_attempt)

        for turn_index in range(MAX_TOOL_ITERATIONS):
            if is_cancel_requested(db, run.id):
                return _finalize_cancelled_execution(
                    db,
                    run=run,
                    steps=steps,
                    assistant_content=full_content,
                    usage=final_usage,
                    last_provider_event_seq=last_provider_event_seq,
                )

            generation_path = f"turn/{turn_index}/generation"
            iter_intent = dataclasses.replace(base_intent, messages=tuple(messages))
            request_state = GenerateIntentState.from_intent(iter_intent)
            fingerprint = step_fingerprint(request_state)
            generation_state = steps.read(generation_path, ReplayPolicy.BilledOnce)
            if generation_state is None:
                generation_state = steps.prepare(generation_path, fingerprint)
            else:
                _assert_step_fingerprint(generation_state, fingerprint)

            if generation_state.dispatch_phase is Completed:
                generation_result = decode_generation(generation_state)
            else:
                if generation_state.dispatch_phase is not Prepared:
                    raise AssertionError("generation step is not dispatchable")
                generation_result = await _dispatch_generation_step(
                    db,
                    run=run,
                    steps=steps,
                    path=generation_path,
                    request=GenerationRequest(
                        owner=call_owner,
                        operation="chat",
                        profile=profile,
                        reasoning=reasoning,
                        intent=iter_intent,
                    ),
                    session_factory=session_factory,
                    settings=settings,
                    emitter=emitter,
                    content_prefix=full_content,
                    tool_call_index_next=tool_call_index_next,
                )
                steps.complete(generation_path, generation_result)

            terminal = _fold_generation_terminal(
                db,
                run=run,
                steps=steps,
                result=generation_result,
            )
            if terminal is not None:
                return terminal

            assert isinstance(generation_result, AssistantTurn)
            full_content += generation_result.text
            final_usage = _owned_value(generation_result.usage)
            last_provider_event_seq = _owned_value(generation_result.last_provider_event_seq)
            pending_tool_calls = tuple(
                tool_call_from_state(tool_call) for tool_call in generation_result.tool_calls
            )
            if not pending_tool_calls:
                break

            messages.append(assistant_message_from_turn(generation_result))
            for tool_call in pending_tool_calls:
                tool_call_index_next += 1
                tool_path = f"turn/{turn_index}/tool/{tool_call_index_next}"
                tool_request = ToolStepRequest(
                    provider_call_id=tool_call.id,
                    tool_name=tool_call.name,
                    tool_call_index=tool_call_index_next,
                    arguments=cast(dict[str, JsonValue], dict(tool_call.arguments)),
                )
                tool_fingerprint = step_fingerprint(tool_request)
                tool_state = steps.read(tool_path, tool_replay_policy(tool_call.name))
                if tool_state is None:
                    tool_state = steps.prepare(tool_path, tool_fingerprint)
                else:
                    _assert_step_fingerprint(tool_state, tool_fingerprint)

                if tool_state.dispatch_phase is Completed:
                    tool_result = decode_tool(tool_state)
                else:
                    if tool_state.dispatch_phase is not Prepared:
                        raise AssertionError("tool step is not dispatchable")
                    tool_result = await _execute_tool_step(
                        db,
                        run=run,
                        steps=steps,
                        path=tool_path,
                        tool_call=tool_call,
                        tool_call_index=tool_call_index_next,
                        citation_n_next=citation_n_next,
                        emitter=emitter,
                    )
                citation_n_next = tool_result.next_citation_ordinal
                messages.append(tool_result_message(tool_result))

                if is_cancel_requested(db, run.id):
                    return _finalize_cancelled_execution(
                        db,
                        run=run,
                        steps=steps,
                        assistant_content=full_content,
                        usage=final_usage,
                        last_provider_event_seq=last_provider_event_seq,
                    )
        else:
            logger.warning(
                "chat_run.max_tool_iterations_exceeded",
                run_id=str(run.id),
                iterations=MAX_TOOL_ITERATIONS,
            )

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
    profile: LlmProfile,
    reasoning: ReasoningLevel,
    contract: ChatModelContract,
    max_output_tokens: int,
    tools: tuple[CanonicalTool, ...],
) -> PreparedChatRun:
    state = steps.read("prepare", ReplayPolicy.ReDispatchable)
    if state is not None:
        if state.dispatch_phase is not Completed:
            raise AssertionError("prepare database step is not completed")
        return decode_prepared(state)

    conversation = db.get(Conversation, run.conversation_id)
    user_message = db.get(Message, run.user_message_id)
    if conversation is None or user_message is None:
        raise AssertionError("chat run conversation or user message is missing")

    assembly = assemble_chat_context(
        db,
        run=run,
        profile=profile,
        reasoning=reasoning,
        contract=contract,
        max_output_tokens=max_output_tokens,
        tools=tools,
    )
    persist_prompt_assembly(db, run=run, assembly=assembly)
    reconcile_prompt_retrievals(db, run=run, assembly=assembly)
    attached_numbering = persist_attached_citations(db, run, assembly.attached_citations)
    prepared = PreparedChatRun(
        generate_intent=GenerateIntentState.from_intent(assembly.generate_intent),
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
    request: GenerationRequest,
    session_factory: sessionmaker[Session],
    settings: Settings,
    emitter: ChatRunEventEmitter,
    content_prefix: str,
    tool_call_index_next: int,
) -> AssistantTurn | ExpectedFailure | CancelledGeneration:
    iter_text = ""
    pending_tool_calls: list[ToolCall] = []
    continuation: Presence[ContinuationArtifact] = Absent()
    provider_tool_indices: dict[str, int] = {}
    tool_names_by_call_id: dict[str, str] = {}
    text_buffer = ""
    text_seq_start: int | None = None
    text_seq_end = 0
    last_text_flush = time.monotonic()
    last_provider_event_seq: int | None = None
    locally_truncated = False

    def flush_text_buffer() -> None:
        nonlocal text_buffer, text_seq_start, last_text_flush
        if not text_buffer:
            return
        emitter.assistant_text_delta(
            text=text_buffer,
            provider_event_seq_start=text_seq_start or text_seq_end,
            provider_event_seq_end=text_seq_end,
        )
        text_buffer = ""
        text_seq_start = None
        last_text_flush = time.monotonic()

    cancel_signal = asyncio.Event()
    cancel_watcher = asyncio.create_task(
        _watch_chat_run_cancel(db, run_id=run.id, cancel_signal=cancel_signal)
    )

    def mark_dispatch_uncertain() -> None:
        steps.mark_uncertain(path)

    stream = execute_generation_stream(
        request,
        session_factory=session_factory,
        runtime=steps.llm_runtime,
        settings=settings,
        cancel=cast(CancelSignal, cancel_signal),
        before_dispatch=mark_dispatch_uncertain,
        single_dispatch=True,
    )
    terminal_outcome: object | None = None
    try:
        async for event in stream:
            last_provider_event_seq = event.seq
            inner = event.event
            if isinstance(inner, StreamStart):
                emitter.assistant_activity(
                    phase="thinking",
                    provider_event_seq_start=event.seq,
                    provider_event_seq_end=event.seq,
                )
                continue
            if isinstance(inner, TextDelta):
                delta = inner.text
                if not locally_truncated:
                    current_chars = len(content_prefix) + len(iter_text)
                    if current_chars + len(delta) > MAX_ASSISTANT_CONTENT_LENGTH:
                        remaining = MAX_ASSISTANT_CONTENT_LENGTH - current_chars
                        delta = delta[: max(remaining, 0)] + TRUNCATION_NOTICE
                    if delta:
                        iter_text += delta
                        text_buffer += delta
                        text_seq_start = text_seq_start or event.seq
                        text_seq_end = event.seq
                        if (
                            len(text_buffer) >= CHAT_TEXT_FLUSH_MAX_CHARS
                            or len(text_buffer.encode("utf-8")) >= CHAT_TEXT_FLUSH_MAX_BYTES
                            or (time.monotonic() - last_text_flush) * 1000
                            >= CHAT_TEXT_FLUSH_INTERVAL_MS
                        ):
                            flush_text_buffer()
                    if len(content_prefix) + len(iter_text) >= MAX_ASSISTANT_CONTENT_LENGTH:
                        locally_truncated = True
                        flush_text_buffer()
                        cancel_signal.set()
                continue
            if isinstance(inner, ToolCallStart):
                flush_text_buffer()
                tool_names_by_call_id[inner.call_id] = inner.name
                provider_tool_indices.setdefault(
                    inner.call_id,
                    tool_call_index_next + len(provider_tool_indices) + 1,
                )
                emitter.tool_call_start(
                    tool_name=inner.name,
                    tool_call_index=provider_tool_indices[inner.call_id],
                    provider_tool_call_id=inner.call_id,
                    provider_event_seq_start=event.seq,
                    provider_event_seq_end=event.seq,
                )
                continue
            if isinstance(inner, ToolCallDelta):
                flush_text_buffer()
                if inner.call_id not in tool_names_by_call_id:
                    raise AssertionError("provider tool delta arrived before tool start")
                provider_tool_indices.setdefault(
                    inner.call_id,
                    tool_call_index_next + len(provider_tool_indices) + 1,
                )
                emitter.tool_call_delta(
                    tool_name=tool_names_by_call_id[inner.call_id],
                    tool_call_index=provider_tool_indices[inner.call_id],
                    provider_tool_call_id=inner.call_id,
                    input_delta=inner.arguments_delta,
                    input_preview=None,
                    provider_event_seq_start=event.seq,
                    provider_event_seq_end=event.seq,
                )
                continue
            if isinstance(inner, ToolCallDone):
                flush_text_buffer()
                tool_call = inner.tool_call
                tool_names_by_call_id[tool_call.id] = tool_call.name
                provider_tool_indices.setdefault(
                    tool_call.id,
                    tool_call_index_next + len(provider_tool_indices) + 1,
                )
                pending_tool_calls.append(tool_call)
                emitter.tool_call_done(
                    tool_name=tool_call.name,
                    tool_call_index=provider_tool_indices[tool_call.id],
                    provider_tool_call_id=tool_call.id,
                    input=dict(tool_call.arguments),
                    provider_event_seq_start=event.seq,
                    provider_event_seq_end=event.seq,
                )
                continue
            if isinstance(inner, ContinuationDelta):
                continuation = Present(inner.artifact)
                continue
            if isinstance(inner, UsageEvent):
                continue
            if isinstance(inner, TerminalEvent):
                flush_text_buffer()
                terminal_outcome = inner.outcome
                break
    except ApiError:
        latest_code = db.execute(
            text(
                "SELECT error_code FROM llm_calls WHERE owner_kind = 'chat_run' "
                "AND owner_id = :run_id ORDER BY call_seq DESC LIMIT 1"
            ),
            {"run_id": run.id},
        ).scalar_one_or_none()
        if latest_code != "budget_exceeded":
            raise
        return ExpectedFailure(
            assistant_content=content_prefix + iter_text,
            error_code="budget_exceeded",
            error_origin="budget",
            usage=owned_presence.absent(),
            support_id=_owned_optional(_latest_generation_support_id(db, run.id)),
            last_provider_event_seq=_owned_optional(last_provider_event_seq),
        )
    finally:
        cancel_watcher.cancel()
        with suppress(asyncio.CancelledError):
            await cancel_watcher
        await cast(AsyncGenerator[RuntimeStreamEvent, None], stream).aclose()

    if terminal_outcome is None:
        raise AssertionError("generation stream ended without a terminal event")

    full_content = content_prefix + iter_text
    usage = cast(dict[str, JsonValue] | None, usage_provider_json(terminal_outcome.meta.usage))
    support_id = _latest_generation_support_id(db, run.id)
    if isinstance(terminal_outcome, Cancelled):
        if locally_truncated:
            return ExpectedFailure(
                assistant_content=full_content,
                error_code="incomplete",
                error_origin="provider_response",
                usage=_owned_optional(usage),
                support_id=_owned_optional(support_id),
                last_provider_event_seq=_owned_optional(last_provider_event_seq),
            )
        return CancelledGeneration(
            assistant_content=full_content,
            usage=_owned_optional(usage),
            last_provider_event_seq=_owned_optional(last_provider_event_seq),
        )
    if isinstance(terminal_outcome, Incomplete):
        refused = terminal_outcome.status == "refused"
        return ExpectedFailure(
            assistant_content="" if refused else full_content,
            error_code="refused" if refused else "incomplete",
            error_origin="provider_stream" if refused else "provider_response",
            usage=_owned_optional(usage),
            support_id=_owned_optional(support_id),
            last_provider_event_seq=_owned_optional(last_provider_event_seq),
        )
    if isinstance(terminal_outcome, Failed):
        if isinstance(terminal_outcome.meta.billability, PossiblyBillable) or isinstance(
            terminal_outcome.failure, TransientExhausted
        ):
            raise UncertainChatStep(f"chat generation {path!r} has an ambiguous provider outcome")
        return ExpectedFailure(
            assistant_content=full_content,
            error_code=failure_code(terminal_outcome.failure),
            error_origin=failure_origin(terminal_outcome.failure),
            usage=_owned_optional(usage),
            support_id=_owned_optional(support_id),
            last_provider_event_seq=_owned_optional(last_provider_event_seq),
        )
    if not isinstance(terminal_outcome, Succeeded):
        raise AssertionError("unknown provider terminal outcome")
    return assistant_turn_result(
        text=iter_text,
        tool_calls=tuple(pending_tool_calls),
        continuation=continuation,
        usage=usage,
        support_id=support_id,
        last_provider_event_seq=last_provider_event_seq,
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
    finalize_run(
        db,
        run_id=run.id,
        assistant_content=result.assistant_content,
        assistant_status="error",
        run_status="error",
        done_status="error",
        error_code=result.error_code,
        error_origin=result.error_origin,
        support_id=_owned_value(result.support_id),
        usage=usage,
        last_provider_event_seq=last_seq,
        commit=False,
    )
    steps.clear()
    _log_chat_run_finished(db, run_id=run.id, outcome="Failed")
    return _failed_chat_execution(db, run_id=run.id, error_code=result.error_code)


async def _execute_tool_step(
    db: Session,
    *,
    run: ChatRun,
    steps: ChatStepRuntime,
    path: str,
    tool_call: ToolCall,
    tool_call_index: int,
    citation_n_next: int,
    emitter: ChatRunEventEmitter,
) -> ToolStepResult:
    if tool_call.name != WEB_SEARCH_TOOL_NAME or not isinstance(
        steps.web_search_provider, owned_presence.Present
    ):
        steps.lock_active_attempt()

    if tool_call.name == APP_SEARCH_TOOL_NAME:
        args = tool_call.arguments
        scopes, forced_error = _app_search_scopes_from_tool_args(args)
        kinds, filter_error = _app_search_string_array_from_tool_args(args, "kinds")
        forced_error = forced_error or filter_error
        formats, filter_error = _app_search_string_array_from_tool_args(args, "formats")
        forced_error = forced_error or filter_error
        authors, filter_error = _app_search_string_array_from_tool_args(args, "authors")
        forced_error = forced_error or filter_error
        roles, filter_error = _app_search_string_array_from_tool_args(args, "roles")
        forced_error = forced_error or filter_error
        run_result = execute_app_search(
            db,
            viewer_id=run.owner_user_id,
            conversation_id=run.conversation_id,
            user_message_id=run.user_message_id,
            assistant_message_id=run.assistant_message_id,
            scopes=scopes,
            query=str(args.get("query") or ""),
            kinds=kinds,
            formats=formats,
            authors=authors,
            roles=roles,
            tool_call_index=tool_call_index,
            forced_error=forced_error,
        )
        if run_result.tool_call_id is None:
            raise AssertionError("app search did not persist its tool row")
        numbering = number_tool_citation_candidates(
            db,
            tool_call_id=run_result.tool_call_id,
            start_ordinal=citation_n_next,
        )
        bind_provider_tool_call_events(
            db,
            run=run,
            tool_call_index=tool_call_index,
            tool_call_id=run_result.tool_call_id,
        )
        event = run_result.result_event()
        return _complete_tool_step(
            steps=steps,
            path=path,
            emitter=emitter,
            tool_call=tool_call,
            tool_call_id=run_result.tool_call_id,
            tool_call_index=tool_call_index,
            next_citation_ordinal=numbering.next_ordinal,
            output=app_search_tool_output(run_result, numbering),
            is_error=run_result.status == "error",
            event=event,
        )

    if tool_call.name == WEB_SEARCH_TOOL_NAME:
        args = tool_call.arguments
        freshness_arg = args.get("freshness_days")
        freshness_days = freshness_arg if isinstance(freshness_arg, int) else None
        filters: dict[str, object] = {
            "freshness_days": freshness_days,
            "allowed_domains": [],
            "blocked_domains": [],
        }
        if not isinstance(steps.web_search_provider, owned_presence.Present):
            error_code = "web_search_not_configured"
            tool_call_id = persist_tool_call_start(
                db,
                run=run,
                tool_call_index=tool_call_index,
                tool_name=WEB_SEARCH_TOOL_NAME,
                scope="public_web",
                requested_types=["mixed"],
            )
            persist_tool_call_error(db, tool_call_id=tool_call_id, error_code=error_code)
            bind_provider_tool_call_events(
                db,
                run=run,
                tool_call_index=tool_call_index,
                tool_call_id=tool_call_id,
            )
            event = ChatRunToolResultEventPayload(
                tool_call_id=tool_call_id,
                assistant_message_id=run.assistant_message_id,
                tool_name=WEB_SEARCH_TOOL_NAME,
                tool_call_index=tool_call_index,
                status="error",
                scope="public_web",
                types=["mixed"],
                filters=filters,
                error_code=error_code,
            )
            return _complete_tool_step(
                steps=steps,
                path=path,
                emitter=emitter,
                tool_call=tool_call,
                tool_call_id=tool_call_id,
                tool_call_index=tool_call_index,
                next_citation_ordinal=citation_n_next,
                output='{"error":"web_search is not configured"}',
                is_error=True,
                event=event,
            )

        steps.mark_uncertain(path)
        unpersisted = await execute_web_search(
            provider=steps.web_search_provider.value,
            conversation_id=run.conversation_id,
            user_message_id=run.user_message_id,
            assistant_message_id=run.assistant_message_id,
            query=str(args.get("query") or ""),
            freshness_days=freshness_days,
            tool_call_index=tool_call_index,
        )
        steps.lock_active_attempt()
        run_result = persist_web_search_run(
            db,
            unpersisted,
            start_citation_ordinal=citation_n_next,
        )
        bind_provider_tool_call_events(
            db,
            run=run,
            tool_call_index=tool_call_index,
            tool_call_id=run_result.tool_call_id,
        )
        return _complete_tool_step(
            steps=steps,
            path=path,
            emitter=emitter,
            tool_call=tool_call,
            tool_call_id=run_result.tool_call_id,
            tool_call_index=tool_call_index,
            next_citation_ordinal=run_result.next_citation_ordinal,
            output=run_result.model_output,
            is_error=run_result.status == "error",
            event=run_result.result_event,
        )

    if tool_call.name in {READ_RESOURCE_TOOL_NAME, INSPECT_RESOURCE_TOOL_NAME}:
        uri = str(tool_call.arguments.get("uri") or "")
        if tool_call.name == READ_RESOURCE_TOOL_NAME:
            read_result = execute_read_resource(
                db,
                viewer_id=run.owner_user_id,
                conversation_id=run.conversation_id,
                uri=uri,
            )
            tool_call_id = persist_tool_call_trace(
                db,
                run=run,
                tool_call_index=tool_call_index,
                tool_name=READ_RESOURCE_TOOL_NAME,
                result=read_result,
            )
            numbering = persist_read_evidence_candidate(
                db,
                run=run,
                tool_call_id=tool_call_id,
                result=read_result,
                start_ordinal=citation_n_next,
            )
            candidate_n = None
            next_ordinal = citation_n_next
            if numbering is not None:
                if len(numbering.rows) != 1:
                    raise AssertionError("read tool must own exactly one citation candidate")
                candidate_n = numbering.rows[0].candidate_ordinal
                next_ordinal = numbering.next_ordinal
            output = read_result.tool_output(n=candidate_n)
            result = read_result
        else:
            inspect_result = execute_inspect_resource(
                db,
                viewer_id=run.owner_user_id,
                conversation_id=run.conversation_id,
                uri=uri,
            )
            tool_call_id = persist_tool_call_trace(
                db,
                run=run,
                tool_call_index=tool_call_index,
                tool_name=INSPECT_RESOURCE_TOOL_NAME,
                result=inspect_result,
            )
            output = inspect_result.tool_output()
            result = inspect_result
            next_ordinal = citation_n_next

        bind_provider_tool_call_events(
            db,
            run=run,
            tool_call_index=tool_call_index,
            tool_call_id=tool_call_id,
        )
        event = ChatRunToolResultEventPayload.model_validate(
            tool_trace_event(
                run=run,
                tool_call_id=tool_call_id,
                tool_call_index=tool_call_index,
                tool_name=tool_call.name,
                result=result,
            )
        )
        return _complete_tool_step(
            steps=steps,
            path=path,
            emitter=emitter,
            tool_call=tool_call,
            tool_call_id=tool_call_id,
            tool_call_index=tool_call_index,
            next_citation_ordinal=next_ordinal,
            output=output,
            is_error=result.is_error,
            event=event,
        )

    if tool_call.name in WRITE_TOOL_NAMES:
        write_tool_call_id = persist_tool_call_start(
            db,
            run=run,
            tool_call_index=tool_call_index,
            tool_name=tool_call.name,
            scope="assistant_write",
            requested_types=[],
        )
        steps.mark_uncertain(path)
        steps.lock_active_attempt()
        outcome = execute_write_tool(
            db,
            run=run,
            tool_call_index=tool_call_index,
            tool_name=tool_call.name,
            args=dict(tool_call.arguments),
            effect_id=steps.generation_id(path),
        )
        if outcome.tool_call_id != write_tool_call_id:
            raise AssertionError("write tool changed its persisted tool-call identity")
        bind_provider_tool_call_events(
            db,
            run=run,
            tool_call_index=tool_call_index,
            tool_call_id=outcome.tool_call_id,
        )
        event = ChatRunToolResultEventPayload(
            tool_call_id=outcome.tool_call_id,
            assistant_message_id=run.assistant_message_id,
            tool_name=tool_call.name,
            tool_call_index=tool_call_index,
            status=outcome.status,
            scope="assistant_write",
            types=[],
            filters={},
            error_code=outcome.error_code,
        )
        return _complete_tool_step(
            steps=steps,
            path=path,
            emitter=emitter,
            tool_call=tool_call,
            tool_call_id=outcome.tool_call_id,
            tool_call_index=tool_call_index,
            next_citation_ordinal=citation_n_next,
            output=outcome.tool_output_json,
            is_error=outcome.is_error,
            event=event,
        )

    error_code = "unknown_tool"
    tool_call_id = persist_tool_call_start(
        db,
        run=run,
        tool_call_index=tool_call_index,
        tool_name=tool_call.name,
        scope="provider_tool",
        requested_types=[],
    )
    persist_tool_call_error(db, tool_call_id=tool_call_id, error_code=error_code)
    bind_provider_tool_call_events(
        db,
        run=run,
        tool_call_index=tool_call_index,
        tool_call_id=tool_call_id,
    )
    event = ChatRunToolResultEventPayload(
        tool_call_id=tool_call_id,
        assistant_message_id=run.assistant_message_id,
        tool_name=tool_call.name,
        tool_call_index=tool_call_index,
        status="error",
        scope="provider_tool",
        types=[],
        filters={},
        error_code=error_code,
    )
    return _complete_tool_step(
        steps=steps,
        path=path,
        emitter=emitter,
        tool_call=tool_call,
        tool_call_id=tool_call_id,
        tool_call_index=tool_call_index,
        next_citation_ordinal=citation_n_next,
        output=f'{{"error":"unknown tool: {tool_call.name}"}}',
        is_error=True,
        event=event,
    )


def _complete_tool_step(
    *,
    steps: ChatStepRuntime,
    path: str,
    emitter: ChatRunEventEmitter,
    tool_call: ToolCall,
    tool_call_id: UUID,
    tool_call_index: int,
    next_citation_ordinal: int,
    output: str,
    is_error: bool,
    event: ChatRunToolResultEventPayload,
) -> ToolStepResult:
    result = ToolStepResult(
        tool_call_id=tool_call_id,
        tool_name=tool_call.name,
        tool_call_index=tool_call_index,
        model_output=ToolModelOutput(
            call_id=tool_call.id,
            output=output,
            is_error=is_error,
        ),
        next_citation_ordinal=next_citation_ordinal,
        result_event=event,
    )
    emitter.tool_result(event.model_dump(mode="json"))
    steps.complete(path, result)
    return result


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
        usage=_owned_optional(usage),
        last_provider_event_seq=_owned_optional(last_provider_event_seq),
    )
    fingerprint = step_fingerprint(request)
    state = steps.read("publication", ReplayPolicy.ReDispatchable)
    if state is None:
        state = steps.prepare("publication", fingerprint)
    else:
        _assert_step_fingerprint(state, fingerprint)
    if state.dispatch_phase is not Prepared:
        raise AssertionError("publication step cannot be replayed on an active run")

    steps.lock_active_attempt()
    citation_started_at = time.monotonic()
    citation_result = publish_chat_citations(
        db,
        run=run,
        generated_markdown=full_content,
        emitter=emitter,
    )
    citation_finalize_ms = round((time.monotonic() - citation_started_at) * 1000)
    degraded_support_id: str | None = None
    if isinstance(citation_result, DegradedCitations):
        degraded_support_id = uuid4().hex[:12]
        finalize_run(
            db,
            run_id=run.id,
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
            run_id=run.id,
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
        {"run_id": run.id},
    ).scalar_one()
    steps.complete_publication(
        PublicationStepResult(
            outcome=outcome_kind,
            message_id=run.assistant_message_id,
            terminal_event_seq=terminal_event_seq,
        )
    )
    _log_chat_run_finished(
        db,
        run_id=run.id,
        outcome=outcome_kind,
        citation_finalize_ms=citation_finalize_ms,
    )
    if isinstance(citation_result, DegradedCitations):
        if degraded_support_id is None:
            raise AssertionError("degraded publication is missing a support id")
        return DegradedChatExecution(
            run_id=run.id,
            message_id=run.assistant_message_id,
            warning_code=citation_result.warning_code,
            support_id=degraded_support_id,
        )
    return PublishedChatExecution(
        run_id=run.id,
        message_id=run.assistant_message_id,
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


def _owned_optional[T](value: T | None) -> owned_presence.Presence[T]:
    return owned_presence.absent() if value is None else owned_presence.present(value)


def _owned_value[T](value: owned_presence.Presence[T]) -> T | None:
    return value.value if isinstance(value, owned_presence.Present) else None
