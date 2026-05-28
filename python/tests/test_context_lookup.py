"""Integration tests for chat context lookup hydration."""

import hashlib
import json
from uuid import UUID

import pytest
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
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


def test_hydrate_highlight_context_ref_requires_source_version(
    db_session: Session,
    bootstrapped_user: UUID,
):
    library_id = create_test_library(db_session, bootstrapped_user, "Highlight Context Library")
    media_id = create_test_media(db_session, title="Readable Highlight Source")
    add_media_to_library(db_session, library_id, media_id)
    fragment_id = create_test_fragment(db_session, media_id, content="private highlight text")
    highlight_id = create_test_highlight(
        db_session,
        bootstrapped_user,
        fragment_id,
        exact="private highlight text",
    )

    result = hydrate_context_ref(
        db_session,
        viewer_id=bootstrapped_user,
        context_ref={"type": "highlight", "id": str(highlight_id)},
    )

    assert result.resolved is False
    assert result.failure is not None
    assert result.failure.code == "invalid"
    assert result.failure.message == "highlight context_ref requires source_version"


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


def test_hydrate_message_context_source_ref_rejects_content_chunk_missing_canonical_snapshot(
    db_session: Session,
    bootstrapped_user: UUID,
):
    chunk_id = UUID("11111111-1111-4111-8111-111111111111")
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    message_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=1,
        role="user",
        content="Use the attached chunk.",
    )
    context_id = db_session.execute(
        text(
            """
            INSERT INTO message_context_items (
                message_id,
                user_id,
                context_kind,
                object_type,
                object_id,
                ordinal,
                context_snapshot
            )
            VALUES (
                :message_id,
                :user_id,
                'object_ref',
                'content_chunk',
                :object_id,
                0,
                :context_snapshot
            )
            RETURNING id
            """
        ).bindparams(bindparam("context_snapshot", type_=JSONB)),
        {
            "message_id": message_id,
            "user_id": bootstrapped_user,
            "object_id": chunk_id,
            "context_snapshot": {
                "kind": "object_ref",
                "type": "content_chunk",
                "id": str(chunk_id),
                "title": "Stale chunk context",
            },
        },
    ).scalar_one()
    db_session.commit()

    result = hydrate_source_ref(
        db_session,
        viewer_id=bootstrapped_user,
        source_ref={"type": "message_context", "id": str(context_id)},
    )

    assert result.resolved is False
    assert result.failure is not None
    assert result.failure.code == "not_found"


def test_hydrate_media_backed_context_refs_include_episode_video_and_fragment(
    db_session: Session,
    bootstrapped_user: UUID,
):
    library_id = create_test_library(db_session, bootstrapped_user, "Research Library")
    video_id = create_test_media(db_session, title="Readable Video")
    episode_id = create_test_media(db_session, title="Readable Episode")
    fragment_media_id = create_test_media(db_session, title="Readable Fragment Source")
    fragment_id = create_test_fragment(
        db_session, fragment_media_id, content="fragment evidence text"
    )
    db_session.execute(
        text("UPDATE media SET kind = 'video' WHERE id = :media_id"),
        {"media_id": video_id},
    )
    db_session.execute(
        text("UPDATE media SET kind = 'podcast_episode' WHERE id = :media_id"),
        {"media_id": episode_id},
    )
    add_media_to_library(db_session, library_id, video_id)
    add_media_to_library(db_session, library_id, episode_id)
    add_media_to_library(db_session, library_id, fragment_media_id)
    db_session.commit()

    for context_type, context_id, expected in (
        ("video", video_id, "Readable Video"),
        ("episode", episode_id, "Readable Episode"),
        ("fragment", fragment_id, "fragment evidence text"),
    ):
        result = hydrate_context_ref(
            db_session,
            viewer_id=bootstrapped_user,
            context_ref={"type": context_type, "id": str(context_id)},
        )

        assert result.resolved is True
        assert expected in result.evidence_text


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


def test_hydrate_content_chunk_context_ref_rejects_malformed_evidence_span_ids(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = create_searchable_media(db_session, bootstrapped_user, title="Malformed Span")
    chunk_id = db_session.execute(
        text(
            """
            SELECT id
            FROM content_chunks
            WHERE media_id = :media_id
            ORDER BY chunk_idx ASC
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).scalar_one()

    result = hydrate_context_ref(
        db_session,
        viewer_id=bootstrapped_user,
        context_ref={
            "type": "content_chunk",
            "id": str(chunk_id),
            "evidence_span_ids": ["not-a-uuid"],
        },
    )

    assert result.resolved is False
    assert result.failure is not None
    assert result.failure.code == "invalid"

    scalar_result = hydrate_context_ref(
        db_session,
        viewer_id=bootstrapped_user,
        context_ref={
            "type": "content_chunk",
            "id": str(chunk_id),
            "evidence_span_ids": "not-an-array",
        },
    )

    assert scalar_result.resolved is False
    assert scalar_result.failure is not None
    assert scalar_result.failure.code == "invalid"


def test_hydrate_message_retrieval_preserves_citation_and_evidence_span_id(
    db_session: Session,
    bootstrapped_user: UUID,
):
    media_id = create_searchable_media(db_session, bootstrapped_user, title="Retrieved Source")
    chunk_id, evidence_span_id, source_version, locator = db_session.execute(
        text(
            """
            SELECT cc.id, es.id, cir.source_version, cc.summary_locator
            FROM content_chunks cc
            JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
            JOIN content_index_runs cir ON cir.id = cc.index_run_id
            WHERE cc.media_id = :media_id
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).one()
    locator = {
        "type": "web_text_offsets",
        "media_id": str(media_id),
        "fragment_id": str(locator["fragment_id"]),
        "start_offset": int(locator["start_offset"]),
        "end_offset": int(locator["end_offset"]),
        "media_kind": "web_article",
    }
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
                retrieval_status,
                locator,
                source_version
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
                    'type', 'content_chunk',
                    'id', CAST(:source_id AS text),
                    'result_type', 'content_chunk',
                    'source_id', CAST(:source_id AS text),
                    'source_kind', 'web_article',
                    'title', 'Retrieved Source',
                    'source_label', 'Retrieved Source',
                    'evidence_span_id', CAST(:evidence_span_id_text AS text),
                    'snippet', 'retrieved snippet',
                    'deep_link', '/media/test',
                    'citation_label', 'Retrieved Source',
                    'context_ref', jsonb_build_object(
                        'type', 'content_chunk',
                        'id', CAST(:source_id AS text)
                    ),
                    'source_version', CAST(:source_version AS text),
                    'locator', CAST(:locator AS jsonb),
                    'media_id', CAST(:media_id AS text),
                    'media_kind', 'web_article',
                    'score', 1.0,
                    'selected', true
                ),
                '/media/test',
                1.0,
                true,
                'Retrieved Source',
                'retrieved snippet',
                'selected',
                CAST(:locator AS jsonb),
                  CAST(:source_version AS text)
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
            "locator": json.dumps(locator),
            "source_version": source_version,
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
    old_chunk_id, old_run_id, source_version, locator = db_session.execute(
        text(
            """
            SELECT cc.id, cc.index_run_id, cir.source_version, cc.summary_locator
            FROM content_chunks cc
            JOIN content_index_runs cir ON cir.id = cc.index_run_id
            WHERE cc.media_id = :media_id
            ORDER BY cc.chunk_idx ASC
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).one()
    locator = {
        "type": "web_text_offsets",
        "media_id": str(media_id),
        "fragment_id": str(locator["fragment_id"]),
        "start_offset": int(locator["start_offset"]),
        "end_offset": int(locator["end_offset"]),
        "media_kind": "web_article",
    }
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
                retrieval_status,
                locator,
                source_version
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
                    'type', 'content_chunk',
                    'id', CAST(:source_id AS text),
                    'result_type', 'content_chunk',
                    'source_id', CAST(:source_id AS text),
                    'source_kind', 'web_article',
                    'title', 'Replay Source',
                    'source_label', 'Replay Source',
                    'evidence_span_id', CAST(:evidence_span_id_text AS text),
                    'snippet', 'stale replay snippet',
                    'deep_link', '/media/test',
                    'citation_label', 'Replay Source',
                    'context_ref', jsonb_build_object(
                        'type', 'content_chunk',
                        'id', CAST(:source_id AS text)
                    ),
                    'source_version', CAST(:source_version AS text),
                    'locator', CAST(:locator AS jsonb),
                    'media_id', CAST(:media_id AS text),
                    'media_kind', 'web_article',
                    'score', 1.0,
                    'selected', true
                ),
                '/media/test',
                1.0,
                true,
                'Replay Source',
                'stale replay snippet',
                'selected',
                CAST(:locator AS jsonb),
                  CAST(:source_version AS text)
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
            "locator": json.dumps(locator),
            "source_version": source_version,
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
                "type": "web_result",
                "id": "web_1",
                "result_type": "web_result",
                "result_ref": "web_1",
                "source_id": "https://platform.openai.com/docs",
                "title": "OpenAI Docs",
                "url": "https://platform.openai.com/docs",
                "deep_link": "https://platform.openai.com/docs",
                "snippet": "Documentation snippet",
                "source_version": "web:https://platform.openai.com/docs",
                "locator": {
                    "type": "external_url",
                    "url": "https://platform.openai.com/docs",
                    "title": "OpenAI Docs",
                },
                "context_ref": {"type": "web_result", "id": "web_1"},
            },
        },
    )

    assert result.resolved is True
    assert "<title>OpenAI Docs</title>" in result.evidence_text
    assert result.citations[0]["url"] == "https://platform.openai.com/docs"


def test_hydrate_web_result_source_ref_rejects_untyped_result_ref(
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

    assert result.resolved is False
    assert result.failure is not None
    assert result.failure.code == "invalid"
