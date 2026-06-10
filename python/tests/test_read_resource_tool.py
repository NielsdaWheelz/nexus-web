"""Integration tests for the ``read_resource`` agent tool.

Covers the contract enforced by ``execute_read_resource``:

- Resource must already be a reference of the current conversation.
- Media URIs read the whole short document or redirect oversized documents to
  ``inspect_resource``; library URIs remain search scopes.
- Span/highlight/page/note_block/fragment/conversation/message URIs return
  the full body when visible to the viewer.
- Missing or forbidden URIs return ``status="error"`` rather than raising.
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.services.agent_tools.read_resource import ReadResourceResult, execute_read_resource
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.contributor_credits import replace_media_contributor_credits
from nexus.services.conversation_references import insert_reference_if_absent
from tests.factories import (
    create_test_conversation,
    create_test_media_in_library,
    create_test_message,
    get_user_default_library,
)
from tests.test_resource_resolver import (
    _add_fragment,
    _make_highlight_with_anchor,
    _make_li_artifact,
    _make_note_block,
    _make_oracle_reading,
    _make_page,
    _make_pdf,
    _make_span,
)

pytestmark = pytest.mark.integration


def test_read_resource_tool_output_escapes_attribute_quotes():
    result = ReadResourceResult(
        uri='fragment:"quoted"',
        status="error",
        body='Bad "resource" <body>',
        error_code='bad"code',
    )

    output = result.tool_output()

    assert 'uri="fragment:&quot;quoted&quot;"' in output
    assert 'code="bad&quot;code"' in output
    assert 'Bad "resource" &lt;body&gt;' in output


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


def test_read_resource_media_short_returns_full(db_session: Session, bootstrapped_user: UUID):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Short Article"
    )
    _add_fragment(db_session, media_id, idx=0, text="First paragraph.")
    _add_fragment(db_session, media_id, idx=1, text="Second paragraph.")
    uri = f"media:{media_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert not result.is_error, f"A short media document should read whole; got {result}"
    assert result.kind == "full"
    assert "First paragraph." in result.body and "Second paragraph." in result.body


def test_read_resource_media_over_budget_redirects_to_inspect(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Huge Article"
    )
    _add_fragment(db_session, media_id, idx=0, text="x" * 60_000)
    uri = f"media:{media_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert not result.is_error
    assert result.kind == "too_large", f"Over-budget media should redirect, not dump; got {result}"
    assert "inspect_resource" in result.body


def test_read_resource_pdf_page_range_slices_plain_text(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = _make_pdf(
        db_session, library_id, pages=["PAGE-ONE-TEXT. ", "PAGE-TWO-TEXT. ", "PAGE-THREE-TEXT. "]
    )
    _admit_reference(db_session, conversation_id, f"media:{media_id}")
    uri = f"page_range:{media_id}:2-3"

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert not result.is_error, f"page_range read should succeed; got {result}"
    assert result.kind == "page_range"
    assert result.body == "PAGE-TWO-TEXT. PAGE-THREE-TEXT. "
    assert "PAGE-ONE-TEXT" not in result.body


def test_read_resource_media_derived_pointer_readable_via_parent_media(
    db_session: Session, bootstrapped_user: UUID
):
    """Gate O2: a fragment is readable when its parent media is referenced."""
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Mapped Article"
    )
    fragment_id = _add_fragment(db_session, media_id, idx=0, text="A readable section body.")
    # Only the parent media is referenced; the fragment sub-URI is not.
    _admit_reference(db_session, conversation_id, f"media:{media_id}")

    result = execute_read_resource(
        db_session,
        viewer_id=bootstrapped_user,
        conversation_id=conversation_id,
        uri=f"fragment:{fragment_id}",
    )

    assert not result.is_error, f"A fragment of a referenced media should be readable; got {result}"
    assert result.kind == "section"
    assert result.body == "A readable section body."


def test_read_resource_fragment_without_referenced_parent_errors(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Unpinned Article"
    )
    fragment_id = _add_fragment(db_session, media_id, idx=0, text="Body.")
    # Nothing is referenced — neither the fragment nor its parent media.

    result = execute_read_resource(
        db_session,
        viewer_id=bootstrapped_user,
        conversation_id=conversation_id,
        uri=f"fragment:{fragment_id}",
    )

    assert result.is_error
    assert result.error_code == "not_in_references"


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


def test_read_resource_li_artifact_returns_current_revision_body(
    db_session: Session, bootstrapped_user: UUID
):
    from tests.factories import create_test_library

    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = create_test_library(db_session, bootstrapped_user, "Readable Synthesis")
    content_md = "The whole synthesis prose with a citation [1]."
    artifact_id = _make_li_artifact(
        db_session, library_id, bootstrapped_user, content_md=content_md
    )
    uri = f"library_intelligence_artifact:{artifact_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert not result.is_error, f"A member should read the artifact body; got {result}"
    assert result.kind == "library_intelligence"
    assert result.body == content_md
    # NON-citable: its [N] reference the revision's own citations, not a search chip.
    assert result.citation_result_type is None
    assert result.citation_source_id is None


def test_read_resource_li_artifact_non_member_masked(db_session: Session, bootstrapped_user: UUID):
    from tests.factories import create_test_library

    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    other_library_id = create_test_library(db_session, other_user_id, "Closed Synthesis")
    artifact_id = _make_li_artifact(db_session, other_library_id, other_user_id)
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    uri = f"library_intelligence_artifact:{artifact_id}"
    # Admit the reference so the gate passes; the loader masks the non-member.
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert result.is_error, "A non-member must not read another library's artifact"
    assert result.error_code == "missing"


def test_read_resource_oracle_reading_returns_body_non_citable(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    reading_id = _make_oracle_reading(
        db_session,
        bootstrapped_user,
        question="What does the lamp reveal?",
        interpretation="I saw the dawn break over the wood.",
    )
    uri = f"oracle_reading:{reading_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert not result.is_error, f"the owner should read the reading body; got {result}"
    assert result.kind == "oracle_reading"
    assert "Question: What does the lamp reveal?" in result.body
    assert "I saw the dawn break over the wood." in result.body
    # NON-citable, like the LI artifact: passage chips are rendered by the oracle pane.
    assert result.citation_result_type is None
    assert result.citation_source_id is None


def test_read_resource_oracle_reading_non_owner_masked(
    db_session: Session, bootstrapped_user: UUID
):
    other_user_id = uuid4()
    ensure_user_and_default_library(db_session, other_user_id)
    reading_id = _make_oracle_reading(db_session, other_user_id)
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    uri = f"oracle_reading:{reading_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert result.is_error, "a non-owner must not read another user's reading"
    assert result.error_code == "missing"


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
    assert result.kind == "span"
    assert result.body == span_text, f"Expected full span text; got {result.body!r}"


def test_read_resource_highlight_returns_enriched_quote(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Highlighted Source"
    )
    replace_media_contributor_credits(
        db_session,
        media_id=media_id,
        credits=[{"name": "Octavia Butler", "role": "author"}],
        source="manual",
    )
    highlight_id = _make_highlight_with_anchor(
        db_session,
        bootstrapped_user,
        media_id,
        exact="some highlighted text",
        prefix="before ",
        suffix=" after",
    )
    uri = f"highlight:{highlight_id}"
    _admit_reference(db_session, conversation_id, uri)

    result = execute_read_resource(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, uri=uri
    )

    assert not result.is_error, f"Highlight read should succeed; got {result}"
    assert result.quote is not None, "A highlight read carries the enriched quote"
    assert result.quote.exact == "some highlighted text"
    assert result.quote.prefix == "before "
    assert result.quote.suffix == " after"
    output = result.tool_output()
    assert 'kind="quote"' in output, f"Read output should label kind=quote; got {output}"
    assert "<prefix>before </prefix>" in output
    assert "<exact>some highlighted text</exact>" in output
    assert "<suffix> after</suffix>" in output
    assert "“Highlighted Source” by Octavia Butler" in output, (
        "Quote source should name the parent media and author"
    )


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
