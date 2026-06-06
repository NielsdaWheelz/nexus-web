"""Message retrieval/rerank ledger queries.

Read-only ledger inspection for an assistant message's retrieval and rerank
tool calls. Visibility is delegated to the conversation read predicate
(``conversations.get_conversation_for_visible_read_or_404``).
"""

from typing import Any, cast
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import (
    Message,
    MessageRerankLedger,
    MessageRetrieval,
    MessageRetrievalCandidateLedger,
    MessageToolCall,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.conversation import (
    MessageRerankLedgerOut,
    MessageRetrievalCandidateLedgerOut,
)
from nexus.services.conversations import get_conversation_for_visible_read_or_404


def _get_message_for_visible_read_or_404(
    db: Session,
    *,
    viewer_id: UUID,
    message_id: UUID,
) -> Message:
    message = db.get(Message, message_id)
    if message is None:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found")
    try:
        get_conversation_for_visible_read_or_404(db, viewer_id, message.conversation_id)
    except NotFoundError:
        raise NotFoundError(ApiErrorCode.E_MESSAGE_NOT_FOUND, "Message not found") from None
    return message


def list_message_retrieval_candidate_ledgers(
    db: Session,
    *,
    viewer_id: UUID,
    message_id: UUID,
    tool_call_id: UUID | None = None,
) -> list[MessageRetrievalCandidateLedgerOut]:
    _get_message_for_visible_read_or_404(
        db,
        viewer_id=viewer_id,
        message_id=message_id,
    )
    stmt = (
        select(
            MessageRetrievalCandidateLedger,
            MessageRetrieval.included_in_prompt,
        )
        .join(
            MessageToolCall,
            MessageToolCall.id == MessageRetrievalCandidateLedger.tool_call_id,
        )
        .outerjoin(
            MessageRetrieval,
            MessageRetrieval.id == MessageRetrievalCandidateLedger.retrieval_id,
        )
        .where(MessageToolCall.assistant_message_id == message_id)
        .order_by(
            MessageToolCall.tool_call_index.asc(),
            MessageRetrievalCandidateLedger.ordinal.asc(),
            MessageRetrievalCandidateLedger.id.asc(),
        )
    )
    if tool_call_id is not None:
        stmt = stmt.where(MessageRetrievalCandidateLedger.tool_call_id == tool_call_id)

    rows = db.execute(stmt).all()
    return [
        _retrieval_candidate_ledger_to_out(row, linked_retrieval_included_in_prompt)
        for row, linked_retrieval_included_in_prompt in rows
    ]


def _retrieval_candidate_ledger_to_out(
    row: MessageRetrievalCandidateLedger,
    linked_retrieval_included_in_prompt: bool | None,
) -> MessageRetrievalCandidateLedgerOut:
    if linked_retrieval_included_in_prompt is None:
        included_in_prompt = row.included_in_prompt
        included_in_prompt_source = "candidate_ledger"
        included_in_prompt_reconciled = True
    else:
        included_in_prompt = linked_retrieval_included_in_prompt
        included_in_prompt_source = "linked_retrieval"
        included_in_prompt_reconciled = (
            row.included_in_prompt == linked_retrieval_included_in_prompt
        )

    return MessageRetrievalCandidateLedgerOut(
        id=row.id,
        tool_call_id=row.tool_call_id,
        retrieval_id=row.retrieval_id,
        ordinal=row.ordinal,
        result_type=cast(Any, row.result_type),
        source_id=row.source_id,
        score=row.score,
        selected=row.selected,
        included_in_prompt=included_in_prompt,
        ledger_included_in_prompt=row.included_in_prompt,
        linked_retrieval_included_in_prompt=linked_retrieval_included_in_prompt,
        included_in_prompt_source=cast(Any, included_in_prompt_source),
        included_in_prompt_reconciled=included_in_prompt_reconciled,
        selection_status=row.selection_status,
        selection_reason=row.selection_reason,
        result_ref=cast(Any, row.result_ref),
        locator=cast(Any, row.locator),
        created_at=row.created_at,
    )


def list_message_rerank_ledgers(
    db: Session,
    *,
    viewer_id: UUID,
    message_id: UUID,
    tool_call_id: UUID | None = None,
) -> list[MessageRerankLedgerOut]:
    _get_message_for_visible_read_or_404(
        db,
        viewer_id=viewer_id,
        message_id=message_id,
    )
    stmt = (
        select(MessageRerankLedger)
        .join(MessageToolCall, MessageToolCall.id == MessageRerankLedger.tool_call_id)
        .where(MessageToolCall.assistant_message_id == message_id)
        .order_by(
            MessageToolCall.tool_call_index.asc(),
            MessageRerankLedger.created_at.asc(),
            MessageRerankLedger.id.asc(),
        )
    )
    if tool_call_id is not None:
        stmt = stmt.where(MessageRerankLedger.tool_call_id == tool_call_id)

    rows = db.scalars(stmt).all()
    return [
        MessageRerankLedgerOut(
            id=row.id,
            tool_call_id=row.tool_call_id,
            strategy=row.strategy,
            input_count=row.input_count,
            selected_count=row.selected_count,
            budget_chars=row.budget_chars,
            selected_chars=row.selected_chars,
            status=row.status,
            metadata=row.metadata_,
            created_at=row.created_at,
        )
        for row in rows
    ]
