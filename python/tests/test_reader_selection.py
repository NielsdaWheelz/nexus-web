"""Tests for the `<reader_selection>` turn anchor (S3).

Covers the bind-only block render, its absence, the blank-`exact` schema guard,
and that the durable selection identity joins the idempotency hash (client quote
hints are canonicalized from the highlight row).
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy.orm import Session

from nexus.db.models import ChatRunTurnContext
from nexus.errors import ApiError, ApiErrorCode
from nexus.schemas.conversation import NoBranchAnchorRequest, ReaderSelectionRequest
from nexus.services.chat_run_idempotency import compute_payload_hash
from nexus.services.chat_run_validation import _validate_reader_selection
from nexus.services.context_assembler import _build_reader_selection_block
from tests.factories import (
    add_context_edge,
    create_test_conversation,
    create_test_fragment,
    create_test_highlight,
    create_test_media_in_library,
    get_user_default_library,
)

pytestmark = pytest.mark.integration


def test_reader_selection_blank_exact_rejected():
    with pytest.raises(ValidationError):
        ReaderSelectionRequest(exact="   ", media_id=uuid4(), highlight_id=uuid4())


def test_reader_selection_absent_renders_no_block(db_session: Session, bootstrapped_user: UUID):
    assert _build_reader_selection_block(db_session, None, viewer_id=bootstrapped_user) is None


def test_reader_selection_renders_bind_block(db_session: Session, bootstrapped_user: UUID):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Skinwalkers"
    )
    fragment_id = create_test_fragment(db_session, media_id, content="poolpah hit the fan")
    highlight_id = create_test_highlight(
        db_session, bootstrapped_user, fragment_id, exact="poolpah"
    )
    turn_context = ChatRunTurnContext(
        chat_run_id=uuid4(),
        reader_selection_media_id=media_id,
        reader_selection_highlight_id=highlight_id,
    )

    block = _build_reader_selection_block(db_session, turn_context, viewer_id=bootstrapped_user)

    assert block is not None
    text = block.text
    assert text.startswith('<reader_selection source="“Skinwalkers”">')
    assert "<exact>poolpah</exact>" in text
    assert "client text is ignored" not in text


def test_reader_selection_requires_attached_highlight_reference(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Reference Source"
    )
    fragment_id = create_test_fragment(db_session, media_id, content="quoted text")
    highlight_id = create_test_highlight(
        db_session, bootstrapped_user, fragment_id, exact="quoted text"
    )
    selection = ReaderSelectionRequest(
        exact="quoted text", media_id=media_id, highlight_id=highlight_id
    )
    turn_context = ChatRunTurnContext(
        chat_run_id=uuid4(),
        reader_selection_media_id=media_id,
        reader_selection_highlight_id=highlight_id,
    )

    assert (
        _build_reader_selection_block(
            db_session,
            turn_context,
            viewer_id=bootstrapped_user,
            conversation_id=conversation_id,
        )
        is None
    )

    with pytest.raises(ApiError) as exc_info:
        _validate_reader_selection(db_session, bootstrapped_user, conversation_id, selection)
    assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST

    add_context_edge(db_session, conversation_id, f"highlight:{highlight_id}")
    db_session.commit()
    _validate_reader_selection(db_session, bootstrapped_user, conversation_id, selection)
    assert (
        _build_reader_selection_block(
            db_session,
            turn_context,
            viewer_id=bootstrapped_user,
            conversation_id=conversation_id,
        )
        is not None
    )


def test_reader_selection_changes_idempotency_hash():
    common = {
        "content": "where does this word come from?",
        "model_id": uuid4(),
        "reasoning": "default",
        "key_mode": "auto",
        "conversation_id": uuid4(),
        "parent_message_id": None,
        "branch_anchor": NoBranchAnchorRequest(),
        "requested_chat_subject": None,
        "chat_subject": None,
    }
    media_id = uuid4()
    highlight_id = uuid4()
    none_hash = compute_payload_hash(**common, reader_selection=None)
    one_hash = compute_payload_hash(
        **common,
        reader_selection=ReaderSelectionRequest(
            exact="poolpah", media_id=media_id, highlight_id=highlight_id
        ),
    )
    spoofed_text_hash = compute_payload_hash(
        **common,
        reader_selection=ReaderSelectionRequest(
            exact="other", media_id=media_id, highlight_id=highlight_id
        ),
    )
    other_highlight_hash = compute_payload_hash(
        **common,
        reader_selection=ReaderSelectionRequest(
            exact="poolpah", media_id=media_id, highlight_id=uuid4()
        ),
    )

    assert none_hash != one_hash, "A selection must change the idempotency hash"
    assert one_hash == spoofed_text_hash, "Client quote hints are canonicalized from the row"
    assert one_hash != other_highlight_hash, "A different highlight must conflict, not replay"


def test_chat_subject_changes_idempotency_hash():
    common = {
        "content": "summarize this",
        "model_id": uuid4(),
        "reasoning": "default",
        "key_mode": "auto",
        "conversation_id": uuid4(),
        "parent_message_id": None,
        "branch_anchor": NoBranchAnchorRequest(),
        "reader_selection": None,
    }
    from nexus.services.resource_graph.refs import ResourceRef

    none_hash = compute_payload_hash(
        **common,
        requested_chat_subject=None,
        chat_subject=None,
    )
    subject = ResourceRef(scheme="media", id=uuid4())
    media_hash = compute_payload_hash(
        **common,
        requested_chat_subject=subject,
        chat_subject=subject,
    )

    assert none_hash != media_hash
