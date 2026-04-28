"""Integration tests for chat context lookup hydration."""

from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import Fragment
from nexus.services.context_lookup import hydrate_context_ref, hydrate_source_ref
from tests.factories import (
    create_searchable_media,
    create_test_conversation,
    create_test_fragment,
    create_test_media,
    create_test_message,
)

pytestmark = pytest.mark.integration


def test_hydrate_fragment_context_ref_checks_media_permission(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = create_searchable_media(db_session, bootstrapped_user, title="Readable Source")
    fragment = db_session.scalars(select(Fragment).where(Fragment.media_id == media_id)).first()
    assert fragment is not None

    result = hydrate_context_ref(
        db_session,
        viewer_id=bootstrapped_user,
        context_ref={"type": "fragment", "id": str(fragment.id)},
    )

    assert result.resolved is True
    assert "Readable Source" in result.evidence_text
    assert "canonical text" in result.evidence_text


def test_hydrate_fragment_context_ref_returns_typed_failure_when_unreadable(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = create_test_media(db_session, title="Private Source")
    fragment_id = create_test_fragment(db_session, media_id, content="Private text")

    result = hydrate_context_ref(
        db_session,
        viewer_id=bootstrapped_user,
        context_ref={"type": "fragment", "id": str(fragment_id)},
    )

    assert result.resolved is False
    assert result.failure is not None
    assert result.failure.code == "forbidden"


def test_hydrate_message_source_ref_checks_conversation_permission(
    db_session: Session,
    bootstrapped_user: UUID,
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    message_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=1,
        role="user",
        content="We decided to keep source refs explicit.",
    )

    result = hydrate_source_ref(
        db_session,
        viewer_id=bootstrapped_user,
        source_ref={"type": "message", "message_id": str(message_id)},
    )

    assert result.resolved is True
    assert "source refs explicit" in result.evidence_text


def test_hydrate_web_result_source_ref_renders_embedded_result_ref(
    db_session: Session,
    bootstrapped_user: UUID,
):
    result = hydrate_source_ref(
        db_session,
        viewer_id=bootstrapped_user,
        source_ref={
            "type": "web_result",
            "id": "web_1",
            "result_ref": {
                "result_ref": "web_1",
                "title": "OpenAI Docs",
                "url": "https://platform.openai.com/docs",
                "snippet": "Documentation snippet",
            },
        },
    )

    assert result.resolved is True
    assert "<title>OpenAI Docs</title>" in result.evidence_text
    assert result.citations[0]["url"] == "https://platform.openai.com/docs"
