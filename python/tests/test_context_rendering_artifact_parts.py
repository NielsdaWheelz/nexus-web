"""Integration coverage for artifact part context rendering."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.conversation import MessageContextRef
from nexus.services.context_lookup import hydrate_context_ref
from nexus.services.context_rendering import render_context_blocks
from tests.factories import create_test_conversation, create_test_message

pytestmark = pytest.mark.integration


def _artifact_part_context_ref(
    *,
    conversation_id: UUID,
    message_id: UUID,
    artifact_id: UUID,
    part_id: UUID,
    artifact_kind: str = "timeline",
    artifact_key: str = "timeline-1",
    part_key: str = "event-1",
    part_type: str = "event",
    text: str | None = None,
) -> dict[str, object]:
    source_version = f"artifact_part:{part_id}:v1"
    locator = {
        "type": "artifact_part_ref",
        "artifact_id": str(artifact_id),
        "artifact_part_id": str(part_id),
        "message_id": str(message_id),
        "conversation_id": str(conversation_id),
        "part_key": part_key,
    }
    provenance: dict[str, object] = {
        "type": "artifact_part",
        "artifact_id": str(artifact_id),
        "artifact_kind": artifact_kind,
        "message_id": str(message_id),
        "conversation_id": str(conversation_id),
        "artifact_key": artifact_key,
        "artifact_part_id": str(part_id),
        "ordinal": 0,
        "part_key": part_key,
        "part_type": part_type,
        "source_version": source_version,
        "locator": locator,
    }
    if text is not None:
        provenance["text"] = text
    return {
        "type": "artifact_part",
        "id": str(part_id),
        "artifact_id": str(artifact_id),
        "artifact_key": artifact_key,
        "source_version": source_version,
        "locator": locator,
        "artifact_part_provenance": provenance,
    }


def test_artifact_part_context_ref_renders_durable_metadata_and_skips_missing(
    db_session: Session,
    bootstrapped_user: UUID,
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=1,
        role="user",
        content="Create a durable timeline.",
    )
    assistant_message_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=2,
        role="assistant",
        content="Done.",
        parent_message_id=user_message_id,
    )
    artifact_id = uuid4()
    part_id = uuid4()
    part_text = "Durable artifact part text & source detail"

    db_session.execute(
        text(
            """
            INSERT INTO message_artifacts (
                id,
                conversation_id,
                message_id,
                artifact_key,
                artifact_kind,
                title,
                status,
                preview_text
            )
            VALUES (
                :artifact_id,
                :conversation_id,
                :message_id,
                'timeline-1',
                'timeline',
                'Research Timeline',
                'complete',
                'Durable preview'
            )
            """
        ),
        {
            "artifact_id": artifact_id,
            "conversation_id": conversation_id,
            "message_id": assistant_message_id,
        },
    )
    db_session.execute(
        text(
            """
            INSERT INTO message_artifact_parts (
                id,
                artifact_id,
                ordinal,
                part_key,
                part_type,
                text,
                source_version,
                locator,
                metadata
            )
            VALUES (
                :part_id,
                :artifact_id,
                0,
                'event-1',
                'event',
                :part_text,
                concat('artifact_part', chr(58), CAST(:part_id AS text), chr(58), 'v1'),
                jsonb_build_object(
                    'type', 'artifact_part_ref',
                    'artifact_id', CAST(:artifact_id AS text),
                    'artifact_part_id', CAST(:part_id AS text),
                    'message_id', CAST(:message_id AS text),
                    'conversation_id', CAST(:conversation_id AS text),
                    'part_key', 'event-1'
                ),
                '{"support_state":"not_source_grounded"}'::jsonb
            )
            """
        ),
        {
            "part_id": part_id,
            "artifact_id": artifact_id,
            "message_id": assistant_message_id,
            "conversation_id": conversation_id,
            "part_text": part_text,
        },
    )
    db_session.commit()
    context_ref = _artifact_part_context_ref(
        conversation_id=conversation_id,
        message_id=assistant_message_id,
        artifact_id=artifact_id,
        part_id=part_id,
        text=part_text,
    )
    source_version = f"artifact_part:{part_id}:v1"

    rendered, total_chars = render_context_blocks(
        db_session,
        [MessageContextRef.model_validate(context_ref)],
    )

    assert rendered, (
        "Expected artifact_part context ref to render durable artifact metadata and part text, "
        f"got empty output with total_chars={total_chars}"
    )
    assert total_chars == len(rendered), (
        f"Expected a single artifact_part block to determine total_chars, got {total_chars}: "
        f"{rendered}"
    )
    assert "<artifact_part>" in rendered
    assert f"<artifact_id>{artifact_id}</artifact_id>" in rendered
    assert f"<conversation_id>{conversation_id}</conversation_id>" in rendered
    assert f"<message_id>{assistant_message_id}</message_id>" in rendered
    assert "<artifact_kind>timeline</artifact_kind>" in rendered
    assert "<artifact_title>Research Timeline</artifact_title>" in rendered
    assert "<ordinal>0</ordinal>" in rendered
    assert "<part_key>event-1</part_key>" in rendered
    assert "<part_type>event</part_type>" in rendered
    assert f"<source_version>{source_version}</source_version>" in rendered
    assert f'"artifact_part_id":"{part_id}"' in rendered
    assert "<content>Durable artifact part text &amp; source detail</content>" in rendered

    hydrated = hydrate_context_ref(
        db_session,
        viewer_id=bootstrapped_user,
        context_ref=context_ref,
    )

    assert hydrated.resolved, hydrated.failure
    assert "<artifact_part>" in hydrated.evidence_text
    assert "<content>Durable artifact part text &amp; source detail</content>" in (
        hydrated.evidence_text
    )

    db_session.execute(
        text(
            """
            UPDATE message_artifact_parts
            SET locator = jsonb_set(
                locator,
                '{artifact_part_id}',
                to_jsonb(CAST(:wrong_part_id AS text))
            )
            WHERE id = :part_id
            """
        ),
        {"part_id": part_id, "wrong_part_id": str(uuid4())},
    )
    db_session.commit()

    mismatched_rendered, mismatched_total_chars = render_context_blocks(
        db_session,
        [MessageContextRef.model_validate(context_ref)],
    )
    assert mismatched_rendered == ""
    assert mismatched_total_chars == 0

    missing_artifact_id = uuid4()
    missing_part_id = uuid4()
    missing_context_ref = _artifact_part_context_ref(
        conversation_id=conversation_id,
        message_id=assistant_message_id,
        artifact_id=missing_artifact_id,
        part_id=missing_part_id,
        artifact_key="missing-artifact",
        part_key="missing",
    )
    missing_rendered, missing_total_chars = render_context_blocks(
        db_session,
        [MessageContextRef.model_validate(missing_context_ref)],
    )

    assert missing_rendered == ""
    assert missing_total_chars == 0
