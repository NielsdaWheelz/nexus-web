"""Durable chat-run service.

 One chat send is one durable run. HTTP creates/cancels/reads runs; the worker
executes the admission-frozen generation through the selected backend and tails
persisted events for the stream route.
"""

from __future__ import annotations

import asyncio
import dataclasses
import time
from collections.abc import Mapping
from contextlib import suppress
from datetime import UTC, datetime
from typing import Literal, assert_never
from uuid import UUID, uuid4

from provider_runtime.types import (
    Absent as RuntimeAbsent,
)
from provider_runtime.types import (
    Cancelled as ProviderCancelled,
)
from provider_runtime.types import (
    Failed as ProviderFailed,
)
from provider_runtime.types import (
    Incomplete as ProviderIncomplete,
)
from provider_runtime.types import (
    InvalidStructuredOutput,
    InvalidToolArguments,
    ProviderContextTooLarge,
    TextContent,
    TokenUsage,
    TransientExhausted,
)
from provider_runtime.types import (
    Present as RuntimePresent,
)
from provider_runtime.types import (
    Succeeded as ProviderSucceeded,
)
from pydantic import JsonValue, TypeAdapter
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.config import Settings
from nexus.db.models import (
    ChatPromptAssembly,
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
from nexus.schemas.llm import (
    CatalogDefinitionStale,
    GenerationSelectionUnavailable,
    InvalidGenerationSelection,
    RunSelectionOut,
    Selectable,
)
from nexus.services import generation_policy
from nexus.services.agent_tools_mcp import compose_codex_generation_tool_binding
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
from nexus.services.chat_run_selection import chat_generation_spec, run_selection_out
from nexus.services.chat_run_steps import (
    AssistantTurn,
    CancelledGeneration,
    ChatStepRuntime,
    ExpectedFailure,
    GenerationStepResultEnvelope,
    PublicationRequest,
    PublicationStepResult,
    assistant_turn_result,
    step_fingerprint,
)
from nexus.services.chat_run_validation import validate_pre_phase
from nexus.services.codex_generation_contract import (
    GenerationUsage,
    normalized_failure,
)
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_collection_revision,
)
from nexus.services.context_assembler import (
    CHAT_PROMPT_TEMPLATE_REVISION,
    assemble_chat_context,
    chat_prompt_payload_ref,
    persist_prompt_assembly,
)
from nexus.services.conversations import DEFAULT_CONVERSATION_TITLE
from nexus.services.durable_step_journal import (
    Completed,
    Prepared,
    ReplayPolicy,
    StepReplayState,
    Uncertain,
    decode_step_result,
    encode_step_result,
)
from nexus.services.generation_admission import GenerationOperationUnavailable
from nexus.services.generation_catalog import (
    CatalogDefinitionStaleError,
    GenerationCatalogService,
    GenerationCatalogSnapshot,
    GenerationSelectionUnavailableError,
    InvalidGenerationSelectionError,
    ResolvedCatalogPair,
)
from nexus.services.generation_events import (
    BackendEvent,
    BackendTerminal,
    BackendTextDelta,
    BackendToolObserved,
    BackendToolProposed,
    BackendUsageObserved,
    CodexTerminalEvidence,
    ProviderTerminalEvidence,
)
from nexus.services.generation_intent import GenerationIntent
from nexus.services.generation_selection import (
    CodexPersonalSelection,
    ProviderApiSelection,
)
from nexus.services.generation_service import (
    ChatToolAuthority,
    GenerationService,
)
from nexus.services.generation_spec import (
    FrozenToolScope,
    GenerationSpec,
    generation_fact_digest,
)
from nexus.services.llm_execution import (
    EncodedGenerationTerminal,
    ExecutionRuntime,
    GenerationExecutionRequest,
    JobGenerationJournal,
    execute_generation,
)
from nexus.services.llm_ledger import LlmCallOwner, read_model_turns
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.redact import safe_kv
from nexus.services.resource_graph.context import (
    add_context_ref_without_commit,
    list_context_refs,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.tool_authority import (
    compose_deferred_generation_tool_executor,
)
from nexus.services.tool_runtime.composition import (
    ComposedToolRuntime,
    FrozenToolOperation,
)

logger = get_logger(__name__)


CHAT_TEXT_FLUSH_INTERVAL_MS = 33
CHAT_TEXT_FLUSH_MAX_CHARS = 512
CHAT_TEXT_FLUSH_MAX_BYTES = 2048
CHAT_CANCEL_POLL_INTERVAL_SECONDS = 0.25


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
    spec = chat_generation_spec(run)
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
            "nexus.llm.backend": spec.selection.route,
            "nexus.llm.model": spec.display_at_dispatch.model_label,
            "nexus.llm.reasoning": spec.display_at_dispatch.reasoning_label,
            "nexus.chat_run.queue_wait_ms": queue_wait_ms,
            "nexus.chat_run.execution_ms": execution_ms,
            "nexus.chat_run.citation_finalize_ms": citation_finalize_ms,
            "nexus.chat_run.first_visible_text_ms": first_visible_text_ms,
            "nexus.chat_run.generation_event_count": provider_event_count,
        },
    )


type ExactChatSelection = CodexPersonalSelection | ProviderApiSelection


async def admit_chat_selection(
    catalog: GenerationCatalogService,
    *,
    catalog_definition_revision: str,
    selection: ExactChatSelection,
) -> ResolvedCatalogPair:
    try:
        return await catalog.final_chat_selection_check(
            catalog_definition_revision=catalog_definition_revision,
            selection=selection,
        )
    except CatalogDefinitionStaleError as error:
        failure = CatalogDefinitionStale(
            current_definition_revision=error.current_definition_revision
        )
        raise ApiError(
            ApiErrorCode.E_CATALOG_DEFINITION_STALE,
            "Generation catalog changed; refresh and confirm the selection again",
            details=failure.model_dump(mode="json"),
        ) from error
    except InvalidGenerationSelectionError as error:
        failure = InvalidGenerationSelection(
            field=owned_presence.Present(value="selection"),
            explanation="The exact generation selection is not in the configured catalog.",
        )
        raise ApiError(
            ApiErrorCode.E_INVALID_GENERATION_SELECTION,
            failure.explanation,
            details=failure.model_dump(mode="json"),
        ) from error
    except GenerationSelectionUnavailableError as error:
        if isinstance(error.pair.state, Selectable):
            raise AssertionError("unavailable selection carried Selectable state") from error
        failure = GenerationSelectionUnavailable(
            selection=error.pair.selection,
            state=error.pair.state,
        )
        raise ApiError(
            ApiErrorCode.E_GENERATION_SELECTION_UNAVAILABLE,
            "The exact generation selection is not currently runnable",
            details=failure.model_dump(mode="json"),
        ) from error


def _chat_tool_scope(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
) -> FrozenToolScope:
    refs = {
        context.target.uri
        for context in list_context_refs(
            db,
            viewer_id=viewer_id,
            conversation_id=conversation_id,
        )
    }
    return FrozenToolScope(admitted_refs=tuple(sorted(refs)), predicates=())


def persist_frozen_chat_admission_in_current_transaction(
    db: Session,
    *,
    run: ChatRun,
    turn_context: ChatRunTurnContext | None,
    pair: ResolvedCatalogPair,
    catalog_definition_revision: str,
    tool_authority: ChatToolAuthority,
    generation_service: GenerationService,
) -> tuple[GenerationSpec, RunSelectionOut]:
    """Persist one complete Chat prompt/spec before its queue row can exist."""

    assembly = assemble_chat_context(
        db,
        run=run,
        max_context_tokens=pair.effective_context_budget_tokens,
        max_output_tokens=pair.effective_output_budget_tokens,
        turn_context=turn_context,
        tool_authority=tool_authority,
    )
    try:
        spec = generation_service.freeze_chat_from_pair(
            catalog_definition_revision=catalog_definition_revision,
            pair=pair,
            tool_authority=tool_authority,
            scope=_chat_tool_scope(
                db,
                viewer_id=run.owner_user_id,
                conversation_id=run.conversation_id,
            ),
            intent=assembly.generate_intent,
            prompt_template_revision=CHAT_PROMPT_TEMPLATE_REVISION,
            prompt_payload_ref=chat_prompt_payload_ref(
                run_id=run.id,
                intent=assembly.generate_intent,
            ),
        )
    except GenerationOperationUnavailable as error:
        raise ApiError(
            ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE,
            "The selected generation route cannot run its complete tool plan",
        ) from error
    run.generation_spec = spec.model_dump(mode="json", by_alias=True)
    db.add(run)
    db.flush()
    if turn_context is not None:
        db.add(turn_context)
    persist_prompt_assembly(db, run=run, assembly=assembly)
    reconcile_prompt_retrievals(db, run=run, assembly=assembly)
    persist_attached_citations(db, run, assembly.attached_citations)
    return spec, run_selection_out(
        run,
        pair=pair,
        observed_at=datetime.now(UTC),
    )


async def create_chat_run(
    db: Session,
    *,
    viewer_id: UUID,
    destination: ChatDestination,
    reader_selection: ReaderSelectionInput | None,
    content: str,
    catalog_definition_revision: str,
    selection: ExactChatSelection,
    tool_authority: ChatToolAuthority,
    idempotency_key: str | None,
    catalog: GenerationCatalogService,
    tool_runtime: ComposedToolRuntime,
) -> ChatRunResponse:
    normalized_key = normalize_idempotency_key(idempotency_key)
    selection_key = reader_selection.key if reader_selection is not None else None

    # 1. Hash answer-determining identity only — no live source resolution.
    payload_hash = compute_payload_hash(
        destination=destination,
        content=content,
        catalog_definition_revision=catalog_definition_revision,
        selection=selection,
        tool_authority=tool_authority,
        reader_selection_key=selection_key,
    )

    existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
    if existing is not None:
        raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
        existing_id = existing.id
        db.rollback()
        snapshot = await catalog.read_chat()
        existing = db.get(ChatRun, existing_id)
        if existing is None or existing.owner_user_id != viewer_id:
            raise AssertionError("idempotent Chat run disappeared")
        return build_chat_run_response(
            db,
            viewer_id,
            existing,
            run_selection=run_selection_out(existing, catalog_snapshot=snapshot),
        )

    # Rate + destination fast-fail (no catalog resolution: a replay
    # whose live source has since changed must still return before we touch it).
    validate_pre_phase(
        db,
        viewer_id,
        destination=destination,
        content=content,
    )
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
        # 2. Idempotency lock; a matching replay returns before source/revision
        #    validation, while a payload mismatch fails.
        lock_chat_generation_admission_in_current_transaction(db)
        lock_idempotency_key(db, viewer_id, normalized_key)
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

        # 7. User message (with snapshot), pending assistant, and transient run.
        prepared = prepare_messages(
            db,
            viewer_id,
            conversation_id,
            parent_message_id,
            branch_anchor,
            content,
            snapshot_json,
        )
        run_id = uuid4()
        run = ChatRun(
            id=run_id,
            owner_user_id=viewer_id,
            conversation_id=prepared.conversation.id,
            user_message_id=prepared.user_message.id,
            assistant_message_id=prepared.assistant_message.id,
            idempotency_key=normalized_key,
            payload_hash=payload_hash,
            status="queued",
        )
        turn_context = None
        if subject_ref is not None:
            turn_context = ChatRunTurnContext(
                chat_run_id=run.id,
                requested_subject_scheme=subject_ref.scheme,
                requested_subject_id=subject_ref.id,
                subject_scheme=subject_ref.scheme,
                subject_id=subject_ref.id,
                subject_context_edge_id=subject_context_edge_id,
            )

        # 8. Render/freeze the complete prompt, scope, tool plan, and exact
        #    catalog receipt before the durable run or job can exist.
        spec, run_selection = persist_frozen_chat_admission_in_current_transaction(
            db,
            run=run,
            turn_context=turn_context,
            pair=pair,
            catalog_definition_revision=catalog_definition_revision,
            tool_authority=tool_authority,
            generation_service=generation_service,
        )
        ChatRunEventEmitter(db, run).meta(
            {
                "run_id": str(run.id),
                "conversation_id": str(prepared.conversation.id),
                "user_message_id": str(prepared.user_message.id),
                "assistant_message_id": str(prepared.assistant_message.id),
                "run_selection": run_selection.model_dump(mode="python"),
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
            payload={
                "run_id": str(run.id),
                "generation_spec_fingerprint": spec.fingerprint,
            },
            priority=50,
            max_attempts=3,
            dedupe_key=f"chat_run:{run.id}",
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return build_chat_run_response(
        db,
        viewer_id,
        run,
        run_selection=run_selection,
    )


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


def get_chat_run(
    db: Session,
    *,
    viewer_id: UUID,
    run_id: UUID,
    catalog_snapshot: GenerationCatalogSnapshot,
) -> ChatRunResponse:
    run = get_run_for_owner(db, viewer_id, run_id)
    return build_chat_run_response(
        db,
        viewer_id,
        run,
        run_selection=run_selection_out(run, catalog_snapshot=catalog_snapshot),
    )


def list_chat_runs_for_conversation(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    status: CHAT_RUN_STATUS_FILTER,
    catalog_snapshot: GenerationCatalogSnapshot,
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
    return [
        build_chat_run_response(
            db,
            viewer_id,
            run,
            run_selection=run_selection_out(run, catalog_snapshot=catalog_snapshot),
        )
        for run in runs
    ]


def cancel_chat_run(
    db: Session,
    *,
    viewer_id: UUID,
    run_id: UUID,
    catalog_snapshot: GenerationCatalogSnapshot,
) -> ChatRunResponse:
    owned = get_run_for_owner(db, viewer_id, run_id)
    lock_chat_generation_admission_in_current_transaction(db)
    run = lock_chat_run_for_update(db, owned.id)
    if run is None or run.owner_user_id != viewer_id:
        raise AssertionError("owned chat run disappeared before cancellation")
    if run.status in TERMINAL_RUN_STATUSES:
        return build_chat_run_response(
            db,
            viewer_id,
            run,
            run_selection=run_selection_out(run, catalog_snapshot=catalog_snapshot),
        )
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
    return build_chat_run_response(
        db,
        viewer_id,
        run,
        run_selection=run_selection_out(run, catalog_snapshot=catalog_snapshot),
    )


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
) -> ChatExecutionResult:
    """Execute one claimed chat job; defects escape into queue recovery."""
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
) -> ChatExecutionResult:
    run = db.get(ChatRun, run_id)
    if run is None:
        steps.clear()
        return SkippedChatExecution(reason="MissingRun")
    if run.status in TERMINAL_RUN_STATUSES:
        steps.clear()
        return SkippedChatExecution(reason="Terminal")
    spec, intent = _frozen_chat_admission(db, run=run, job=steps.job)
    operation = steps.llm_runtime.admission.model_tool_operation(spec)
    if operation is None:
        raise AssertionError("Chat GenerationSpec is missing its model-tool plan")
    mark_running(db, run.id)
    run = db.get(ChatRun, run.id)
    if run is None:
        raise AssertionError("running chat run disappeared")
    if run.status in TERMINAL_RUN_STATUSES:
        steps.clear()
        return SkippedChatExecution(reason="Terminal")
    generation_path = "generation/1"
    generation_state = steps.read(generation_path, ReplayPolicy.BilledOnce)
    cancellation_requested = is_cancel_requested(db, run.id)
    if cancellation_requested and generation_state is None:
        return _finalize_cancelled_execution(db, run=run, steps=steps)

    rate_limiter = get_rate_limiter()
    inflight_acquired = not cancellation_requested
    if inflight_acquired:
        rate_limiter.acquire_inflight_slot(run.owner_user_id)
    try:
        full_content = ""
        final_usage: dict[str, JsonValue] | None = None
        last_provider_event_seq: int | None = None
        emitter = ChatRunEventEmitter(db, run, lease_fence=steps.lock_active_attempt)
        if generation_state is None:
            generation_state = steps.prepare(
                generation_path,
                spec.fingerprint,
            )
        elif generation_state.dispatch_phase not in {Prepared, Uncertain, Completed}:
            raise AssertionError("chat generation step is not dispatchable")

        generation_result = await _dispatch_generation_step(
            db,
            run=run,
            steps=steps,
            path=generation_path,
            generation_id=generation_state.generation_id,
            spec=spec,
            intent=intent,
            operation=operation,
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
        if inflight_acquired:
            rate_limiter.release_inflight_slot(run.owner_user_id)


def _frozen_chat_admission(
    db: Session,
    *,
    run: ChatRun,
    job: JobRow,
) -> tuple[GenerationSpec, GenerationIntent]:
    """Load the exact admission-time spec/prompt pair; never reconstruct it."""

    spec = chat_generation_spec(run)
    if spec.operation != "chat" or spec.selection_source != "ChatRun":
        raise AssertionError("Chat run carries a non-Chat GenerationSpec")
    if job.payload.get("generation_spec_fingerprint") != spec.fingerprint:
        raise AssertionError("Chat job differs from its frozen GenerationSpec")
    assembly = db.scalar(select(ChatPromptAssembly).where(ChatPromptAssembly.chat_run_id == run.id))
    if assembly is None or (
        assembly.conversation_id != run.conversation_id
        or assembly.assistant_message_id != run.assistant_message_id
    ):
        raise AssertionError("Chat run is missing its frozen prompt assembly")
    try:
        intent = GenerationIntent.model_validate(assembly.generation_intent)
    except ValueError as error:
        raise AssertionError("Chat prompt assembly contains an invalid GenerationIntent") from error
    intent_digest = generation_fact_digest(intent.model_dump(mode="json"))
    if (
        assembly.generation_intent_digest != intent_digest
        or spec.prompt_payload_ref.payload_digest != intent_digest
    ):
        raise AssertionError("Chat prompt assembly differs from its frozen GenerationSpec")
    return spec, intent


def _initial_chat_citation_ordinal(db: Session, *, run: ChatRun) -> int:
    """Recover the immutable attached-evidence cursor, excluding later tools."""

    value = db.scalar(
        text(
            """
            SELECT COALESCE(MAX(retrieval.citation_candidate_ordinal), 0) + 1
            FROM message_retrievals AS retrieval
            JOIN message_tool_calls AS tool_call ON tool_call.id = retrieval.tool_call_id
            WHERE tool_call.assistant_message_id = :assistant_message_id
              AND tool_call.tool_call_index = 0
            """
        ),
        {"assistant_message_id": run.assistant_message_id},
    )
    if type(value) is not int or value < 1:
        raise AssertionError("Chat attached citation cursor is invalid")
    return value


async def _dispatch_generation_step(
    db: Session,
    *,
    run: ChatRun,
    steps: ChatStepRuntime,
    path: str,
    generation_id: UUID,
    spec: GenerationSpec,
    intent: GenerationIntent,
    operation: FrozenToolOperation,
    session_factory: sessionmaker[Session],
    settings: Settings,
    emitter: ChatRunEventEmitter,
) -> AssistantTurn | ExpectedFailure | CancelledGeneration | RescheduleRequested:
    """Execute one exact frozen generation through either supported route."""
    from nexus.services.tool_runtime.execution import ChatToolExecutionProjection

    observed_text_parts: list[str] = []
    observed_text_by_child: dict[int, list[str]] = {}
    observed_usage_by_child = _recorded_chat_usage(db, generation_id=generation_id)
    recorded_usage_by_child = dict(observed_usage_by_child)
    observed_event_count = 0
    text_coalescer = _ChatTextCoalescer(emitter)

    async def observe(event: BackendEvent) -> None:
        nonlocal observed_event_count
        observed_event_count += 1
        sequence = observed_event_count
        if isinstance(event, BackendTextDelta):
            observed_text_parts.append(event.text)
            observed_text_by_child.setdefault(event.child_seq, []).append(event.text)
            await text_coalescer.add(
                text=event.text,
                sequence=sequence,
            )
            return
        await text_coalescer.flush()
        if isinstance(event, BackendToolObserved | BackendToolProposed):
            emitter.assistant_activity(
                phase="tool_calling",
                provider_event_seq_start=sequence,
                provider_event_seq_end=sequence,
            )
        elif isinstance(event, BackendUsageObserved):
            usage = _usage_document(event.usage)
            recorded_usage = recorded_usage_by_child.get(event.child_seq)
            if recorded_usage is not None and recorded_usage != usage:
                raise AssertionError("Chat streamed usage differs from its accepted child ledger")
            observed_usage_by_child[event.child_seq] = usage

    projection = ChatToolExecutionProjection(
        run_id=run.id,
        initial_citation_ordinal=_initial_chat_citation_ordinal(db, run=run),
    )
    codex_binding = None

    cancel_signal = asyncio.Event()
    if is_cancel_requested(db, run.id):
        cancel_signal.set()
    cancel_watcher: asyncio.Task[None] | None = None

    # First dispatch commits through the prepare step, while a Prepared capacity
    # replay arrives with the post-mark-running read transaction still active.
    # Close both shapes before health, UDS, or MCP I/O begins.
    db.commit()

    def encode_native_terminal(
        terminal: BackendTerminal, *, host_cancelled: bool = False
    ) -> EncodedGenerationTerminal:
        return EncodedGenerationTerminal(
            terminal_result=encode_step_result(
                GenerationStepResultEnvelope(
                    root=_chat_generation_terminal_result(
                        terminal,
                        observed_text="".join(observed_text_parts),
                        observed_text_by_child=observed_text_by_child,
                        observed_usage_by_child=observed_usage_by_child,
                        last_sequence=observed_event_count + 1,
                        generation_id=generation_id,
                        host_cancelled=host_cancelled,
                    )
                )
            ),
            orchestration_stop="cancelled" if host_cancelled else None,
        )

    def resolve_terminal(
        terminal_db: Session, terminal: BackendTerminal
    ) -> EncodedGenerationTerminal:
        locked_run = lock_chat_run_for_update(terminal_db, run.id)
        if locked_run is None:
            raise AssertionError("chat run disappeared before generation terminal")
        host_cancelled = (
            locked_run.cancel_requested_at is not None
            and not _backend_terminal_is_cancelled(terminal)
        )
        if host_cancelled:
            cancel_signal.set()
        return encode_native_terminal(terminal, host_cancelled=host_cancelled)

    tool_executor = None
    admission_binder = None
    before_terminal = None
    if isinstance(spec.selection, CodexPersonalSelection):
        codex_binding = compose_codex_generation_tool_binding(
            session_factory=session_factory,
            user_id=run.owner_user_id,
            owner=LlmCallOwner(kind="chat_run", id=run.id),
            generation_id=generation_id,
            job_context=steps.execution_context,
            operation=operation,
            spec=spec,
            intent=intent,
            settings=settings,
            projection=projection,
        )
        admission_binder = codex_binding.bind_admission
        before_terminal = codex_binding.wait_until_idle
    elif isinstance(spec.selection, ProviderApiSelection):
        tool_executor = compose_deferred_generation_tool_executor(
            session_factory=session_factory,
            user_id=run.owner_user_id,
            owner=LlmCallOwner(kind="chat_run", id=run.id),
            generation_id=generation_id,
            job_context=steps.execution_context,
            operation=operation,
            projection=projection,
        )
    else:
        assert_never(spec.selection)

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
                generation_id=generation_id,
                spec=spec,
                intent=intent,
                journal=JobGenerationJournal(
                    context=steps.execution_context,
                    step_path=path,
                    lock_dispatch=steps.lock_dispatch,
                ),
                bind_admission=admission_binder,
                tool_executor=tool_executor,
            ),
            session_factory=session_factory,
            runtime=steps.llm_runtime,
            observe_event=observe,
            cancel_signal=cancel_signal,
            before_terminal=before_terminal,
            resolve_terminal=resolve_terminal,
            encode_terminal=encode_native_terminal,
            encode_failure=lambda code, detail: _encode_chat_failure(
                code,
                detail=detail,
                generation_id=generation_id,
                observed_text="".join(observed_text_parts),
                usage=_aggregate_usage(observed_usage_by_child),
                last_sequence=observed_event_count,
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
                if codex_binding is not None:
                    await codex_binding.drain_and_close()

    if isinstance(result, RescheduleRequested):
        return result
    return decode_step_result(result.terminal_result, GenerationStepResultEnvelope).root


def _chat_generation_terminal_result(
    terminal: BackendTerminal,
    *,
    observed_text: str,
    observed_text_by_child: dict[int, list[str]],
    observed_usage_by_child: dict[int, dict[str, JsonValue]],
    last_sequence: int | None,
    generation_id: UUID,
    host_cancelled: bool = False,
) -> AssistantTurn | ExpectedFailure | CancelledGeneration:
    terminal_usage = _terminal_usage_document(terminal)
    usages = dict(observed_usage_by_child)
    if terminal_usage is not None:
        observed_terminal_usage = usages.get(terminal.child_seq)
        if observed_terminal_usage is not None and observed_terminal_usage != terminal_usage:
            raise AssertionError("Chat terminal usage differs from its streamed usage")
        usages[terminal.child_seq] = terminal_usage
    usage = _aggregate_usage(usages)
    child_text = "".join(observed_text_by_child.get(terminal.child_seq, ()))

    if isinstance(terminal.evidence, CodexTerminalEvidence):
        native = terminal.evidence.native
        if native.status == "succeeded" and native.final_text != child_text:
            raise AssertionError("Codex terminal text differs from its streamed text fold")
        if native.status != "succeeded" and native.final_text:
            raise AssertionError("non-success Codex terminal exposed provider text")
        status = native.status
        error_code = (
            normalized_failure(native.failure.kind)
            if native.status == "failed" and native.failure is not None
            else None
        )
        if native.status == "failed" and error_code is None:
            raise AssertionError("failed Codex generation omitted failure")
    elif isinstance(terminal.evidence, ProviderTerminalEvidence):
        outcome = terminal.evidence.outcome
        if isinstance(outcome, ProviderSucceeded):
            content = outcome.response.content
            if not isinstance(content, TextContent):
                raise AssertionError("Chat ProviderApi success returned structured output")
            if content.tool_calls:
                raise AssertionError("final Chat ProviderApi terminal retained tool proposals")
            if content.text != child_text:
                raise AssertionError("Provider terminal text differs from its streamed text fold")
            status = "succeeded"
            error_code = None
        elif isinstance(outcome, ProviderCancelled):
            status = "cancelled"
            error_code = None
        elif isinstance(outcome, ProviderIncomplete | ProviderFailed):
            status = "failed"
            error_code = _provider_chat_failure_code(outcome)
        else:
            assert_never(outcome)
    else:
        assert_never(terminal.evidence)

    if host_cancelled or status == "cancelled":
        return CancelledGeneration(
            assistant_content=observed_text,
            usage=_owned_usage(usage),
            last_provider_event_seq=_owned_sequence(last_sequence),
        )
    if status == "failed":
        if error_code is None:
            raise AssertionError("failed Chat generation omitted its domain failure")
        return ExpectedFailure(
            assistant_content=observed_text,
            error_code=error_code,
            usage=_owned_usage(usage),
            support_id=_owned_text(generation_id.hex[:12]),
            last_provider_event_seq=_owned_sequence(last_sequence),
        )
    return assistant_turn_result(
        text=observed_text,
        tool_calls=(),
        usage=usage,
        support_id=generation_id.hex[:12],
        last_provider_event_seq=last_sequence,
    )


def _usage_document(usage: GenerationUsage | TokenUsage) -> dict[str, JsonValue]:
    if isinstance(usage, GenerationUsage):
        return usage.model_dump(mode="json")
    return {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
        "reasoning_tokens": _runtime_optional_int(usage.reasoning_tokens),
        "cache_read_input_tokens": _runtime_optional_int(usage.cache_read_input_tokens),
        "cache_write_input_tokens": _runtime_optional_int(usage.cache_write_input_tokens),
    }


def _runtime_optional_int(value: RuntimePresent[int] | RuntimeAbsent) -> int | None:
    if isinstance(value, RuntimePresent):
        return value.value
    if isinstance(value, RuntimeAbsent):
        return None
    assert_never(value)


def _terminal_usage_document(terminal: BackendTerminal) -> dict[str, JsonValue] | None:
    evidence = terminal.evidence
    if isinstance(evidence, CodexTerminalEvidence):
        usage = evidence.native.usage
        return None if usage is None else _usage_document(usage)
    if isinstance(evidence, ProviderTerminalEvidence):
        usage = evidence.outcome.meta.usage
        return _usage_document(usage.value) if isinstance(usage, RuntimePresent) else None
    assert_never(evidence)


def _aggregate_usage(
    usage_by_child: dict[int, dict[str, JsonValue]],
) -> dict[str, JsonValue] | None:
    if not usage_by_child:
        return None
    required = ("input_tokens", "output_tokens", "total_tokens")
    optional = (
        "reasoning_tokens",
        "cache_read_input_tokens",
        "cache_write_input_tokens",
    )
    result: dict[str, JsonValue] = {
        key: sum(_usage_int(usage, key) for usage in usage_by_child.values()) for key in required
    }
    for key in optional:
        values = [usage.get(key) for usage in usage_by_child.values()]
        result[key] = (
            sum(_usage_optional_int(value, key=key) for value in values if value is not None)
            if any(value is not None for value in values)
            else None
        )
    return result


def _recorded_chat_usage(db: Session, *, generation_id: UUID) -> dict[int, dict[str, JsonValue]]:
    """Restore accepted paid usage without publishing historical stream events again."""

    usages: dict[int, dict[str, JsonValue]] = {}
    token_presence = TypeAdapter(owned_presence.Presence[int])
    for child in read_model_turns(db, generation_id=generation_id):
        if child.usage is None:
            continue
        usage: dict[str, JsonValue] = {
            key: _usage_int(child.usage, key)
            for key in ("input_tokens", "output_tokens", "total_tokens")
        }
        for key in ("reasoning_tokens", "cache_read_input_tokens", "cache_write_input_tokens"):
            value = child.usage.get(key)
            if child.route_request_identity["kind"] == "ProviderApi":
                presence = token_presence.validate_python(value, strict=True)
                value = presence.value if isinstance(presence, owned_presence.Present) else None
            usage[key] = None if value is None else _usage_optional_int(value, key=key)
        usages[child.turn_seq] = usage
    return usages


def _usage_int(usage: Mapping[str, object], key: str) -> int:
    value = usage.get(key)
    if type(value) is not int or value < 0:
        raise AssertionError(f"Chat usage {key} is not a non-negative integer")
    return value


def _usage_optional_int(value: object, *, key: str) -> int:
    if type(value) is not int or value < 0:
        raise AssertionError(f"Chat usage {key} is not a non-negative integer")
    return value


def _provider_chat_failure_code(outcome: ProviderIncomplete | ProviderFailed) -> str:
    if isinstance(outcome, ProviderIncomplete):
        return "output_limit"
    failure = outcome.failure
    if isinstance(failure, ProviderContextTooLarge):
        return "context_too_large"
    if isinstance(failure, InvalidStructuredOutput | InvalidToolArguments):
        return "invalid_output"
    if isinstance(failure, TransientExhausted):
        return "runtime_unavailable"
    assert_never(failure)


def _backend_terminal_is_cancelled(terminal: BackendTerminal) -> bool:
    evidence = terminal.evidence
    if isinstance(evidence, CodexTerminalEvidence):
        return evidence.native.status == "cancelled"
    if isinstance(evidence, ProviderTerminalEvidence):
        return isinstance(evidence.outcome, ProviderCancelled)
    assert_never(evidence)


def _encode_chat_failure(
    code: str,
    *,
    detail: str,
    generation_id: UUID,
    observed_text: str,
    usage: dict[str, JsonValue] | None,
    last_sequence: int,
) -> str:
    del detail
    last_event = owned_presence.present(last_sequence) if last_sequence else owned_presence.absent()
    result: ExpectedFailure | CancelledGeneration
    if code == "cancelled":
        result = CancelledGeneration(
            assistant_content=observed_text,
            usage=_owned_usage(usage),
            last_provider_event_seq=last_event,
        )
    else:
        result = ExpectedFailure(
            assistant_content=observed_text,
            error_code=code,
            usage=_owned_usage(usage),
            support_id=_owned_text(generation_id.hex[:12]),
            last_provider_event_seq=last_event,
        )
    return encode_step_result(GenerationStepResultEnvelope(root=result))


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
