"""Integration tests for chat context lookup hydration."""

import hashlib
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Fragment
from nexus.errors import NotFoundError
from nexus.schemas.notes import ObjectRef
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.content_indexing import rebuild_fragment_content_index
from nexus.services.context_lookup import hydrate_context_ref, hydrate_source_ref
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.object_refs import hydrate_object_ref
from tests.factories import (
    add_media_to_library,
    create_searchable_media,
    create_test_conversation,
    create_test_fragment,
    create_test_highlight,
    create_test_library,
    create_test_media,
    create_test_message,
)

pytestmark = pytest.mark.integration


def test_highlight_contexts_use_highlight_visibility_not_media_visibility(
    db_session: Session,
    bootstrapped_user: UUID,
):
    author_id = UUID("11111111-1111-4111-8111-111111111111")
    ensure_user_and_default_library(db_session, author_id)
    author_library_id = create_test_library(db_session, author_id, "Author Library")
    viewer_library_id = create_test_library(db_session, bootstrapped_user, "Viewer Library")
    media_id = create_test_media(db_session, title="Same media, separate libraries")
    fragment_id = create_test_fragment(db_session, media_id, content="private highlight text")
    add_media_to_library(db_session, author_library_id, media_id)
    add_media_to_library(db_session, viewer_library_id, media_id)
    db_session.commit()

    highlight_id = create_test_highlight(
        db_session,
        author_id,
        fragment_id,
        exact="private highlight text",
    )

    with pytest.raises(NotFoundError):
        hydrate_object_ref(
            db_session,
            bootstrapped_user,
            ObjectRef(object_type="highlight", object_id=highlight_id),
        )

    result = hydrate_context_ref(
        db_session,
        viewer_id=bootstrapped_user,
        context_ref={"type": "highlight", "id": str(highlight_id)},
    )

    assert result.resolved is False
    assert result.failure is not None
    assert result.failure.code == "forbidden"


def test_hydrate_content_chunk_context_ref_checks_media_permission(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = create_searchable_media(db_session, bootstrapped_user, title="Readable Source")
    chunk_id = db_session.execute(
        text("SELECT id FROM content_chunks WHERE media_id = :media_id"),
        {"media_id": media_id},
    ).scalar_one()

    result = hydrate_context_ref(
        db_session,
        viewer_id=bootstrapped_user,
        context_ref={"type": "content_chunk", "id": str(chunk_id)},
    )

    assert result.resolved is True
    assert "Readable Source" in result.evidence_text
    assert "canonical text" in result.evidence_text


def test_hydrate_content_chunk_context_ref_uses_exact_evidence_span(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = create_searchable_media(db_session, bootstrapped_user, title="Exact Span Source")
    row = db_session.execute(
        text(
            """
            SELECT cc.id,
                   cc.index_run_id,
                   cc.source_snapshot_id,
                   ccp.block_id
            FROM content_chunks cc
            JOIN content_chunk_parts ccp ON ccp.chunk_id = cc.id
            WHERE cc.media_id = :media_id
            ORDER BY cc.chunk_idx ASC, ccp.part_idx ASC
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).one()
    span_text = "canonical text"
    evidence_span_id = db_session.execute(
        text(
            """
            INSERT INTO evidence_spans (
                media_id,
                index_run_id,
                source_snapshot_id,
                start_block_id,
                end_block_id,
                start_block_offset,
                end_block_offset,
                span_text,
                span_sha256,
                selector,
                citation_label,
                resolver_kind
            )
            VALUES (
                :media_id,
                :index_run_id,
                :snapshot_id,
                :block_id,
                :block_id,
                12,
                26,
                :span_text,
                :span_sha,
                '{}'::jsonb,
                'Exact',
                'web'
            )
            RETURNING id
            """
        ),
        {
            "media_id": media_id,
            "index_run_id": row[1],
            "snapshot_id": row[2],
            "block_id": row[3],
            "span_text": span_text,
            "span_sha": hashlib.sha256(span_text.encode("utf-8")).hexdigest(),
        },
    ).scalar_one()

    result = hydrate_context_ref(
        db_session,
        viewer_id=bootstrapped_user,
        context_ref={
            "type": "content_chunk",
            "id": str(row[0]),
            "evidence_span_ids": [str(evidence_span_id)],
        },
    )

    assert result.resolved is True
    assert f"<evidence_span_id>{evidence_span_id}</evidence_span_id>" in result.evidence_text
    assert "<evidence_span>canonical text</evidence_span>" in result.evidence_text
    assert "various topics" not in result.evidence_text


def test_hydrate_message_retrieval_preserves_citation_and_evidence_span_id(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = create_searchable_media(db_session, bootstrapped_user, title="Retrieved Source")
    chunk_id, evidence_span_id = db_session.execute(
        text(
            """
            SELECT cc.id, es.id
            FROM content_chunks cc
            JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
            WHERE cc.media_id = :media_id
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).one()
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=1,
        role="user",
        content="find retrieved source",
    )
    assistant_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=2,
        role="assistant",
        content="",
        status="pending",
    )
    tool_call_id = db_session.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                conversation_id,
                user_message_id,
                assistant_message_id,
                tool_name,
                tool_call_index,
                scope,
                requested_types,
                semantic,
                result_refs,
                selected_context_refs,
                provider_request_ids,
                latency_ms,
                status
            )
            VALUES (
                :conversation_id,
                :user_message_id,
                :assistant_message_id,
                'app_search',
                0,
                'all',
                '["content_chunk"]'::jsonb,
                true,
                '[]'::jsonb,
                '[]'::jsonb,
                '[]'::jsonb,
                0,
                'complete'
            )
            RETURNING id
            """
        ),
        {
            "conversation_id": conversation_id,
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id,
        },
    ).scalar_one()
    retrieval_id = db_session.execute(
        text(
            """
            INSERT INTO message_retrievals (
                tool_call_id,
                ordinal,
                result_type,
                source_id,
                media_id,
                evidence_span_id,
                scope,
                context_ref,
                result_ref,
                deep_link,
                score,
                selected,
                source_title,
                exact_snippet,
                retrieval_status
            )
            VALUES (
                :tool_call_id,
                0,
                'content_chunk',
                :source_id,
                :media_id,
                :evidence_span_id,
                'all',
                jsonb_build_object('type', 'content_chunk', 'id', CAST(:source_id AS text)),
                jsonb_build_object(
                    'result_type', 'content_chunk',
                    'source_id', CAST(:source_id AS text),
                    'evidence_span_id', CAST(:evidence_span_id_text AS text),
                    'snippet', 'retrieved snippet'
                ),
                '/media/test',
                1.0,
                true,
                'Retrieved Source',
                'retrieved snippet',
                'selected'
            )
            RETURNING id
            """
        ),
        {
            "tool_call_id": tool_call_id,
            "source_id": str(chunk_id),
            "media_id": media_id,
            "evidence_span_id": evidence_span_id,
            "evidence_span_id_text": str(evidence_span_id),
        },
    ).scalar_one()

    result = hydrate_source_ref(
        db_session,
        viewer_id=bootstrapped_user,
        source_ref={"type": "message_retrieval", "id": str(retrieval_id)},
    )

    assert result.resolved is True
    assert result.context_ref is not None
    assert result.context_ref["evidence_span_ids"] == [str(evidence_span_id)]
    assert result.citations[0]["evidence_span_id"] == str(evidence_span_id)


def test_hydrate_message_retrieval_rejects_evidence_span_from_other_chunk_run(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = create_searchable_media(db_session, bootstrapped_user, title="Replay Source")
    old_chunk_id, old_run_id = db_session.execute(
        text(
            """
            SELECT cc.id, cc.index_run_id
            FROM content_chunks cc
            WHERE cc.media_id = :media_id
            ORDER BY cc.chunk_idx ASC
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).one()
    fragment = db_session.query(Fragment).filter(Fragment.media_id == media_id).one()
    rebuild_fragment_content_index(
        db_session,
        media_id=media_id,
        source_kind="web_article",
        artifact_ref=f"fragments:{fragment.id}:replay",
        fragments=[fragment],
        reason="test_replay_run_mismatch",
    )
    new_span_id = db_session.execute(
        text(
            """
            SELECT cc.primary_evidence_span_id
            FROM content_chunks cc
            WHERE cc.media_id = :media_id
              AND cc.index_run_id <> :old_run_id
            ORDER BY cc.chunk_idx ASC
            LIMIT 1
            """
        ),
        {"media_id": media_id, "old_run_id": old_run_id},
    ).scalar_one()
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=1,
        role="user",
        content="find replay source",
    )
    assistant_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=2,
        role="assistant",
        content="",
        status="pending",
    )
    tool_call_id = db_session.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                conversation_id,
                user_message_id,
                assistant_message_id,
                tool_name,
                tool_call_index,
                scope,
                requested_types,
                semantic,
                result_refs,
                selected_context_refs,
                provider_request_ids,
                latency_ms,
                status
            )
            VALUES (
                :conversation_id,
                :user_message_id,
                :assistant_message_id,
                'app_search',
                0,
                'all',
                '["content_chunk"]'::jsonb,
                true,
                '[]'::jsonb,
                '[]'::jsonb,
                '[]'::jsonb,
                0,
                'complete'
            )
            RETURNING id
            """
        ),
        {
            "conversation_id": conversation_id,
            "user_message_id": user_message_id,
            "assistant_message_id": assistant_message_id,
        },
    ).scalar_one()
    retrieval_id = db_session.execute(
        text(
            """
            INSERT INTO message_retrievals (
                tool_call_id,
                ordinal,
                result_type,
                source_id,
                media_id,
                evidence_span_id,
                scope,
                context_ref,
                result_ref,
                deep_link,
                score,
                selected,
                source_title,
                exact_snippet,
                retrieval_status
            )
            VALUES (
                :tool_call_id,
                0,
                'content_chunk',
                :source_id,
                :media_id,
                :evidence_span_id,
                'all',
                jsonb_build_object('type', 'content_chunk', 'id', CAST(:source_id AS text)),
                jsonb_build_object(
                    'result_type', 'content_chunk',
                    'source_id', CAST(:source_id AS text),
                    'evidence_span_id', CAST(:evidence_span_id_text AS text),
                    'snippet', 'stale replay snippet'
                ),
                '/media/test',
                1.0,
                true,
                'Replay Source',
                'stale replay snippet',
                'selected'
            )
            RETURNING id
            """
        ),
        {
            "tool_call_id": tool_call_id,
            "source_id": str(old_chunk_id),
            "media_id": media_id,
            "evidence_span_id": new_span_id,
            "evidence_span_id_text": str(new_span_id),
        },
    ).scalar_one()

    result = hydrate_source_ref(
        db_session,
        viewer_id=bootstrapped_user,
        source_ref={"type": "message_retrieval", "id": str(retrieval_id)},
    )

    assert result.resolved is False
    assert result.failure is not None
    assert result.failure.code == "not_found"


def test_hydrate_content_chunk_context_ref_returns_typed_failure_when_unreadable(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = create_test_media(db_session, title="Private Source")
    fragment_id = create_test_fragment(db_session, media_id, content="Private text")
    fragment = db_session.get(Fragment, fragment_id)
    assert fragment is not None
    insert_fragment_blocks(db_session, fragment_id, parse_fragment_blocks(fragment.canonical_text))
    rebuild_fragment_content_index(
        db_session,
        media_id=media_id,
        source_kind="web_article",
        artifact_ref=f"fragments:{fragment_id}",
        fragments=[fragment],
        reason="test",
    )
    chunk_id = db_session.execute(
        text("SELECT id FROM content_chunks WHERE media_id = :media_id"),
        {"media_id": media_id},
    ).scalar_one()

    result = hydrate_context_ref(
        db_session,
        viewer_id=bootstrapped_user,
        context_ref={"type": "content_chunk", "id": str(chunk_id)},
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
