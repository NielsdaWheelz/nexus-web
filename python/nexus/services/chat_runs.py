"""Chat admission: one send is one committed decision and one durable run.

HTTP freezes the prompt, the exact generation selection and the tool plan inside
a single transaction, appends ``meta``, and enqueues the job the worker runs.
The same envelope serves a first send and a rerun/regenerate sibling: one
advisory key lock, one replay lookup, one savepoint, one recorded receipt.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Literal, cast, get_args
from uuid import UUID, uuid4

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from nexus.db.models import (
    ChatRun,
    ChatRunTurnContext,
    Conversation,
    ConversationActivePath,
    Message,
)
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.jobs.queue import (
    current_dead_job_for_payload,
    enqueue_job,
    lock_chat_generation_admission_in_current_transaction,
    requeue_dead_job,
)
from nexus.schemas.chat_reader_selection import ReaderSelectionInput
from nexus.schemas.conversation import (
    CHAT_RUN_STATUS_FILTER,
    MAX_MESSAGE_CONTENT_LENGTH,
    AcceptedChatAdmission,
    BranchAnchorRequest,
    ChatAdmissionReceipt,
    ChatAdmissionRejection,
    ChatAdmissionRejectionCode,
    ChatDestination,
    ChatRunResponse,
    EmptyInsertion,
    ExistingChatDestination,
    NoBranchAnchorRequest,
    RejectedChatAdmission,
    ReplyInsertion,
)
from nexus.schemas.llm import (
    CatalogDefinitionStale,
    GenerationSelectionUnavailable,
    Ineligible,
    InvalidGenerationSelection,
    RunSelectionOut,
)
from nexus.schemas.presence import Present
from nexus.services import generation_policy
from nexus.services.chat_failure import rerun_eligibility
from nexus.services.chat_reader_selection import (
    build_reader_selection_snapshot,
    compute_reader_selection_revision,
    encode_reader_selection_snapshot,
    reader_selection_out,
)
from nexus.services.chat_run_citations import persist_attached_citations
from nexus.services.chat_run_event_store import (
    TERMINAL_RUN_STATUSES,
    ChatRunEventEmitter,
    lock_chat_run_for_update,
)
from nexus.services.chat_run_response import build_chat_run_response, read_chat_run_response
from nexus.services.chat_run_selection import run_selection_out
from nexus.services.collection_revisions import (
    CollectionFamily,
    bump_all_collection_revisions,
    bump_collection_revision,
)
from nexus.services.context_assembler import (
    CHAT_PROMPT_TEMPLATE_REVISION,
    ContextBudgetError,
    assemble_chat_context,
    chat_prompt_payload_ref,
    persist_prompt_assembly,
)
from nexus.services.conversation_branches import (
    branch_anchor_for_message,
    ensure_branch_metadata,
    persist_active_leaf,
)
from nexus.services.conversations import (
    DEFAULT_CONVERSATION_TITLE,
    derive_conversation_title,
    message_document,
)
from nexus.services.generation_admission import GenerationOperationUnavailable
from nexus.services.generation_catalog import (
    CatalogDefinitionStaleError,
    GenerationCatalogRefreshError,
    GenerationCatalogService,
    GenerationCatalogSnapshot,
    GenerationSelectionUnavailableError,
    InvalidGenerationSelectionError,
    ResolvedCatalogPair,
)
from nexus.services.generation_service import GenerationService
from nexus.services.generation_spec import (
    CodexPersonalSelection,
    FrozenToolScope,
    GenerationSpec,
    ProviderApiSelection,
)
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.resource_graph.context import (
    add_context_ref_without_commit,
    list_context_refs,
)
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_mutation_replay import lookup_replay, record_replay
from nexus.services.seq import assign_next_message_seq
from nexus.services.tool_runtime.catalog import ComposedToolRuntime

type ExactChatSelection = CodexPersonalSelection | ProviderApiSelection
type RepeatOperation = Literal["rerun", "regenerate"]

CHAT_ADMISSION_SCOPE = "chat:admission"
_REJECTION_CODES = frozenset(get_args(ChatAdmissionRejectionCode))


@dataclasses.dataclass(frozen=True, slots=True)
class _TurnSubject:
    """The resource this turn is about, carried into ``chat_run_turn_contexts``."""

    requested_scheme: str | None
    requested_id: UUID | None
    scheme: str | None
    id: UUID | None
    context_edge_id: UUID | None


# =============================================================================
# Entry points
# =============================================================================


async def create_chat_run(
    *,
    viewer_id: UUID,
    destination: ChatDestination,
    reader_selection: ReaderSelectionInput | None,
    content: str,
    catalog_definition_revision: str,
    selection: ExactChatSelection,
    idempotency_key: str | None,
    catalog: GenerationCatalogService,
    tool_runtime: ComposedToolRuntime,
) -> ChatAdmissionReceipt:
    """Admit one send. Never a domain error: the outcome is a committed receipt."""

    normalized_key = _normalized_idempotency_key(idempotency_key)
    # The live reader-selection revision is deliberately excluded: the server
    # re-resolves and snapshots under the highlight row lock at send, so hashing
    # it would turn a valid replay into a mismatch after the source changed.
    request_bytes = _canonical_bytes(
        {
            "destination": destination.model_dump(mode="json"),
            "content": content,
            "catalog_definition_revision": catalog_definition_revision,
            "selection": selection.model_dump(mode="json"),
            "reader_selection_key": (
                {
                    "media_id": str(reader_selection.key.media_id),
                    "highlight_id": str(reader_selection.key.highlight_id),
                }
                if reader_selection is not None
                else None
            ),
        }
    )
    pair, catalog_error = await _resolve_catalog_pair(
        catalog,
        catalog_definition_revision=catalog_definition_revision,
        selection=selection,
    )
    generation_service = GenerationService(
        catalog=catalog,
        policy=generation_policy.GENERATION_POLICY,
        tools=tool_runtime,
    )

    def build(db: Session, resolved: ResolvedCatalogPair) -> ChatRun:
        return _admit_send(
            db,
            viewer_id=viewer_id,
            destination=destination,
            reader_selection=reader_selection,
            content=content,
            catalog_definition_revision=catalog_definition_revision,
            pair=resolved,
            generation_service=generation_service,
        )

    def settle() -> ChatAdmissionReceipt:
        return _settle_admission(
            viewer_id=viewer_id,
            idempotency_key=normalized_key,
            request_bytes=request_bytes,
            pair=pair,
            catalog_error=catalog_error,
            build=build,
            rejection_codes=_REJECTION_CODES,
        )

    return await run_in_threadpool(settle)


async def repeat_assistant_response(
    *,
    operation: RepeatOperation,
    viewer_id: UUID,
    assistant_message_id: UUID,
    catalog_definition_revision: str,
    selection: ExactChatSelection,
    idempotency_key: str | None,
    catalog: GenerationCatalogService,
    tool_runtime: ComposedToolRuntime,
) -> ChatRunResponse:
    """Mint a sibling candidate under the same parent, with a fresh admission.

    The source assistant id names the frozen source turn; source prompt/branch
    facts are validated on first admission only, never rebuilt for a replay.
    """

    normalized_key = _normalized_idempotency_key(idempotency_key)
    request_bytes = _canonical_bytes(
        {
            "operation": operation,
            "source_assistant_message_id": str(assistant_message_id),
            "catalog_definition_revision": catalog_definition_revision,
            "selection": selection.model_dump(mode="json"),
        }
    )
    pair, catalog_error = await _resolve_catalog_pair(
        catalog,
        catalog_definition_revision=catalog_definition_revision,
        selection=selection,
    )
    generation_service = GenerationService(
        catalog=catalog,
        policy=generation_policy.GENERATION_POLICY,
        tools=tool_runtime,
    )

    def build(db: Session, resolved: ResolvedCatalogPair) -> ChatRun:
        return _admit_repeat(
            db,
            operation=operation,
            viewer_id=viewer_id,
            assistant_message_id=assistant_message_id,
            catalog_definition_revision=catalog_definition_revision,
            pair=resolved,
            generation_service=generation_service,
        )

    def settle() -> ChatAdmissionReceipt:
        return _settle_admission(
            viewer_id=viewer_id,
            idempotency_key=normalized_key,
            request_bytes=request_bytes,
            pair=pair,
            catalog_error=catalog_error,
            build=build,
            rejection_codes=frozenset(),
        )

    receipt = await run_in_threadpool(settle)
    if not isinstance(receipt.outcome, AcceptedChatAdmission):
        raise AssertionError("candidate admission has a rejected receipt")
    run_id = receipt.outcome.run_id
    snapshot = await catalog.read_chat()

    def read() -> ChatRunResponse:
        with get_session_factory()() as db:
            return read_chat_run_response(db, viewer_id, run_id, catalog_snapshot=snapshot)

    return await run_in_threadpool(read)


# =============================================================================
# The admission envelope
# =============================================================================


async def _resolve_catalog_pair(
    catalog: GenerationCatalogService,
    *,
    catalog_definition_revision: str,
    selection: ExactChatSelection,
) -> tuple[ResolvedCatalogPair | None, ApiError | None]:
    """Resolve the exact selection outside the settlement lock.

    A competing admission may commit while this request is in flight, so no
    catalog outcome may settle the operation here: its error is stashed and
    re-raised inside the savepoint.
    """

    try:
        return await _admit_chat_selection(
            catalog,
            catalog_definition_revision=catalog_definition_revision,
            selection=selection,
        ), None
    except ApiError as exc:
        return None, exc


async def _admit_chat_selection(
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
    except GenerationCatalogRefreshError as error:
        raise ApiError(
            ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE,
            "Generation availability could not be refreshed; retry the same command",
        ) from error
    except CatalogDefinitionStaleError as error:
        raise ApiError(
            ApiErrorCode.E_CATALOG_DEFINITION_STALE,
            "Generation catalog changed; refresh and confirm the selection again",
            details=CatalogDefinitionStale(
                current_definition_revision=error.current_definition_revision
            ).model_dump(mode="json"),
        ) from error
    except InvalidGenerationSelectionError as error:
        failure = InvalidGenerationSelection(
            field=Present(value="selection"),
            explanation="The exact generation selection is not in the configured catalog.",
        )
        raise ApiError(
            ApiErrorCode.E_INVALID_GENERATION_SELECTION,
            failure.explanation,
            details=failure.model_dump(mode="json"),
        ) from error
    except GenerationSelectionUnavailableError as error:
        if not isinstance(error.pair.state, Ineligible):
            # Readiness is volatile operational evidence, not an immutable
            # rejection of this exact command. Keep its key unsettled.
            raise ApiError(
                ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE,
                "The selected generation route is unavailable; retry the same command",
            ) from error
        raise ApiError(
            ApiErrorCode.E_GENERATION_SELECTION_UNAVAILABLE,
            "The exact generation selection is not currently runnable",
            details=GenerationSelectionUnavailable(
                selection=error.pair.selection,
                state=error.pair.state,
            ).model_dump(mode="json"),
        ) from error


def _settle_admission(
    *,
    viewer_id: UUID,
    idempotency_key: str,
    request_bytes: bytes,
    pair: ResolvedCatalogPair | None,
    catalog_error: ApiError | None,
    build: Callable[[Session, ResolvedCatalogPair], ChatRun],
    rejection_codes: frozenset[str],
) -> ChatAdmissionReceipt:
    """One committed admission decision per (viewer, idempotency key).

    The complete database phase owns its session and runs on one worker thread:
    a client disconnect cannot close a session mid-transaction, and lock waits
    never hold the event loop. Codes in ``rejection_codes`` are recorded and
    replayed exactly like an acceptance; every other error escapes.
    """

    with get_session_factory()() as db:
        try:
            lock_chat_generation_admission_in_current_transaction(db)
            db.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
                {"lock_key": f"chat_run:{viewer_id}:{idempotency_key}"},
            )
            stored = lookup_replay(
                db,
                viewer_id=viewer_id,
                scope=CHAT_ADMISSION_SCOPE,
                client_mutation_id=_key_digest(idempotency_key),
                request_bytes=request_bytes,
            )
            if stored is not None:
                return ChatAdmissionReceipt.model_validate(stored)

            try:
                # Every domain check and provisional write belongs to this
                # savepoint under the settlement lock, never the catalog phase.
                with db.begin_nested():
                    if catalog_error is not None:
                        raise catalog_error
                    if pair is None:
                        raise AssertionError("catalog admission lost its resolved selection")
                    run = build(db, pair)
                    receipt = ChatAdmissionReceipt(
                        idempotency_key=idempotency_key,
                        outcome=AcceptedChatAdmission(
                            conversation_id=run.conversation_id,
                            run_id=run.id,
                            assistant_message_id=run.assistant_message_id,
                        ),
                    )
            except ApiError as exc:
                if exc.code.value not in rejection_codes:
                    raise
                receipt = ChatAdmissionReceipt(
                    idempotency_key=idempotency_key,
                    outcome=RejectedChatAdmission(
                        reason=ChatAdmissionRejection(
                            code=cast(ChatAdmissionRejectionCode, exc.code.value)
                        )
                    ),
                )
            record_replay(
                db,
                viewer_id=viewer_id,
                scope=CHAT_ADMISSION_SCOPE,
                client_mutation_id=_key_digest(idempotency_key),
                request_bytes=request_bytes,
                response_json=receipt.model_dump(mode="json"),
            )
            db.commit()
            return receipt
        except Exception:
            db.rollback()
            raise


def _normalized_idempotency_key(idempotency_key: str | None) -> str:
    normalized = (idempotency_key or "").strip()
    if not normalized:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is required")
    if len(normalized) > 128:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is too long")
    return normalized


def _key_digest(idempotency_key: str) -> str:
    return hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()


def _canonical_bytes(payload: dict[str, object]) -> bytes:
    """Canonical identity bytes for one admissible command."""

    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


# =============================================================================
# Admitting a send
# =============================================================================


def _admit_send(
    db: Session,
    *,
    viewer_id: UUID,
    destination: ChatDestination,
    reader_selection: ReaderSelectionInput | None,
    content: str,
    catalog_definition_revision: str,
    pair: ResolvedCatalogPair,
    generation_service: GenerationService,
) -> ChatRun:
    if len(content) > MAX_MESSAGE_CONTENT_LENGTH:
        raise ApiError(
            ApiErrorCode.E_MESSAGE_TOO_LONG,
            f"Message exceeds {MAX_MESSAGE_CONTENT_LENGTH} character limit",
        )
    get_rate_limiter().check_rpm_limit(viewer_id)

    conversation, parent_message, branch_anchor = _resolve_destination(db, viewer_id, destination)
    branch_anchor_kind, branch_anchor_payload = branch_anchor_for_message(
        parent_message, branch_anchor
    )

    snapshot_json: dict[str, object] | None = None
    subject: _TurnSubject | None = None
    chat_subject: dict[str, object] | None = None
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
            preview = reader_selection_out(db, viewer_id=viewer_id, snapshot=snapshot)
            raise ApiError(
                ApiErrorCode.E_READER_SELECTION_STALE,
                "Reader selection changed since it was previewed",
                details={
                    "preview": {**preview.model_dump(mode="json"), "revision": fresh_revision}
                },
            )
        snapshot_json = encode_reader_selection_snapshot(snapshot)
        subject_ref = ResourceRef(scheme="highlight", id=reader_selection.key.highlight_id)
        companion_ref = ResourceRef(scheme="media", id=reader_selection.key.media_id)
        subject_edge = add_context_ref_without_commit(
            db,
            viewer_id=viewer_id,
            conversation_id=conversation.id,
            target=subject_ref,
            origin="user",
        )
        add_context_ref_without_commit(
            db,
            viewer_id=viewer_id,
            conversation_id=conversation.id,
            target=companion_ref,
            origin="system",
        )
        subject = _TurnSubject(
            requested_scheme=subject_ref.scheme,
            requested_id=subject_ref.id,
            scheme=subject_ref.scheme,
            id=subject_ref.id,
            context_edge_id=subject_edge.edge_id,
        )
        chat_subject = {
            "requested_resource_ref": subject_ref.uri,
            "resource_ref": subject_ref.uri,
            "context_edge_id": str(subject_edge.edge_id),
            "companions": [companion_ref.uri],
        }

    user_message, assistant_message = _insert_message_pair(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation.id,
        content=content,
        parent_message_id=parent_message.id if parent_message is not None else None,
        branch_root_message_id=parent_message.id if parent_message is not None else None,
        branch_anchor_kind=branch_anchor_kind,
        branch_anchor=branch_anchor_payload,
        reader_selection_snapshot=snapshot_json,
    )
    if user_message.seq == 1 and conversation.title == DEFAULT_CONVERSATION_TITLE:
        conversation.title = derive_conversation_title(content)
    return _start_run(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation.id,
        user_message=user_message,
        assistant_message=assistant_message,
        subject=subject,
        chat_subject=chat_subject,
        pair=pair,
        catalog_definition_revision=catalog_definition_revision,
        generation_service=generation_service,
    )


def _resolve_destination(
    db: Session,
    viewer_id: UUID,
    destination: ChatDestination,
) -> tuple[Conversation, Message | None, BranchAnchorRequest]:
    """Materialize the target conversation and its insertion point.

    ``New`` creates a private conversation. ``Existing.Empty`` locks the row and
    linearizes against concurrent message creation, returning
    ``E_CONVERSATION_NO_LONGER_EMPTY`` with the current active leaf if another
    writer won — it never silently replies to a raced head.
    """

    if not isinstance(destination, ExistingChatDestination):
        conversation = Conversation(
            owner_user_id=viewer_id,
            title=DEFAULT_CONVERSATION_TITLE,
            next_seq=1,
        )
        db.add(conversation)
        db.flush()
        bump_collection_revision(db, viewer_id=viewer_id, family=CollectionFamily.ConversationIndex)
        return conversation, None, NoBranchAnchorRequest()

    conversation_id = destination.conversation_id
    insertion = destination.insertion
    if isinstance(insertion, ReplyInsertion):
        conversation = db.get(Conversation, conversation_id)
        if conversation is None or conversation.owner_user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
        parent = db.get(Message, insertion.parent_message_id)
        if parent is None or parent.conversation_id != conversation_id:
            raise ApiError(ApiErrorCode.E_BRANCH_PATH_INVALID, "Parent message not found")
        if parent.role != "assistant" or parent.status != "complete":
            raise ApiError(
                ApiErrorCode.E_BRANCH_PATH_INVALID,
                "parent_message_id must point to a complete assistant message",
            )
        return conversation, parent, insertion.branch_anchor

    assert isinstance(insertion, EmptyInsertion)
    conversation = db.execute(
        select(Conversation).where(Conversation.id == conversation_id).with_for_update()
    ).scalar_one_or_none()
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    if db.scalar(
        select(func.count()).select_from(Message).where(Message.conversation_id == conversation_id)
    ):
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
    return conversation, None, NoBranchAnchorRequest()


# =============================================================================
# Admitting a rerun / regenerate sibling
# =============================================================================


def _admit_repeat(
    db: Session,
    *,
    operation: RepeatOperation,
    viewer_id: UUID,
    assistant_message_id: UUID,
    catalog_definition_revision: str,
    pair: ResolvedCatalogPair,
    generation_service: GenerationService,
) -> ChatRun:
    # Source deletion takes the same parent lock, so once admission resolves its
    # source, deletion cannot invalidate the snapshot before publication.
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
    source_assistant = db.get(Message, assistant_message_id)
    if conversation is None or source_assistant is None:
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
    source_user = db.get(Message, source_run.user_message_id)
    if source_user is None or source_user.role != "user":
        raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Source prompt not found")
    _assert_repeat_eligible(operation, source_run, source_assistant)

    user_message, assistant_message = _insert_message_pair(
        db,
        viewer_id=viewer_id,
        conversation_id=source_run.conversation_id,
        content=source_user.content,
        parent_message_id=source_user.parent_message_id,
        branch_root_message_id=source_user.branch_root_message_id,
        branch_anchor_kind=source_user.branch_anchor_kind,
        branch_anchor=dict(source_user.branch_anchor or {}),
        reader_selection_snapshot=(
            dict(source_user.reader_selection_snapshot)
            if source_user.reader_selection_snapshot is not None
            else None
        ),
    )
    source_context = db.get(ChatRunTurnContext, source_run.id)
    return _start_run(
        db,
        viewer_id=viewer_id,
        conversation_id=source_run.conversation_id,
        user_message=user_message,
        assistant_message=assistant_message,
        subject=(
            _TurnSubject(
                requested_scheme=source_context.requested_subject_scheme,
                requested_id=source_context.requested_subject_id,
                scheme=source_context.subject_scheme,
                id=source_context.subject_id,
                context_edge_id=source_context.subject_context_edge_id,
            )
            if source_context is not None
            else None
        ),
        chat_subject=None,
        pair=pair,
        catalog_definition_revision=catalog_definition_revision,
        generation_service=generation_service,
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
    raise ApiError(ApiErrorCode.E_RETRY_NOT_ALLOWED, "This assistant outcome cannot be rerun")


# =============================================================================
# Shared writes
# =============================================================================


def _insert_message_pair(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    content: str,
    parent_message_id: UUID | None,
    branch_root_message_id: UUID | None,
    branch_anchor_kind: str,
    branch_anchor: dict[str, object],
    reader_selection_snapshot: dict[str, object] | None,
) -> tuple[Message, Message]:
    """Insert the user message and its pending assistant answer."""

    user_message = Message(
        conversation_id=conversation_id,
        seq=assign_next_message_seq(db, conversation_id),
        role="user",
        content=content,
        message_document=message_document("user", content),
        reader_selection_snapshot=reader_selection_snapshot,
        status="complete",
        parent_message_id=parent_message_id,
        branch_root_message_id=branch_root_message_id,
        branch_anchor_kind=branch_anchor_kind,
        branch_anchor=branch_anchor,
    )
    db.add(user_message)
    db.flush()
    if parent_message_id is not None:
        ensure_branch_metadata(
            db,
            conversation_id=conversation_id,
            branch_user_message_id=user_message.id,
        )
    assistant_message = Message(
        conversation_id=conversation_id,
        seq=assign_next_message_seq(db, conversation_id),
        role="assistant",
        content="",
        message_document=message_document("assistant", ""),
        status="pending",
        parent_message_id=user_message.id,
        branch_root_message_id=branch_root_message_id,
        branch_anchor_kind="none",
        branch_anchor={},
    )
    db.add(assistant_message)
    db.flush()
    persist_active_leaf(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation_id,
        active_leaf_message_id=assistant_message.id,
    )
    bump_all_collection_revisions(db, family=CollectionFamily.ConversationIndex)
    return user_message, assistant_message


def _start_run(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    user_message: Message,
    assistant_message: Message,
    subject: _TurnSubject | None,
    chat_subject: dict[str, object] | None,
    pair: ResolvedCatalogPair,
    catalog_definition_revision: str,
    generation_service: GenerationService,
) -> ChatRun:
    """Freeze the prompt and spec, append ``meta``, and enqueue the one job."""

    run = ChatRun(
        id=uuid4(),
        owner_user_id=viewer_id,
        conversation_id=conversation_id,
        user_message_id=user_message.id,
        assistant_message_id=assistant_message.id,
        status="queued",
    )
    turn_context = (
        ChatRunTurnContext(
            chat_run_id=run.id,
            requested_subject_scheme=subject.requested_scheme,
            requested_subject_id=subject.requested_id,
            subject_scheme=subject.scheme,
            subject_id=subject.id,
            subject_context_edge_id=subject.context_edge_id,
        )
        if subject is not None
        else None
    )
    spec, run_selection = _freeze_admission(
        db,
        run=run,
        turn_context=turn_context,
        pair=pair,
        catalog_definition_revision=catalog_definition_revision,
        generation_service=generation_service,
    )
    ChatRunEventEmitter(db, run).batch(
        "meta",
        {
            "run_id": str(run.id),
            "conversation_id": str(conversation_id),
            "user_message_id": str(user_message.id),
            "assistant_message_id": str(assistant_message.id),
            "run_selection": run_selection.model_dump(mode="python"),
            "chat_subject": chat_subject,
        },
    )
    enqueue_job(
        db,
        kind="chat_run",
        payload={"run_id": str(run.id), "generation_spec_fingerprint": spec.fingerprint},
        priority=50,
        max_attempts=3,
        dedupe_key=f"chat_run:{run.id}",
    )
    return run


def _freeze_admission(
    db: Session,
    *,
    run: ChatRun,
    turn_context: ChatRunTurnContext | None,
    pair: ResolvedCatalogPair,
    catalog_definition_revision: str,
    generation_service: GenerationService,
) -> tuple[GenerationSpec, RunSelectionOut]:
    """Persist one complete Chat prompt and spec before its queue row exists."""

    try:
        assembly = assemble_chat_context(
            db,
            run=run,
            max_context_tokens=pair.effective_context_budget_tokens,
            max_output_tokens=pair.effective_output_budget_tokens,
            turn_context=turn_context,
        )
    except ContextBudgetError as error:
        raise ApiError(
            ApiErrorCode.E_GENERATION_CONTEXT_TOO_LARGE,
            "This conversation no longer fits the model context window",
        ) from error
    try:
        spec = generation_service.freeze_chat_from_pair(
            catalog_definition_revision=catalog_definition_revision,
            pair=pair,
            scope=FrozenToolScope(
                admitted_refs=tuple(
                    sorted(
                        context.target.uri
                        for context in list_context_refs(
                            db,
                            viewer_id=run.owner_user_id,
                            conversation_id=run.conversation_id,
                        )
                    )
                ),
                predicates=(),
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
    persist_attached_citations(db, run, assembly.attached_citations)
    return spec, run_selection_out(run, pair=pair, observed_at=datetime.now(UTC))


# =============================================================================
# Owner-scoped reads and cancellation
# =============================================================================


def get_run_for_owner(db: Session, viewer_id: UUID, run_id: UUID) -> ChatRun:
    run = db.get(ChatRun, run_id)
    if run is None or run.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")
    return run


def assert_chat_run_owner(db: Session, *, viewer_id: UUID, run_id: UUID) -> None:
    get_run_for_owner(db, viewer_id, run_id)


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
    # "active" means non-terminal; every other value is an exact status match.
    status_filter = (
        ChatRun.status.notin_(TERMINAL_RUN_STATUSES)
        if status == "active"
        else ChatRun.status == status
    )
    runs = db.scalars(
        select(ChatRun)
        .where(
            ChatRun.owner_user_id == viewer_id,
            ChatRun.conversation_id == conversation_id,
            status_filter,
        )
        .order_by(ChatRun.created_at.asc(), ChatRun.id.asc())
    ).all()
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
    """Stamp the cancellation and wake a suspended job so the worker folds it."""

    owned = get_run_for_owner(db, viewer_id, run_id)
    lock_chat_generation_admission_in_current_transaction(db)
    run = lock_chat_run_for_update(db, owned.id)
    if run is None or run.owner_user_id != viewer_id:
        raise AssertionError("owned chat run disappeared before cancellation")
    if run.status in TERMINAL_RUN_STATUSES:
        db.rollback()
        return read_chat_run_response(db, viewer_id, run_id, catalog_snapshot=catalog_snapshot)
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
    return read_chat_run_response(db, viewer_id, run_id, catalog_snapshot=catalog_snapshot)
