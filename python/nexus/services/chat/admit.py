"""Chat admission: one send or repeat is one committed receipt and one queued run.

The envelope: an advisory lock per (viewer, key), a replay lookup, one savepoint with
every domain check and write, and the receipt recorded beside it. Modeled rejections
replay like acceptances; volatile catalog unreadiness leaves the key unsettled. Every
existing-chat insertion locks the conversation before it reads a parent, as deletion
does. Admission freezes everything the worker needs: spec, prompt, attached evidence.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Literal, cast, get_args
from uuid import UUID, uuid4

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from nexus.db.models import ChatRun, Conversation, Message
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.jobs.queue import current_dead_job_for_payload, enqueue_job
from nexus.schemas.conversation import (
    MAX_MESSAGE_CONTENT_LENGTH,
    AcceptedChatAdmission,
    BranchAnchorRequest,
    ChatAdmissionReceipt,
    ChatAdmissionRejection,
    ChatRunCreateRequest,
    ChatRunResponse,
    ExistingChatDestination,
    ReaderSelectionInput,
    RejectedChatAdmission,
    RejectionCode,
    ReplyInsertion,
)
from nexus.schemas.llm import (
    GenerationSelection,
    GenerationSelectionUnavailable,
    Ineligible,
    InvalidGenerationSelection,
)
from nexus.schemas.presence import Present
from nexus.services.chat import citations, context, events, quotes, reads
from nexus.services.chat.conversations import DEFAULT_TITLE
from nexus.services.collection_revisions import CollectionFamily, bump_collection_revision
from nexus.services.generation.catalog import (
    Catalog,
    CatalogUnavailable,
    InvalidSelection,
    Row,
    SelectionUnavailable,
    chat_budgets,
    chat_row,
)
from nexus.services.generation.contract import GenerationSpec
from nexus.services.generation.policy import chat_tool_plan
from nexus.services.resource_graph.context import add_context_ref_without_commit, list_context_refs
from nexus.services.resource_graph.edges import create_link
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_mutation_replay import lookup_replay, record_replay
from nexus.services.seq import assign_next_message_seq
from nexus.services.tool_runtime.catalog import ComposedToolRuntime, unavailable_tool_ids

SCOPE = "chat:admission"
_REJECTABLE = frozenset(get_args(RejectionCode))


async def create_chat_run(
    *,
    viewer_id: UUID,
    request: ChatRunCreateRequest,
    idempotency_key: str | None,
    catalog: Catalog,
    tools: ComposedToolRuntime,
) -> ChatAdmissionReceipt:
    """Admit one send. Never a domain error: the outcome is a committed receipt."""

    key = _key(idempotency_key)
    quote = (
        request.reader_selection.value if isinstance(request.reader_selection, Present) else None
    )
    # The quote's revision is a precondition, not identity: a replay after the
    # highlight changed must still find its receipt.
    identity = {
        "destination": request.destination.model_dump(mode="json"),
        "content": request.content,
        "selection": request.selection.model_dump(mode="json"),
        "reader_selection_key": quote.key.model_dump(mode="json") if quote else None,
    }
    row = await _catalog_row(catalog, request.selection)

    def build(db: Session, resolved: Row) -> ChatRun:
        if len(request.content) > MAX_MESSAGE_CONTENT_LENGTH:
            raise ApiError(
                ApiErrorCode.E_MESSAGE_TOO_LONG,
                f"Message exceeds {MAX_MESSAGE_CONTENT_LENGTH} character limit",
            )
        conversation, parent, anchor = _destination(db, viewer_id, request)
        anchor_kind, anchor_json = _branch_anchor(parent, anchor)
        snapshot = _quote(db, viewer_id, conversation.id, quote) if quote else None
        user, assistant = _insert_pair(
            db,
            conversation.id,
            request.content,
            parent.id if parent else None,
            anchor_kind,
            anchor_json,
            snapshot,
        )
        if user.seq == 1 and conversation.title == DEFAULT_TITLE:
            conversation.title = " ".join(request.content.split())[:120].rstrip()
        return _start_run(db, viewer_id, user, assistant, resolved, tools)

    return await run_in_threadpool(_settle, viewer_id, key, identity, row, build, _REJECTABLE)


async def repeat(
    *,
    operation: Literal["rerun", "regenerate"],
    viewer_id: UUID,
    assistant_message_id: UUID,
    selection: GenerationSelection,
    idempotency_key: str | None,
    catalog: Catalog,
    tools: ComposedToolRuntime,
) -> ChatRunResponse:
    """A sibling turn under the source turn's parent, copied from its frozen user turn."""

    key = _key(idempotency_key)
    identity = {
        "operation": operation,
        "source_assistant_message_id": str(assistant_message_id),
        "selection": selection.model_dump(mode="json"),
    }
    row = await _catalog_row(catalog, selection)

    def build(db: Session, resolved: Row) -> ChatRun:
        # Lock the chat in its own statement, as deletion does, then read the source
        # fresh: rows read beside the lock predate any delete the lock waited on.
        locked = db.scalar(
            select(Conversation.id)
            .where(
                Conversation.id
                == select(ChatRun.conversation_id)
                .where(ChatRun.assistant_message_id == assistant_message_id)
                .scalar_subquery(),
                Conversation.owner_user_id == viewer_id,
            )
            .with_for_update()
        )
        source = db.execute(
            select(ChatRun, Message)
            .join(Message, Message.id == ChatRun.user_message_id)
            .where(ChatRun.assistant_message_id == assistant_message_id)
        ).one_or_none()
        if locked is None or source is None:  # also a pre-0246 answer, which has no run
            raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
        run, user = source
        if operation == "regenerate" and run.status != "complete":
            raise ApiError(
                ApiErrorCode.E_REGENERATION_NOT_ALLOWED,
                "Only a completed assistant answer can be regenerated",
            )
        if operation == "rerun" and not reads.can_rerun(run):
            raise ApiError(
                ApiErrorCode.E_RETRY_NOT_ALLOWED, "This assistant outcome cannot be rerun"
            )
        snapshot = user.reader_selection_snapshot
        sibling, assistant = _insert_pair(
            db,
            run.conversation_id,
            user.content,
            user.parent_message_id,
            user.branch_anchor_kind,
            dict(user.branch_anchor),
            dict(snapshot) if snapshot is not None else None,
        )
        return _start_run(db, viewer_id, sibling, assistant, resolved, tools)

    receipt = await run_in_threadpool(_settle, viewer_id, key, identity, row, build, frozenset())
    accepted = cast(AcceptedChatAdmission, receipt.outcome)  # a repeat records no rejections
    return await run_in_threadpool(_read, viewer_id, accepted.run_id)


def cancel(*, viewer_id: UUID, run_id: UUID) -> ChatRunResponse:
    """Record stop intent (idempotent); a run whose job already died ends here."""

    with get_session_factory()() as db:
        run = events.lock_run(db, run_id)
        if run is None or run.owner_user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")
        if run.status not in events.TERMINAL:
            if run.cancel_requested_at is None:
                run.cancel_requested_at = datetime.now(UTC)
                run.updated_at = datetime.now(UTC)
            dead = current_dead_job_for_payload(
                db, kind="chat_run", expected_payload_match={"run_id": str(run.id)}
            )
            if dead is not None:
                # Its dead-letter projection skipped this then-locked run.
                events.finalize_dead(db, run)
        db.commit()
    return _read(viewer_id, run_id)


def _read(viewer_id: UUID, run_id: UUID) -> ChatRunResponse:
    with get_session_factory()() as db:
        return reads.run_response(db, viewer_id=viewer_id, run_id=run_id)


def _key(raw: str | None) -> str:
    key = (raw or "").strip()
    if not key:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is required")
    if len(key) > 128:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is too long")
    return key


async def _catalog_row(catalog: Catalog, selection: GenerationSelection) -> Row | ApiError:
    """Resolved outside the key lock; its error settles inside it (a racing twin may win)."""

    try:
        return chat_row(await catalog.read(), selection)
    except CatalogUnavailable:
        return ApiError(
            ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE,
            "Generation availability could not be read; retry the same command",
        )
    except InvalidSelection:
        failure = InvalidGenerationSelection(
            field=Present(value="selection"),
            explanation="The exact generation selection is not in the configured catalog.",
        )
        return ApiError(
            ApiErrorCode.E_INVALID_GENERATION_SELECTION,
            failure.explanation,
            details=failure.model_dump(mode="json"),
        )
    except SelectionUnavailable as error:
        if not isinstance(error.row.chat_state, Ineligible):
            # Readiness is volatile evidence, not a rejection: leave the key unsettled.
            return ApiError(
                ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE,
                "The selected generation route is unavailable; retry the same command",
            )
        details = GenerationSelectionUnavailable(
            selection=error.row.selection, state=error.row.chat_state
        )
        return ApiError(
            ApiErrorCode.E_GENERATION_SELECTION_UNAVAILABLE,
            "The exact generation selection is not currently runnable",
            details=details.model_dump(mode="json"),
        )


def _settle(
    viewer_id: UUID,
    key: str,
    identity: dict[str, object],
    row: Row | ApiError,
    build: Callable[[Session, Row], ChatRun],
    rejectable: frozenset[str],
) -> ChatAdmissionReceipt:
    """One committed decision per (viewer, key), on one worker-thread session.

    A client disconnect cannot close the session mid-transaction, and lock waits
    never hold the event loop.
    """

    memo = {
        "viewer_id": viewer_id,
        "scope": SCOPE,
        "client_mutation_id": hashlib.sha256(key.encode()).hexdigest(),
        "request_bytes": json.dumps(identity, sort_keys=True, separators=(",", ":")).encode(),
    }
    with get_session_factory()() as db:
        db.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
            {"lock_key": f"chat_run:{viewer_id}:{key}"},
        )
        stored = lookup_replay(db, **memo)
        if stored is not None:
            return ChatAdmissionReceipt.model_validate(stored)
        try:
            with db.begin_nested():
                if isinstance(row, ApiError):
                    raise row
                run = build(db, row)
            outcome = AcceptedChatAdmission(
                conversation_id=run.conversation_id,
                run_id=run.id,
                assistant_message_id=run.assistant_message_id,
            )
        except ApiError as error:
            if error.code.value not in rejectable:
                raise
            code = cast(RejectionCode, error.code.value)
            outcome = RejectedChatAdmission(reason=ChatAdmissionRejection(code=code))
        receipt = ChatAdmissionReceipt(idempotency_key=key, outcome=outcome)
        record_replay(db, **memo, response_json=receipt.model_dump(mode="json"))
        db.commit()
        return receipt


def _destination(
    db: Session, viewer_id: UUID, request: ChatRunCreateRequest
) -> tuple[Conversation, Message | None, BranchAnchorRequest | None]:
    """The target chat, the reply's parent and its anchor; ``New`` creates the chat."""

    destination = request.destination
    if not isinstance(destination, ExistingChatDestination):
        conversation = Conversation(owner_user_id=viewer_id, title=DEFAULT_TITLE, next_seq=1)
        db.add(conversation)
        db.flush()
        return conversation, None, None
    conversation = db.scalar(
        select(Conversation).where(Conversation.id == destination.conversation_id).with_for_update()
    )
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    insertion = destination.insertion
    if isinstance(insertion, ReplyInsertion):
        parent = db.get(Message, insertion.parent_message_id)
        if (
            parent is None
            or parent.conversation_id != conversation.id
            or parent.role != "assistant"
            or parent.status != "complete"
        ):
            raise ApiError(
                ApiErrorCode.E_BRANCH_PATH_INVALID,
                "parent_message_id must point to a complete assistant message",
            )
        return conversation, parent, insertion.branch_anchor
    # Empty: the context-bearing chat ``POST /conversations`` made; a raced first
    # turn wins and this send must be resent as its reply.
    if db.scalar(select(func.count()).where(Message.conversation_id == conversation.id)):
        raise ApiError(
            ApiErrorCode.E_CONVERSATION_NO_LONGER_EMPTY,
            "Conversation is no longer empty; resend as a reply to its active leaf",
        )
    return conversation, None, None


def _branch_anchor(
    parent: Message | None, anchor: BranchAnchorRequest | None
) -> tuple[str, dict[str, object]]:
    """A reply names its parent; a selection anchor also quotes it (never mapped)."""

    if parent is None or anchor is None:
        return "none", {}
    if anchor.kind == "none":
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID, "A reply requires a non-none branch_anchor"
        )
    if anchor.message_id != parent.id:
        raise ApiError(
            ApiErrorCode.E_BRANCH_ANCHOR_INVALID,
            "Branch anchor message_id must match parent_message_id",
        )
    if anchor.kind == "assistant_message":
        return "assistant_message", {"message_id": str(parent.id)}
    return "assistant_selection", anchor.model_dump(mode="json", exclude={"kind"})


def _quote(
    db: Session, viewer_id: UUID, conversation_id: UUID, selection: ReaderSelectionInput
) -> dict[str, object]:
    """Snapshot the locked highlight; link it and its media into the chat's context."""

    key = selection.key
    db.execute(text("SELECT 1 FROM highlights WHERE id = :id FOR UPDATE"), {"id": key.highlight_id})
    snapshot = quotes.build_snapshot(db, viewer_id=viewer_id, key=key)
    if quotes.revision(snapshot) != selection.revision:
        raise ApiError(
            ApiErrorCode.E_READER_SELECTION_STALE, "Reader selection changed since it was previewed"
        )
    chat = ResourceRef("conversation", conversation_id)
    highlight = ResourceRef("highlight", key.highlight_id)
    create_link(db, viewer_id=viewer_id, source=chat, target=highlight)
    add_context_ref_without_commit(
        db,
        viewer_id=viewer_id,
        conversation_id=conversation_id,
        target=ResourceRef("media", key.media_id),
        origin="system",
    )
    return quotes.encode(snapshot)


def _insert_pair(
    db: Session,
    conversation_id: UUID,
    content: str,
    parent_id: UUID | None,
    anchor_kind: str,
    anchor: dict[str, object],
    snapshot: dict[str, object] | None,
) -> tuple[Message, Message]:
    """The user turn and its pending answer; the answer becomes the active leaf."""

    user = Message(
        conversation_id=conversation_id,
        seq=assign_next_message_seq(db, conversation_id),
        role="user",
        content=content,
        reader_selection_snapshot=snapshot,
        status="complete",
        parent_message_id=parent_id,
        branch_anchor_kind=anchor_kind,
        branch_anchor=anchor,
    )
    db.add(user)
    db.flush()
    assistant = Message(
        conversation_id=conversation_id,
        seq=assign_next_message_seq(db, conversation_id),
        role="assistant",
        content="",
        status="pending",
        parent_message_id=user.id,
        branch_anchor_kind="none",
        branch_anchor={},
    )
    db.add(assistant)
    db.flush()
    db.execute(
        text("UPDATE conversations SET active_leaf_message_id = :leaf WHERE id = :id"),
        {"leaf": assistant.id, "id": conversation_id},
    )
    return user, assistant


def _start_run(
    db: Session,
    viewer_id: UUID,
    user: Message,
    assistant: Message,
    row: Row,
    tools: ComposedToolRuntime,
) -> ChatRun:
    """Freeze prompt, spec and attached evidence; enqueue the one job; bump the index."""

    conversation_id = user.conversation_id
    context_budget, output_budget = chat_budgets(row)
    try:
        assembly = context.assemble(
            db,
            viewer_id=viewer_id,
            conversation_id=conversation_id,
            user=user,
            context_budget=context_budget,
        )
    except context.ContextTooLarge as error:
        raise ApiError(
            ApiErrorCode.E_GENERATION_CONTEXT_TOO_LARGE,
            "This conversation no longer fits the model context window",
        ) from error
    plan = chat_tool_plan(
        tools.memory_config,
        user_id=viewer_id,
        processors=row.presentation.processor_chain.processors,
    )
    if unavailable_tool_ids(tools.operations[plan]):
        raise ApiError(
            ApiErrorCode.E_GENERATION_RUNTIME_UNAVAILABLE,
            "The selected generation route cannot run its complete tool plan",
        )
    scope = list_context_refs(db, viewer_id=viewer_id, conversation_id=conversation_id)
    spec = GenerationSpec(
        operation="chat",
        selection=row.selection,
        display_at_dispatch=row.presentation,
        tool_plan=plan,
        tool_scope=tuple(sorted(ref.target.uri for ref in scope)),
        effect_mode="AdditiveWrites",
        context_budget_tokens=context_budget,
        output_budget_tokens=output_budget,
    )
    run = ChatRun(
        id=uuid4(),
        owner_user_id=viewer_id,
        conversation_id=conversation_id,
        user_message_id=user.id,
        assistant_message_id=assistant.id,
        status="queued",
        generation_spec=spec.model_dump(mode="json"),
        generation_intent=assembly.intent.model_dump(mode="json"),
    )
    db.add(run)
    db.flush()
    citations.persist_attached(db, run, assembly.attached)
    enqueue_job(
        db,
        kind="chat_run",
        payload={"run_id": str(run.id)},
        priority=50,
        max_attempts=3,
        dedupe_key=f"chat_run:{run.id}",
    )
    bump_collection_revision(db, viewer_id=viewer_id, family=CollectionFamily.ConversationIndex)
    return run
