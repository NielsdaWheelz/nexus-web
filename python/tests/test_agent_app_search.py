"""Agent app-search tool tests."""

import hashlib
from uuid import uuid4

import pytest
from sqlalchemy import text

from nexus.services.agent_tools.app_search import (
    AppSearchCitation,
    execute_app_search,
    render_retrieved_context_blocks,
)
from nexus.services.context_lookup import hydrate_source_ref
from nexus.services.contributor_credits import replace_media_contributor_credits
from tests.factories import (
    create_searchable_media_in_library,
    create_test_conversation,
    create_test_library,
    create_test_message,
)
from tests.helpers import create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_execute_app_search_persists_retrieval_metadata(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Agent Search Test Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="App Search Needle",
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
        )
        media_id = create_searchable_media_in_library(
            session,
            user_id,
            library_id,
            title="App Search Needle",
        )

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            content="App Search Needle",
            has_user_context=False,
            scope="all",
            history=[],
            scope_metadata={"type": "general"},
        )

        assert run is not None
        assert run.tool_call_id is not None
        assert run.status == "complete"
        assert any(citation.source_id == str(media_id) for citation in run.citations)
        assert run.context_text

        tool_row = session.execute(
            text(
                """
                SELECT query_hash, result_refs, selected_context_refs
                FROM message_tool_calls
                WHERE id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert tool_row[0]
        assert tool_row[0] != "App Search Needle"
        assert any(ref["type"] == "media" for ref in tool_row[1])
        assert {"type": "media", "id": str(media_id)} in tool_row[2]

        retrieval_rows = session.execute(
            text(
                """
                SELECT exact_snippet, retrieval_status, included_in_prompt
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND scope = 'all'
                ORDER BY ordinal ASC
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).fetchall()
        assert retrieval_rows
        assert any(row[0] for row in retrieval_rows)
        assert any(row[1] == "selected" for row in retrieval_rows)
        assert all(row[2] is False for row in retrieval_rows)

    direct_db.register_cleanup("conversation_media", "conversation_id", conversation_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_execute_app_search_persists_normalized_executed_filters(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    credited_name = f"Mixed Case Filter Contributor {uuid4()}"
    source = f"app-search-filter-{uuid4()}"

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Agent Filter Search Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="Find mixed filters",
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
        )
        media_id = create_searchable_media_in_library(
            session,
            user_id,
            library_id,
            title="Mixed Filter Needle",
        )
        replace_media_contributor_credits(
            session,
            media_id=media_id,
            credits=[{"name": credited_name, "role": "HOST", "source": source}],
        )
        contributor_handle = session.execute(
            text(
                """
                SELECT c.handle
                FROM contributor_credits cc
                JOIN contributors c ON c.id = cc.contributor_id
                WHERE cc.media_id = :media_id
                """
            ),
            {"media_id": media_id},
        ).scalar_one()

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            content="Find mixed filters",
            has_user_context=False,
            scope="all",
            history=[],
            scope_metadata={"type": "general"},
            planned_query="Mixed Filter Needle",
            planned_types=["media"],
            planned_filters={
                "contributor_handles": [contributor_handle.upper()],
                "roles": ["HOST"],
                "content_kinds": ["WEB_ARTICLE"],
            },
            force=True,
        )

        assert run is not None
        assert run.status == "complete"
        assert run.filters == {
            "contributor_handles": [contributor_handle],
            "roles": ["host"],
            "content_kinds": ["web_article"],
        }
        assert any(citation.source_id == str(media_id) for citation in run.citations)

        result_ref = session.execute(
            text(
                """
                SELECT result_refs
                FROM message_tool_calls
                WHERE id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).scalar_one()
        retrieval_ref = session.execute(
            text(
                """
                SELECT result_ref
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                ORDER BY ordinal ASC
                LIMIT 1
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).scalar_one()

        assert result_ref[0]["filters"] == run.filters
        assert retrieval_ref["filters"] == run.filters

    direct_db.register_cleanup("contributors", "display_name", credited_name)
    direct_db.register_cleanup("contributor_aliases", "source", source)
    direct_db.register_cleanup("conversation_media", "conversation_id", conversation_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_execute_app_search_keeps_content_evidence_when_semantic_embedding_fails(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = create_test_user_id()

    def fail_embedding(_text: str) -> tuple[str, list[float]]:
        raise RuntimeError("test embedding failure")

    monkeypatch.setattr("nexus.services.search.build_text_embedding", fail_embedding)

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Agent Content Search Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="Find lexical fallback needle",
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
        )
        media_id = create_searchable_media_in_library(
            session,
            user_id,
            library_id,
            title="Lexical Fallback Needle",
        )

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            content="Find lexical fallback needle",
            has_user_context=False,
            scope="all",
            history=[],
            scope_metadata={"type": "general"},
            planned_query="lexical fallback needle",
            planned_types=["content_chunk"],
            force=True,
        )

        assert run is not None
        assert run.status == "complete"
        assert any(
            citation.result_type == "content_chunk" and citation.media_id == str(media_id)
            for citation in run.citations
        )
        assert "lexical fallback needle" in run.context_text.lower()

    direct_db.register_cleanup("conversation_media", "conversation_id", conversation_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_scoped_app_search_persists_no_indexed_evidence_status(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Empty Scoped Search Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="Find indexed evidence",
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
        )

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            content="Find indexed evidence",
            has_user_context=False,
            scope=f"library:{library_id}",
            history=[],
            scope_metadata={"type": "library", "id": str(library_id)},
            planned_query="indexed evidence",
            planned_types=["content_chunk"],
            force=True,
        )

        assert run is not None
        assert run.tool_call_id is not None
        assert run.citations == []
        assert 'status="no_indexed_evidence"' in run.context_text

        retrieval_id = session.execute(
            text(
                """
                SELECT id
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND selected = true
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).scalar_one()
        hydrated = hydrate_source_ref(
            session,
            viewer_id=user_id,
            source_ref={"type": "message_retrieval", "retrieval_id": str(retrieval_id)},
        )

        assert hydrated.resolved, hydrated.failure
        assert 'status="no_indexed_evidence"' in hydrated.evidence_text

    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_scoped_app_search_persists_no_results_when_indexed_evidence_has_no_hits(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = create_test_user_id()

    def fail_embedding(_text: str) -> tuple[str, list[float]]:
        raise RuntimeError("test embedding failure")

    monkeypatch.setattr("nexus.services.search.build_text_embedding", fail_embedding)

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Indexed Scoped Search Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="Find absent scoped evidence",
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
        )
        media_id = create_searchable_media_in_library(
            session,
            user_id,
            library_id,
            title="Indexed Evidence Present",
        )

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            content="Find absent scoped evidence",
            has_user_context=False,
            scope=f"library:{library_id}",
            history=[],
            scope_metadata={"type": "library", "id": str(library_id)},
            planned_query="termthatdoesnotexist",
            planned_types=["content_chunk"],
            force=True,
        )

        assert run is not None
        assert run.tool_call_id is not None
        assert run.citations == []
        assert 'status="no_results"' in run.context_text
        assert 'status="no_indexed_evidence"' not in run.context_text

        result_ref = session.execute(
            text(
                """
                SELECT result_ref
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND selected = true
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).scalar_one()
        assert result_ref["status"] == "no_results"

    direct_db.register_cleanup("conversation_media", "conversation_id", conversation_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_render_retrieved_context_requires_matching_index_run(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Agent Search Index Run Library")
        media_id = create_searchable_media_in_library(
            session,
            user_id,
            library_id,
            title="Index Run Guard Needle",
        )
        row = session.execute(
            text(
                """
                SELECT cc.id,
                       cc.media_id,
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
        other_run_id = uuid4()
        session.execute(
            text(
                """
                INSERT INTO content_index_runs (
                    id,
                    media_id,
                    state,
                    source_version,
                    extractor_version,
                    chunker_version,
                    embedding_provider,
                    embedding_model,
                    embedding_version,
                    embedding_config_hash,
                    started_at
                )
                VALUES (
                    :id,
                    :media_id,
                    'ready',
                    'test-source',
                    'test-extractor',
                    'test-chunker',
                    'test-provider',
                    'test-model',
                    'test-version',
                    'test-config',
                    now()
                )
                """
            ),
            {"id": other_run_id, "media_id": media_id},
        )
        span_text = "wrong index run evidence"
        mismatch_span_id = session.execute(
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
                    :source_snapshot_id,
                    :block_id,
                    :block_id,
                    0,
                    10,
                    :span_text,
                    :span_sha,
                    '{}'::jsonb,
                    'Wrong Run',
                    'web'
                )
                RETURNING id
                """
            ),
            {
                "media_id": media_id,
                "index_run_id": other_run_id,
                "source_snapshot_id": row[2],
                "block_id": row[3],
                "span_text": span_text,
                "span_sha": hashlib.sha256(span_text.encode("utf-8")).hexdigest(),
            },
        ).scalar_one()
        citation = AppSearchCitation(
            result_type="content_chunk",
            source_id=str(row[0]),
            title="Index Run Guard Needle",
            source_label=None,
            snippet=span_text,
            deep_link="/media/test",
            citation_label="Wrong Run",
            resolver=None,
            context_ref={
                "type": "content_chunk",
                "id": str(row[0]),
                "evidence_span_ids": [str(mismatch_span_id)],
            },
            evidence_span_id=str(mismatch_span_id),
            media_id=str(media_id),
            media_kind="web_article",
            score=1.0,
        )

        context_text, context_chars, selected = render_retrieved_context_blocks(
            session,
            viewer_id=user_id,
            citations=[citation],
        )

        assert context_text == ""
        assert context_chars == 0
        assert selected == []

    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)
