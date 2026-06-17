from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRunTurnContext, NoteBlock, ResourceExternalSnapshot
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services import context_assembler
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items.chat_subjects import resolve_chat_subject
from tests.factories import add_context_edge, create_test_conversation, create_test_library

pytestmark = pytest.mark.integration


def test_resolve_note_block_chat_subject_orders_context_refs(
    db_session: Session, bootstrapped_user: UUID
):
    block = NoteBlock(
        id=uuid4(),
        user_id=bootstrapped_user,
        body_pm_json={"type": "paragraph", "content": [{"type": "text", "text": "Field note"}]},
        body_text="Field note",
    )
    db_session.add(block)
    library_id = create_test_library(db_session, bootstrapped_user, "Companion Library")

    subject = ResourceRef(scheme="note_block", id=block.id)
    library = ResourceRef(scheme="library", id=library_id)
    resolved = resolve_chat_subject(
        db_session,
        viewer_id=bootstrapped_user,
        requested_ref=subject,
        extra_context_refs=(library, subject),
    )

    assert resolved.requested_ref == subject
    assert resolved.subject_ref == subject
    assert resolved.subject_item.ref == subject.uri
    assert resolved.context_refs == (subject, library)
    assert resolved.companion_refs == ()
    assert resolved.prompt_mode == "inline_body"


def test_note_block_subject_renders_before_compact_context_resource(
    db_session: Session, bootstrapped_user: UUID
):
    block = NoteBlock(
        id=uuid4(),
        user_id=bootstrapped_user,
        body_pm_json={"type": "paragraph", "content": [{"type": "text", "text": "Field note"}]},
        body_text="Field note",
    )
    db_session.add(block)
    db_session.flush()
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    uri = f"note_block:{block.id}"
    edge_id = add_context_edge(db_session, conversation_id, uri)
    db_session.commit()
    turn_context = ChatRunTurnContext(
        chat_run_id=uuid4(),
        requested_subject_scheme="note_block",
        requested_subject_id=block.id,
        subject_scheme="note_block",
        subject_id=block.id,
        subject_context_edge_id=edge_id,
    )

    subject, metadata, subject_uri = context_assembler._build_subject_block(
        db_session,
        turn_context,
        viewer_id=bootstrapped_user,
        conversation_id=conversation_id,
    )
    resources, _resource_metadata, _citations, _revision_refs = (
        context_assembler._build_resources_block(
            db_session,
            conversation_id=conversation_id,
            viewer_id=bootstrapped_user,
            subject_uri=subject_uri,
        )
    )

    assert subject is not None
    assert subject.text.startswith(f'<subject uri="{uri}"')
    assert "<body>Field note</body>" in subject.text
    assert metadata == {
        "role": "subject",
        "resource_uri": uri,
        "requested_resource_uri": uri,
        "context_edge_id": str(edge_id),
    }
    assert resources is not None
    assert f'<resource uri="{uri}"' in resources.text
    assert "<body>Field note</body>" not in resources.text


def test_resolve_chat_subject_rejects_non_subject_resource(
    db_session: Session, bootstrapped_user: UUID
):
    snapshot = ResourceExternalSnapshot(
        id=uuid4(),
        user_id=bootstrapped_user,
        provider="brave",
        url="https://example.org/result",
        title="External result",
        snippet="Snippet",
        source_snapshot={},
    )
    db_session.add(snapshot)
    db_session.commit()

    with pytest.raises(InvalidRequestError) as exc:
        resolve_chat_subject(
            db_session,
            viewer_id=bootstrapped_user,
            requested_ref=ResourceRef(scheme="external_snapshot", id=snapshot.id),
        )

    assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST


def test_resolve_li_artifact_consumes_current_revision_and_library_companion(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = create_test_library(db_session, bootstrapped_user, "Synthesis Library")
    artifact_id, revision_id = _li_artifact_with_current_revision(
        db_session,
        library_id=library_id,
        user_id=bootstrapped_user,
    )

    artifact = ResourceRef(scheme="library_intelligence_artifact", id=artifact_id)
    revision = ResourceRef(scheme="library_intelligence_revision", id=revision_id)
    library = ResourceRef(scheme="library", id=library_id)
    resolved = resolve_chat_subject(
        db_session,
        viewer_id=bootstrapped_user,
        requested_ref=artifact,
        extra_context_refs=(library,),
    )

    assert resolved.requested_ref == artifact
    assert resolved.subject_ref == revision
    assert resolved.subject_item.ref == revision.uri
    assert resolved.context_refs == (revision, library)
    assert resolved.companion_refs == (library,)
    assert resolved.prompt_mode == "generated_output"


def test_resolve_li_artifact_without_current_revision_errors(
    db_session: Session, bootstrapped_user: UUID
):
    library_id = create_test_library(db_session, bootstrapped_user, "Empty Synthesis")
    artifact_id = db_session.execute(
        text(
            """
            INSERT INTO library_intelligence_artifacts (library_id, user_id)
            VALUES (:library_id, :user_id)
            RETURNING id
            """
        ),
        {"library_id": library_id, "user_id": bootstrapped_user},
    ).scalar_one()
    db_session.commit()

    with pytest.raises(InvalidRequestError) as exc:
        resolve_chat_subject(
            db_session,
            viewer_id=bootstrapped_user,
            requested_ref=ResourceRef(
                scheme="library_intelligence_artifact",
                id=UUID(str(artifact_id)),
            ),
        )

    assert exc.value.code == ApiErrorCode.E_INVALID_REQUEST


def _li_artifact_with_current_revision(
    db: Session, *, library_id: UUID, user_id: UUID
) -> tuple[UUID, UUID]:
    artifact_id = db.execute(
        text(
            """
            INSERT INTO library_intelligence_artifacts (library_id, user_id)
            VALUES (:library_id, :user_id)
            RETURNING id
            """
        ),
        {"library_id": library_id, "user_id": user_id},
    ).scalar_one()
    revision_id = db.execute(
        text(
            """
            INSERT INTO library_intelligence_artifact_revisions (
                artifact_id, content_md, covered_targets, status, promoted_at
            )
            VALUES (:artifact_id, 'Synthesis body.', '[]'::jsonb, 'ready', now())
            RETURNING id
            """
        ),
        {"artifact_id": artifact_id},
    ).scalar_one()
    db.execute(
        text(
            "UPDATE library_intelligence_artifacts "
            "SET current_revision_id = :revision_id WHERE id = :artifact_id"
        ),
        {"revision_id": revision_id, "artifact_id": artifact_id},
    )
    db.commit()
    return UUID(str(artifact_id)), UUID(str(revision_id))
