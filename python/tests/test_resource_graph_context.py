"""Integration tests for graph-owned conversation context read models."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.services.resource_graph.context import (
    search_scope_expansions_for_conversation,
    search_scope_refs_for_conversation,
)
from nexus.services.resource_graph.edges import create_edge
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_graph.schemas import CitationSnapshot, EdgeCreate
from tests.factories import (
    add_context_edge,
    create_test_conversation,
    create_test_media_in_library,
    get_user_default_library,
)
from tests.helpers import create_test_user_id

pytestmark = pytest.mark.integration


def test_search_scope_expansions_return_visible_capability_allowed_refs(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Graph expanded source"
    )
    synapse_media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Synapse edge source"
    )
    page_id = uuid4()
    note_block_id = uuid4()
    unrelated_note_block_id = uuid4()
    db_session.execute(
        text("INSERT INTO pages (id, user_id, title) VALUES (:id, :user_id, 'Graph page')"),
        {"id": page_id, "user_id": bootstrapped_user},
    )
    db_session.execute(
        text(
            """
            INSERT INTO note_blocks (id, user_id, body_pm_json, body_text)
            VALUES
                (:note_block_id, :user_id, '{"type":"paragraph"}'::jsonb, 'Seed note'),
                (:unrelated_note_block_id, :user_id, '{"type":"paragraph"}'::jsonb,
                 'Unsupported candidate note')
            """
        ),
        {
            "note_block_id": note_block_id,
            "unrelated_note_block_id": unrelated_note_block_id,
            "user_id": bootstrapped_user,
        },
    )
    page_ref = ResourceRef(scheme="page", id=page_id)
    note_ref = ResourceRef(scheme="note_block", id=note_block_id)
    media_ref = ResourceRef(scheme="media", id=media_id)
    create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(
            source=page_ref,
            target=note_ref,
            kind="context",
            origin="user",
            source_order_key="0000000001",
        ),
    )
    media_edge = create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(source=note_ref, target=media_ref, kind="context", origin="user"),
    )
    create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(
            source=note_ref,
            target=ResourceRef(scheme="note_block", id=unrelated_note_block_id),
            kind="context",
            origin="user",
        ),
    )
    create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(
            source=note_ref,
            target=ResourceRef(scheme="media", id=synapse_media_id),
            kind="context",
            origin="synapse",
            snapshot=CitationSnapshot(excerpt="Machine-suggested related source."),
        ),
    )

    other_user_id = create_test_user_id()
    invisible_media_id = uuid4()
    db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": other_user_id})
    db_session.execute(
        text(
            """
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:id, 'web_article', 'Invisible graph source', 'ready_for_reading',
                    :other_user_id)
            """
        ),
        {"id": invisible_media_id, "other_user_id": other_user_id},
    )
    db_session.execute(
        text(
            """
            INSERT INTO resource_edges (
                user_id, kind, origin, source_scheme, source_id, target_scheme, target_id
            )
            VALUES (
                :user_id, 'context', 'user', 'note_block', :note_block_id,
                'media', :invisible_media_id
            )
            """
        ),
        {
            "user_id": bootstrapped_user,
            "note_block_id": note_block_id,
            "invisible_media_id": invisible_media_id,
        },
    )
    add_context_edge(db_session, conversation_id, f"page:{page_id}")
    db_session.commit()

    assert (
        search_scope_refs_for_conversation(
            db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id
        )
        == []
    )

    expansions = search_scope_expansions_for_conversation(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id
    )

    assert [expansion.ref for expansion in expansions] == [media_ref]
    expansion = expansions[0]
    assert expansion.edge_id == media_edge.id
    assert expansion.direction == "outgoing"
    assert expansion.kind == "context"
    assert expansion.origin == "user"
    assert expansion.source == note_ref
    assert expansion.target == media_ref


def test_search_scope_expansions_do_not_seed_from_generated_outputs(
    db_session: Session, bootstrapped_user: UUID
):
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session, bootstrapped_user, library_id, title="Generated-neighbor source"
    )
    reading_id = uuid4()
    db_session.execute(
        text(
            """
            INSERT INTO oracle_readings (
                id, user_id, folio_number, question_text, status, completed_at
            )
            VALUES (
                :id, :user_id, 1, 'Generated output seed?', 'complete', now()
            )
            """
        ),
        {"id": reading_id, "user_id": bootstrapped_user},
    )
    reading_ref = ResourceRef(scheme="oracle_reading", id=reading_id)
    create_edge(
        db_session,
        viewer_id=bootstrapped_user,
        input=EdgeCreate(
            source=reading_ref,
            target=ResourceRef(scheme="media", id=media_id),
            kind="context",
            origin="user",
        ),
    )
    add_context_edge(db_session, conversation_id, f"oracle_reading:{reading_id}")
    db_session.commit()

    assert (
        search_scope_expansions_for_conversation(
            db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id
        )
        == []
    )
