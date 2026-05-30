"""Integration tests for the ``read_resource`` agent tool.

Covers the contract enforced by ``execute_read_resource``:

- Resource must already be a reference of the current conversation.
- Media/library URIs are not readable — the model is told to call
  ``app_search`` instead.
- Span/highlight/page/note_block/fragment/conversation/message URIs return
  the full body when visible to the viewer.
- Missing or forbidden URIs return ``status="error"`` rather than raising.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.services.agent_tools.read_resource import execute_read_resource
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.conversation_references import insert_reference_if_absent
from tests.factories import (
    create_test_conversation,
    create_test_media_in_library,
    create_test_message,
    get_user_default_library,
)
from tests.test_resource_resolver import (
    _make_highlight_with_anchor,
    _make_note_block,
    _make_page,
    _make_span,
)

pytestmark = pytest.mark.integration


# =============================================================================
# Helpers
# =============================================================================


def _admit_reference(db: Session, conversation_id: UUID, uri: str) -> None:
    """Add a reference row directly (skips owner check; mirrors citation path)."""
    insert_reference_if_absent(db, conversation_id, uri)
    db.commit()


# =============================================================================
# Tests
# =============================================================================


def test_read_resource_not_in_references_errors_with_actionable_hint(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Unrefed Source"
    )
    span_id = _make_span(db_session, media_id, text="Span content.")
    uri = f"span:{span_id}"

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert result.is_error, (
        f"Reading a URI that isn't a conversation reference must error; got {result}"
    )
    assert result.error_code == "not_in_references", (
        f"Expected error_code='not_in_references'; got {result.error_code}"
    )
    assert "app_search" in result.body, (
        f"Error body should point the model at app_search; got {result.body}"
    )


def test_read_resource_media_uri_returns_scope_not_readable_error(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Big Source"
    )
    uri = f"media:{media_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert result.is_error, f"Media URIs must surface a scope-not-readable error; got {result}"
    assert result.error_code == "scope_not_readable", (
        f"Expected error_code='scope_not_readable'; got {result.error_code}"
    )
    assert "app_search" in result.body, (
        "Error body should redirect the model to app_search with the media scope"
    )


def test_read_resource_library_uri_returns_scope_not_readable_error(
    db_session: Session, bootstrapped_user: UUID
):
    from tests.factories import create_test_library

    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = create_test_library(db_session, bootstrapped_user, "Search Scope")
    uri = f"library:{library_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert result.is_error, f"Library URIs must error; got {result}"
    assert result.error_code == "scope_not_readable"


def test_read_resource_span_returns_body(db_session: Session, bootstrapped_user: UUID):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Span Source"
    )
    span_text = "Full span body for read_resource."
    span_id = _make_span(db_session, media_id, text=span_text)
    uri = f"span:{span_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert not result.is_error, f"Span read should succeed; got {result}"
    assert result.body == span_text, f"Expected full span text; got {result.body!r}"


def test_read_resource_highlight_returns_exact_text(db_session: Session, bootstrapped_user: UUID):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Highlighted Source"
    )
    _make_span(db_session, media_id, text="Background text.")
    highlight_id = _make_highlight_with_anchor(db_session, bootstrapped_user, media_id)
    uri = f"highlight:{highlight_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert not result.is_error, f"Highlight read should succeed; got {result}"
    assert result.body == "some highlighted text"


def test_read_resource_page_owner_returns_description(db_session: Session, bootstrapped_user: UUID):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    page_id = _make_page(db_session, bootstrapped_user, description="Page body for tool.")
    uri = f"page:{page_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert not result.is_error
    assert result.body == "Page body for tool."


def test_read_resource_page_non_owner_returns_missing_error(
    db_session: Session, bootstrapped_user: UUID
):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    page_id = _make_page(db_session, other_user_id, description="Private page.")
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    uri = f"page:{page_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert result.is_error, "Permission denial must surface as a tool-level error"
    assert result.error_code == "missing"


def test_read_resource_note_block_owner_returns_body(db_session: Session, bootstrapped_user: UUID):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    block_id = _make_note_block(db_session, bootstrapped_user, body="Body via read_resource.")
    uri = f"note_block:{block_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert not result.is_error
    assert result.body == "Body via read_resource."


def test_read_resource_message_returns_role_and_content(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    message_id = create_test_message(
        db_session, conversation_id, seq=1, content="What about evolution?"
    )
    uri = f"message:{message_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert not result.is_error, f"Message read should succeed; got {result}"
    assert "What about evolution?" in result.body, (
        f"Message body should include the user content; got {result.body!r}"
    )


def test_read_resource_unknown_scheme_errors_without_raising(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    uri = f"unknown_scheme:{uuid4()}"
    # Admit raw via direct SQL because the public service path validates the URI grammar.
    from sqlalchemy import text as sql_text

    db_session.execute(
        sql_text(
            """
            INSERT INTO conversation_references (conversation_id, resource_uri)
            VALUES (:conversation_id, :resource_uri)
            """
        ),
        {"conversation_id": conversation_id, "resource_uri": uri},
    )
    db_session.commit()

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert result.is_error
    assert result.error_code == "unknown_scheme"


def test_read_resource_invalid_uuid_returns_invalid_uri_error(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    uri = "span:not-a-uuid"
    from sqlalchemy import text as sql_text

    db_session.execute(
        sql_text(
            """
            INSERT INTO conversation_references (conversation_id, resource_uri)
            VALUES (:conversation_id, :resource_uri)
            """
        ),
        {"conversation_id": conversation_id, "resource_uri": uri},
    )
    db_session.commit()

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert result.is_error
    assert result.error_code == "invalid_uri"
