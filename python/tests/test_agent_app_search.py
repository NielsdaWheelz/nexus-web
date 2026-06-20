"""Agent app-search tool tests."""

from collections import Counter
from uuid import uuid4

import pytest
import respx
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.errors import ApiErrorCode
from nexus.schemas.search import SearchResponse
from nexus.services import media_intelligence
from nexus.services.agent_tools.app_search import (
    APP_SEARCH_CONTEXT_CHARS,
    APP_SEARCH_SELECTED_LIMIT,
    AppSearchRun,
    execute_app_search,
    persist_app_search_run,
    render_retrieved_context_blocks,
)
from nexus.services.note_indexing import rebuild_note_content_index
from nexus.services.retrieval_citation import RetrievalCitation
from nexus.services.search.policy import (
    APP_SEARCH_DEEP_CANDIDATE_LIMIT,
    APP_SEARCH_SCOPED_CANDIDATE_LIMIT,
)
from nexus.services.search.query import SearchQuery
from nexus.services.search.selection import (
    APP_SEARCH_SELECTION_STRATEGY,
    APP_SEARCH_SELECTION_VERSION,
)
from tests.factories import (
    add_context_edge,
    create_searchable_media_in_library,
    create_test_conversation,
    create_test_highlight_note,
    create_test_library,
    create_test_message,
)
from tests.helpers import create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings"


def _use_openai_embedding_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NEXUS_ENV", "local")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-openai")
    monkeypatch.setenv("ENABLE_OPENAI", "true")
    clear_settings_cache()


def _media_citation(source_id: str | None = None) -> RetrievalCitation:
    source_id = source_id or str(uuid4())
    return RetrievalCitation(
        result_type="media",
        source_id=source_id,
        title=f"Media {source_id}",
        source_label=None,
        snippet=f"Snippet {source_id}",
        deep_link=f"/reader/{source_id}",
        citation_target=f"media:{source_id}",
        citation_label=None,
        locator=None,
        context_ref={"type": "media", "id": source_id},
        evidence_span_id=None,
        media_id=source_id,
        media_kind=None,
        score=1.0,
    )


def _page_citation(page_id) -> RetrievalCitation:
    source_id = str(page_id)
    return RetrievalCitation(
        result_type="page",
        source_id=source_id,
        title=f"Page {source_id}",
        source_label=None,
        snippet=f"Snippet {source_id}",
        deep_link=f"/pages/{source_id}",
        citation_target=f"page:{source_id}",
        citation_label=None,
        locator=None,
        context_ref={"type": "page", "id": source_id},
        evidence_span_id=None,
        media_id=None,
        media_kind=None,
        score=1.0,
    )


def _note_block_citation(note_block_id) -> RetrievalCitation:
    source_id = str(note_block_id)
    return RetrievalCitation(
        result_type="note_block",
        source_id=source_id,
        title=f"Note {source_id}",
        source_label=None,
        snippet=f"Snippet {source_id}",
        deep_link=f"/notes/{source_id}",
        citation_target=f"note_block:{source_id}",
        citation_label=None,
        locator=None,
        context_ref={"type": "note_block", "id": source_id},
        evidence_span_id=None,
        media_id=None,
        media_kind=None,
        score=1.0,
    )


def _create_page(session: Session, user_id, title: str = "Packer page"):
    page_id = uuid4()
    session.execute(
        text("INSERT INTO pages (id, user_id, title) VALUES (:id, :user_id, :title)"),
        {"id": page_id, "user_id": user_id, "title": title},
    )
    return page_id


def _create_note_block(session: Session, user_id, body_text: str):
    note_block_id = uuid4()
    session.execute(
        text(
            """
            INSERT INTO note_blocks (id, user_id, body_pm_json, body_text)
            VALUES (:id, :user_id, '{}'::jsonb, :body_text)
            """
        ),
        {"id": note_block_id, "user_id": user_id, "body_text": body_text},
    )
    return note_block_id


def _create_media_with_ready_summary(
    session: Session,
    user_id,
    library_id,
    *,
    title: str,
    summary_md: str,
):
    media_id = create_searchable_media_in_library(session, user_id, library_id, title=title)
    ref = media_intelligence.ensure_media_unit(session, media_id=media_id)
    session.execute(
        text(
            """
            UPDATE media_summaries
            SET status = 'ready', summary_md = :summary_md, model_name = 'test'
            WHERE id = :summary_id
            """
        ),
        {"summary_id": ref.summary_id, "summary_md": summary_md},
    )
    return media_id


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
            scopes=[],
            query="App Search Needle",
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
                SELECT id,
                       exact_snippet,
                       retrieval_status,
                       included_in_prompt,
                       locator,
                       result_ref,
                       selected
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND scope = 'all'
                ORDER BY ordinal ASC
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).fetchall()
        assert retrieval_rows
        assert any(row[1] for row in retrieval_rows)
        assert any(row[2] == "selected" for row in retrieval_rows)
        assert any(row[3] is True for row in retrieval_rows)
        assert all(row[3] == row[6] for row in retrieval_rows)
        assert any(row[4] for row in retrieval_rows)
        assert all("resolver" not in row[5] for row in retrieval_rows)

        content_chunk_row = session.execute(
            text(
                """
                SELECT locator, result_ref
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND result_type = 'content_chunk'
                LIMIT 1
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert content_chunk_row[0]["type"] == "web_text_offsets"
        assert "resolver" not in content_chunk_row[1]

        ledger_row = session.execute(
            text(
                """
                SELECT COUNT(*),
                       COUNT(*) FILTER (WHERE selected),
                       bool_and(result_ref ? 'type'),
                       bool_and(included_in_prompt = selected),
                       array_agg(DISTINCT selection_reason ORDER BY selection_reason)
                FROM message_retrieval_candidate_ledgers
                WHERE tool_call_id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert ledger_row[0] == len(retrieval_rows)
        assert ledger_row[1] == len(run.selected_citations)
        assert ledger_row[2] is True
        assert ledger_row[3] is True
        assert "selected_within_budget" in ledger_row[4]

        rerank_row = session.execute(
            text(
                """
                SELECT strategy,
                       input_count,
                       selected_count,
                       budget_chars,
                       selected_chars,
                       status,
                       metadata
                FROM message_rerank_ledgers
                WHERE tool_call_id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert rerank_row[0] == APP_SEARCH_SELECTION_STRATEGY
        assert rerank_row[1] == len(run.citations)
        assert rerank_row[2] == len(run.selected_citations)
        assert rerank_row[3] > 0
        assert rerank_row[4] == run.context_chars
        assert rerank_row[5] == run.status
        metadata = dict(rerank_row[6])
        assert metadata["selection_strategy"] == APP_SEARCH_SELECTION_STRATEGY
        assert metadata["selection_policy_version"] == APP_SEARCH_SELECTION_VERSION
        assert metadata["candidate_rerank_trace"]
        assert len(metadata["candidate_rerank_trace"]) == len(run.citations)
        assert [item["selection_reason"] for item in metadata["candidate_rerank_trace"]] == (
            run.selection_reasons
        )
        assert [item["selected"] for item in metadata["candidate_rerank_trace"]] == [
            citation in run.selected_citations for citation in run.citations
        ]
        assert {
            key: value for key, value in metadata.items() if key != "candidate_rerank_trace"
        } == {
            "selection_strategy": APP_SEARCH_SELECTION_STRATEGY,
            "selection_policy_version": APP_SEARCH_SELECTION_VERSION,
            "ordering_policy": "hybrid_score_exactness_citation_quality_diversity",
            "diversity_policy": "source_section_penalty",
            "budget_policy": "greedy_context_budget",
            "candidate_limit": APP_SEARCH_DEEP_CANDIDATE_LIMIT,
            "selected_limit": APP_SEARCH_SELECTED_LIMIT,
            "context_budget_chars": APP_SEARCH_CONTEXT_CHARS,
            "scope_count": 0,
            "result_type_mix": dict(Counter(citation.result_type for citation in run.citations)),
            "query_class": "exact_lookup",
            "retrieval_mode": "deep",
            "policy_reason": "global_scope",
            "scope": "all",
            "resolved_scopes": [],
            "inclusion_surface": "tool_output",
            "selection_reason_counts": dict(Counter(run.selection_reasons)),
        }

    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_persist_app_search_run_records_packer_decisions(
    db_session: Session,
    bootstrapped_user,
) -> None:
    library_id = create_test_library(db_session, bootstrapped_user, "Packer Ledger Library")
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=1,
        role="user",
        content="Find evidence",
    )
    assistant_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=2,
        role="assistant",
        content="",
        status="pending",
    )
    skipped_over_budget = _media_citation(
        str(
            _create_media_with_ready_summary(
                db_session,
                bootstrapped_user,
                library_id,
                title="Oversized packer media",
                summary_md="x" * APP_SEARCH_CONTEXT_CHARS,
            )
        )
    )
    skipped_empty = _page_citation(uuid4())
    fitting = _page_citation(_create_page(db_session, bootstrapped_user, "Fitting packer page"))
    skipped_over_budget.selected = True
    skipped_empty.selected = True

    context_text, context_chars, selected, selection_reasons = render_retrieved_context_blocks(
        db_session,
        viewer_id=bootstrapped_user,
        citations=[skipped_over_budget, skipped_empty, fitting],
    )
    assert context_text
    assert context_chars == len(context_text)
    assert selected == [fitting]
    assert selection_reasons == [
        "skipped_over_budget",
        "skipped_empty_render",
        "selected_within_budget",
    ]

    run = AppSearchRun(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        query_hash="synthetic",
        scope="all",
        resolved_scopes=[],
        requested_types=["media", "page"],
        candidate_limit=APP_SEARCH_DEEP_CANDIDATE_LIMIT,
        scope_count=0,
        query_class="exact_lookup",
        retrieval_mode="deep",
        policy_reason="global_scope",
        citations=[skipped_over_budget, skipped_empty, fitting],
        selected_citations=selected,
        selection_reasons=selection_reasons,
        context_text=context_text,
        context_chars=context_chars,
        latency_ms=1,
        status="complete",
    )

    persist_app_search_run(db_session, run)
    persist_app_search_run(db_session, run)

    rows = db_session.execute(
        text(
            """
            SELECT mr.selected,
                   mr.included_in_prompt,
                   mr.retrieval_status,
                   mcl.selected,
                   mcl.included_in_prompt,
                   mcl.selection_status,
                   mcl.selection_reason
            FROM message_retrievals mr
            JOIN message_retrieval_candidate_ledgers mcl ON mcl.retrieval_id = mr.id
            WHERE mr.tool_call_id = :tool_call_id
            ORDER BY mr.ordinal
            """
        ),
        {"tool_call_id": run.tool_call_id},
    ).fetchall()
    assert [tuple(row[:7]) for row in rows] == [
        (
            False,
            False,
            "excluded_by_budget",
            False,
            False,
            "excluded_by_budget",
            "skipped_over_budget",
        ),
        (
            False,
            False,
            "retrieved",
            False,
            False,
            "retrieved",
            "skipped_empty_render",
        ),
        (
            True,
            True,
            "selected",
            True,
            True,
            "selected",
            "selected_within_budget",
        ),
    ]

    rerank = db_session.execute(
        text(
            """
            SELECT strategy, metadata
            FROM message_rerank_ledgers
            WHERE tool_call_id = :tool_call_id
            """
        ),
        {"tool_call_id": run.tool_call_id},
    ).one()
    assert rerank[0] == APP_SEARCH_SELECTION_STRATEGY
    metadata = dict(rerank[1])
    assert [item["selection_reason"] for item in metadata["candidate_rerank_trace"]] == [
        "skipped_over_budget",
        "skipped_empty_render",
        "selected_within_budget",
    ]
    assert [item["selection_status"] for item in metadata["candidate_rerank_trace"]] == [
        "excluded_by_budget",
        "retrieved",
        "selected",
    ]
    assert [item["selected"] for item in metadata["candidate_rerank_trace"]] == [
        False,
        False,
        True,
    ]
    assert {key: value for key, value in metadata.items() if key != "candidate_rerank_trace"} == {
        "selection_strategy": APP_SEARCH_SELECTION_STRATEGY,
        "selection_policy_version": APP_SEARCH_SELECTION_VERSION,
        "ordering_policy": "hybrid_score_exactness_citation_quality_diversity",
        "diversity_policy": "source_section_penalty",
        "budget_policy": "greedy_context_budget",
        "candidate_limit": APP_SEARCH_DEEP_CANDIDATE_LIMIT,
        "selected_limit": APP_SEARCH_SELECTED_LIMIT,
        "context_budget_chars": APP_SEARCH_CONTEXT_CHARS,
        "scope_count": 0,
        "result_type_mix": {"media": 1, "page": 2},
        "query_class": "exact_lookup",
        "retrieval_mode": "deep",
        "policy_reason": "global_scope",
        "scope": "all",
        "resolved_scopes": [],
        "inclusion_surface": "tool_output",
        "selection_reason_counts": {
            "selected_within_budget": 1,
            "skipped_empty_render": 1,
            "skipped_over_budget": 1,
        },
    }
    counts = db_session.execute(
        text(
            """
            SELECT
                (SELECT count(*) FROM message_retrieval_candidate_ledgers WHERE tool_call_id = :id),
                (SELECT count(*) FROM message_rerank_ledgers WHERE tool_call_id = :id)
            """
        ),
        {"id": run.tool_call_id},
    ).one()
    assert tuple(counts) == (3, 1)


def test_execute_app_search_prioritizes_prompt_evidence_over_container_rows(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    needle = f"Prompt Evidence Needle {uuid4().hex}"

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Prompt Evidence Search Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content=needle,
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
            title=needle,
        )

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=[],
            query=needle,
        )

        assert run.status == "complete"
        assert {citation.result_type for citation in run.citations} >= {
            "media",
            "content_chunk",
        }
        assert run.selected_citations
        assert run.selected_citations[0].result_type in {
            "content_chunk",
            "evidence_span",
            "fragment",
            "highlight",
            "note_block",
            "reader_apparatus_item",
            "message",
        }
        assert run.selected_citations[0].deep_link != f"/media/{media_id}"

        retrieval_rows = session.execute(
            text(
                """
                SELECT result_type, result_ref, selected, deep_link
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                ORDER BY ordinal ASC
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).fetchall()
        assert retrieval_rows[0][0] == run.selected_citations[0].result_type
        assert retrieval_rows[0][1]["citation_target"]
        assert retrieval_rows[0][2] is True
        assert retrieval_rows[0][3] == run.selected_citations[0].deep_link
        assert any(row[0] == "media" for row in retrieval_rows)

    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_execute_app_search_rejects_blank_explicit_scope(
    db_session: Session,
    bootstrapped_user,
) -> None:
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=1,
        role="user",
        content="Find something",
    )
    assistant_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=2,
        role="assistant",
        content="",
        status="pending",
    )

    run = execute_app_search(
        db_session,
        viewer_id=bootstrapped_user,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        scopes=["  "],
        query="Find something",
    )

    assert run.status == "error"
    assert run.error_code == ApiErrorCode.E_INVALID_REQUEST.value
    assert "non-empty URI strings" in run.context_text
    assert run.citations == []


def test_execute_app_search_builds_public_filter_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    viewer_id = uuid4()
    conversation_id = uuid4()
    captured: dict[str, SearchQuery] = {}

    def fake_search(db: Session, viewer_id, query: SearchQuery) -> SearchResponse:
        captured["query"] = query
        return SearchResponse()

    monkeypatch.setattr(
        "nexus.services.agent_tools.app_search._resolve_scope_uris",
        lambda *args, **kwargs: [],
    )
    monkeypatch.setattr(
        "nexus.services.agent_tools.app_search.persist_app_search_run",
        lambda db, run: None,
    )
    monkeypatch.setattr("nexus.services.agent_tools.app_search.search", fake_search)

    run = execute_app_search(
        object(),
        viewer_id=viewer_id,
        conversation_id=conversation_id,
        user_message_id=uuid4(),
        assistant_message_id=uuid4(),
        scopes=[],
        query="attention",
        kinds=["documents"],
        formats=["pdf"],
        authors=["le-guin"],
        roles=["author"],
    )

    assert run.status == "complete"
    assert run.filters == {
        "kinds": ["documents"],
        "formats": ["pdf"],
        "authors": ["le-guin"],
        "roles": ["author"],
    }
    assert captured["query"].text == "attention"
    assert captured["query"].requested_kinds == frozenset({"documents"})
    assert captured["query"].formats == ("pdf",)
    assert captured["query"].authors == ("le-guin",)
    assert captured["query"].roles == ("author",)
    assert captured["query"].limit == APP_SEARCH_DEEP_CANDIDATE_LIMIT
    assert run.candidate_limit == APP_SEARCH_DEEP_CANDIDATE_LIMIT
    assert run.retrieval_mode == "deep"


def test_render_retrieved_context_blocks_renders_web_result(
    db_session: Session,
    bootstrapped_user,
) -> None:
    citation = RetrievalCitation(
        result_type="web_result",
        source_id="external-1",
        title="Search result",
        source_label="Example",
        snippet="Open web evidence",
        deep_link="https://example.com/research",
        citation_target="external_snapshot:external-1",
        citation_label=None,
        locator={
            "type": "external_url",
            "url": "https://example.com/research",
            "title": "Search result",
            "display_url": "example.com/research",
        },
        context_ref={"type": "web_result", "id": "external-1"},
        evidence_span_id=None,
        media_id=None,
        media_kind=None,
        score=1.0,
        result_ref={
            "type": "web_result",
            "id": "external-1",
            "result_type": "web_result",
            "result_ref": "provider:1",
            "source_id": "external-1",
            "title": "Search result",
            "url": "https://example.com/research",
            "display_url": "example.com/research",
            "deep_link": "https://example.com/research",
            "citation_target": "external_snapshot:external-1",
            "locator": {
                "type": "external_url",
                "url": "https://example.com/research",
                "title": "Search result",
                "display_url": "example.com/research",
            },
            "snippet": "Open web evidence",
            "extra_snippets": ["More web evidence"],
            "published_at": "2026-06-19T00:00:00Z",
            "source_name": "Example",
            "rank": 1,
            "provider": "test",
            "provider_request_id": "request-1",
            "context_ref": {"type": "web_result", "id": "external-1"},
            "media_id": None,
            "media_kind": None,
            "score": 1.0,
            "selected": False,
        },
    )

    context_text, context_chars, selected, selection_reasons = render_retrieved_context_blocks(
        db_session,
        viewer_id=bootstrapped_user,
        citations=[citation],
    )

    assert '<app_search_result type="web_result">' in context_text
    assert "<url>https://example.com/research</url>" in context_text
    assert "<excerpt>Open web evidence</excerpt>" in context_text
    assert "<excerpt>More web evidence</excerpt>" in context_text
    assert context_chars == len(context_text)
    assert selected == [citation]
    assert selection_reasons == ["selected_within_budget"]


def test_execute_app_search_uses_moderate_candidate_depth_for_single_media_scope(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    needle = f"Scoped Candidate Policy {uuid4().hex}"

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Scoped Candidate Policy Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content=needle,
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
            title=needle,
        )
        add_context_edge(session, conversation_id, f"media:{media_id}")

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=[f"media:{media_id}"],
            query=needle,
        )

        assert run.status == "complete"
        assert run.candidate_limit == APP_SEARCH_SCOPED_CANDIDATE_LIMIT
        assert len(run.selected_citations) <= APP_SEARCH_SELECTED_LIMIT
        assert run.scope_count == 1
        assert run.query_class == "scoped_passage_lookup"
        assert run.retrieval_mode == "fast"
        assert run.policy_reason == "single_narrow_scope"

        metadata = session.execute(
            text(
                """
                SELECT metadata
                FROM message_rerank_ledgers
                WHERE tool_call_id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).scalar_one()
        assert metadata["candidate_limit"] == APP_SEARCH_SCOPED_CANDIDATE_LIMIT
        assert metadata["selected_limit"] == APP_SEARCH_SELECTED_LIMIT
        assert metadata["query_class"] == "scoped_passage_lookup"
        assert metadata["policy_reason"] == "single_narrow_scope"
        assert metadata["resolved_scopes"] == [f"media:{media_id}"]

    direct_db.register_cleanup("resource_edges", "source_id", conversation_id)
    direct_db.register_cleanup("resource_edges", "target_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_execute_app_search_persists_bounded_label_for_long_multi_scope(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    needle = f"Multi Scope Candidate Policy {uuid4().hex}"

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Multi Scope Candidate Policy Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content=needle,
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
        )
        media_ids = [
            create_searchable_media_in_library(
                session,
                user_id,
                library_id,
                title=needle if index == 0 else f"Multi Scope Filler {index} {uuid4().hex}",
            )
            for index in range(6)
        ]
        for media_id in media_ids:
            add_context_edge(session, conversation_id, f"media:{media_id}")
        resolved_scopes = [f"media:{media_id}" for media_id in media_ids]

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=resolved_scopes,
            query=needle,
        )

        assert run.status == "complete"
        assert run.scope == "multi_scope:6"
        assert run.resolved_scopes == resolved_scopes
        assert run.candidate_limit == APP_SEARCH_DEEP_CANDIDATE_LIMIT
        assert run.retrieval_mode == "deep"
        assert run.policy_reason == "multiple_scopes"

        tool_scope, metadata = session.execute(
            text(
                """
                SELECT mtc.scope, mrl.metadata
                FROM message_tool_calls mtc
                JOIN message_rerank_ledgers mrl ON mrl.tool_call_id = mtc.id
                WHERE mtc.id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert tool_scope == "multi_scope:6"
        assert metadata["scope"] == "multi_scope:6"
        assert metadata["resolved_scopes"] == resolved_scopes
        assert metadata["candidate_limit"] == APP_SEARCH_DEEP_CANDIDATE_LIMIT

    direct_db.register_cleanup("resource_edges", "source_id", conversation_id)
    for media_id in media_ids:
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_execute_app_search_error_preserves_resolved_candidate_policy(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Scoped Error Policy Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="Find scoped evidence",
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
            title="Scoped Error Policy Needle",
        )
        add_context_edge(session, conversation_id, f"media:{media_id}")

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=[f"media:{media_id}"],
            query="Scoped Error Policy Needle",
            kinds=["not-a-kind"],
        )

        assert run.status == "error"
        assert run.scope == f"media:{media_id}"
        assert run.candidate_limit == APP_SEARCH_SCOPED_CANDIDATE_LIMIT
        assert run.scope_count == 1
        assert run.retrieval_mode == "fast"
        assert run.policy_reason == "single_narrow_scope"

        metadata = session.execute(
            text(
                """
                SELECT metadata
                FROM message_rerank_ledgers
                WHERE tool_call_id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).scalar_one()
        assert metadata["scope"] == f"media:{media_id}"
        assert metadata["candidate_limit"] == APP_SEARCH_SCOPED_CANDIDATE_LIMIT
        assert metadata["policy_reason"] == "single_narrow_scope"
        assert metadata["result_type_mix"] == {}
        assert metadata["resolved_scopes"] == [f"media:{media_id}"]
        selected_chars = session.execute(
            text(
                """
                SELECT selected_chars
                FROM message_rerank_ledgers
                WHERE tool_call_id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).scalar_one()
        assert selected_chars == 0

    direct_db.register_cleanup("resource_edges", "source_id", conversation_id)
    direct_db.register_cleanup("resource_edges", "target_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_execute_app_search_uses_deep_policy_for_default_conversation_scope(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()
    needle = f"Conversation Scope Policy {uuid4().hex}"

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Conversation Scope Policy Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content=needle,
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
            title="Conversation Scope Policy Anchor",
        )
        highlight_id, note_block_id = create_test_highlight_note(
            session,
            user_id,
            media_id,
            body=needle,
        )
        add_context_edge(session, conversation_id, f"highlight:{highlight_id}")

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=[],
            query=needle,
            kinds=["notes"],
        )

        assert run.status == "complete"
        assert run.scope == f"conversation:{conversation_id}"
        assert run.resolved_scopes == [f"conversation:{conversation_id}"]
        assert run.candidate_limit == APP_SEARCH_DEEP_CANDIDATE_LIMIT
        assert run.retrieval_mode == "deep"
        assert run.policy_reason == "conversation_scope"

    direct_db.register_cleanup("resource_edges", "source_id", conversation_id)
    direct_db.register_cleanup("resource_edges", "source_id", highlight_id)
    direct_db.register_cleanup("resource_edges", "target_id", note_block_id)
    direct_db.register_cleanup("note_blocks", "id", note_block_id)
    direct_db.register_cleanup("highlights", "id", highlight_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("pages", "user_id", user_id)


def test_li_revision_reference_dropped_from_default_scope_resolution(
    db_session: Session,
    bootstrapped_user,
) -> None:
    """The LI revision reference is NOT a search scope; the library: ref carries retrieval.

    With both a ``library_intelligence_revision:`` and a ``library:`` reference and
    no explicit scopes, default scope resolution keeps only the library URI.
    """
    from uuid import uuid4 as _uuid4

    from nexus.services.agent_tools.app_search import _resolve_scope_uris

    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = create_test_library(db_session, bootstrapped_user, "Scope Library")
    artifact_id = _uuid4()
    revision_id = _uuid4()
    db_session.execute(
        text(
            """
            INSERT INTO library_intelligence_artifacts (id, library_id, user_id)
            VALUES (:id, :library_id, :user_id)
            """
        ),
        {"id": artifact_id, "library_id": library_id, "user_id": bootstrapped_user},
    )
    db_session.execute(
        text(
            """
            INSERT INTO library_intelligence_artifact_revisions (
                id, artifact_id, content_md, covered_targets, status, promoted_at
            )
            VALUES (:id, :artifact_id, 'Synthesis', '[]'::jsonb, 'ready', now())
            """
        ),
        {"id": revision_id, "artifact_id": artifact_id},
    )
    db_session.execute(
        text(
            "UPDATE library_intelligence_artifacts "
            "SET current_revision_id = :revision_id WHERE id = :artifact_id"
        ),
        {"revision_id": revision_id, "artifact_id": artifact_id},
    )
    add_context_edge(db_session, conversation_id, f"library_intelligence_revision:{revision_id}")
    add_context_edge(db_session, conversation_id, f"library:{library_id}")
    db_session.commit()

    resolved = _resolve_scope_uris(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, scopes=[]
    )

    assert resolved == [f"library:{library_id}"], (
        f"Only the library scope should carry retrieval; got {resolved}"
    )


def test_default_scope_resolution_ignores_ordinal_citation_edges(
    db_session: Session,
    bootstrapped_user,
) -> None:
    from nexus.services.agent_tools.app_search import _resolve_scope_uris
    from nexus.services.resource_graph.citations import record_citation
    from nexus.services.resource_graph.refs import ResourceRef
    from nexus.services.resource_graph.schemas import CitationSnapshot

    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = create_test_library(db_session, bootstrapped_user, "Citation Scope Library")
    media_id = create_searchable_media_in_library(
        db_session, bootstrapped_user, library_id, title="Citation-only source"
    )
    record_citation(
        db_session,
        viewer_id=bootstrapped_user,
        source=ResourceRef(scheme="message", id=uuid4()),
        target=ResourceRef(scheme="media", id=media_id),
        ordinal=1,
        kind="context",
        snapshot=CitationSnapshot(title="Citation-only source"),
    )

    resolved = _resolve_scope_uris(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, scopes=[]
    )

    assert resolved == [], (
        f"Ordinal citation edges must not become app-search scopes; got {resolved}"
    )
    add_context_edge(db_session, conversation_id, f"media:{media_id}")

    resolved_after_context = _resolve_scope_uris(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, scopes=[]
    )
    assert resolved_after_context == [f"media:{media_id}"], (
        f"bare context refs should still define app-search scope; got {resolved_after_context}"
    )


def test_default_scope_resolution_ignores_synapse_and_non_context_edges(
    db_session: Session,
    bootstrapped_user,
) -> None:
    from nexus.services.agent_tools.app_search import InvalidScopeError, _resolve_scope_uris

    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = create_test_library(db_session, bootstrapped_user, "Graph Scope Library")
    synapse_media_id = create_searchable_media_in_library(
        db_session, bootstrapped_user, library_id, title="Synapse-only source"
    )
    supports_media_id = create_searchable_media_in_library(
        db_session, bootstrapped_user, library_id, title="Supports-only source"
    )
    db_session.execute(
        text(
            """
            INSERT INTO resource_edges (
                user_id, kind, origin, source_scheme, source_id, target_scheme, target_id,
                snapshot
            )
            VALUES
                (:user_id, 'context', 'synapse', 'media', :synapse_media_id,
                 'media', :supports_media_id, '{"excerpt":"test rationale"}'::jsonb),
                (:user_id, 'supports', 'user', 'conversation', :conversation_id,
                 'media', :supports_media_id, NULL)
            """
        ),
        {
            "user_id": bootstrapped_user,
            "conversation_id": conversation_id,
            "synapse_media_id": synapse_media_id,
            "supports_media_id": supports_media_id,
        },
    )
    db_session.commit()

    resolved = _resolve_scope_uris(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, scopes=[]
    )
    assert resolved == []

    for media_id in (synapse_media_id, supports_media_id):
        with pytest.raises(InvalidScopeError):
            _resolve_scope_uris(
                db_session,
                viewer_id=bootstrapped_user,
                conversation_id=conversation_id,
                scopes=[f"media:{media_id}"],
            )


def test_default_scope_resolution_uses_conversation_for_note_context(
    db_session: Session,
    bootstrapped_user,
) -> None:
    from nexus.services.agent_tools.app_search import _resolve_scope_uris

    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    page_id = uuid4()
    db_session.execute(
        text("INSERT INTO pages (id, user_id, title) VALUES (:id, :user_id, 'Scoped page')"),
        {"id": page_id, "user_id": bootstrapped_user},
    )
    add_context_edge(db_session, conversation_id, f"page:{page_id}")
    db_session.commit()

    resolved = _resolve_scope_uris(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, scopes=[]
    )

    assert resolved == [f"conversation:{conversation_id}"], (
        f"page/note-only context must not fall back to global search; got {resolved}"
    )


def test_default_scope_resolution_uses_conversation_for_highlight_context(
    db_session: Session,
    bootstrapped_user,
) -> None:
    from nexus.services.agent_tools.app_search import _resolve_scope_uris

    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    library_id = create_test_library(db_session, bootstrapped_user, "Highlight Scope Library")
    media_id = create_searchable_media_in_library(
        db_session, bootstrapped_user, library_id, title="Highlight scope doc"
    )
    highlight_id, _note_block_id = create_test_highlight_note(
        db_session, bootstrapped_user, media_id, body="highlight-scoped note"
    )
    add_context_edge(db_session, conversation_id, f"highlight:{highlight_id}")
    db_session.commit()

    resolved = _resolve_scope_uris(
        db_session, viewer_id=bootstrapped_user, conversation_id=conversation_id, scopes=[]
    )

    assert resolved == [f"conversation:{conversation_id}"], (
        f"highlight-only context must not fall back to global search; got {resolved}"
    )


def test_execute_app_search_error_output_escapes_attribute_quotes(
    db_session: Session,
    bootstrapped_user,
) -> None:
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=1,
        role="user",
        content="Find something",
    )
    assistant_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=2,
        role="assistant",
        content="",
        status="pending",
    )

    run = execute_app_search(
        db_session,
        viewer_id=bootstrapped_user,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        scopes=[],
        query="Find something",
        forced_error='bad "scope"',
    )

    assert run.status == "error"
    assert 'message="bad &quot;scope&quot;"' in run.context_text
    assert 'message="bad "scope""' not in run.context_text


@respx.mock
def test_execute_app_search_preserves_typed_provider_error_code(
    direct_db: DirectSessionManager,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = create_test_user_id()
    _use_openai_embedding_provider(monkeypatch)

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="Find typed provider failure",
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
        )
        session.commit()

        respx.post(OPENAI_EMBEDDINGS_URL).respond(
            500,
            json={"error": {"message": "provider unavailable"}},
        )
        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=[],
            query="typed provider failure",
        )

        assert run is not None
        assert run.tool_call_id is not None
        assert run.status == "error"
        assert run.error_code == ApiErrorCode.E_LLM_PROVIDER_DOWN.value

        tool_status, tool_error_code = session.execute(
            text(
                """
                SELECT status, error_code
                FROM message_tool_calls
                WHERE id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert tool_status == "error"
        assert tool_error_code == ApiErrorCode.E_LLM_PROVIDER_DOWN.value

    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_scoped_app_search_persists_no_indexed_evidence_as_empty_tool_result(
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
        add_context_edge(session, conversation_id, f"library:{library_id}")

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=[f"library:{library_id}"],
            query="indexed evidence",
        )

        assert run is not None
        assert run.tool_call_id is not None
        assert run.citations == []
        assert run.empty_status == "no_indexed_evidence"
        assert run.retrieval_result_event()["results"] == []
        assert 'status="no_indexed_evidence"' in run.context_text

        tool_row = session.execute(
            text(
                """
                SELECT result_refs, selected_context_refs
                FROM message_tool_calls
                WHERE id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert tool_row[0] == []
        assert tool_row[1] == []
        retrieval_count = session.execute(
            text(
                """
                SELECT
                    (SELECT count(*) FROM message_retrievals WHERE tool_call_id = :tool_call_id),
                    (
                        SELECT count(*)
                        FROM message_retrieval_candidate_ledgers
                        WHERE tool_call_id = :tool_call_id
                    )
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert tuple(retrieval_count) == (0, 0)

    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_scoped_app_search_persists_no_results_as_empty_tool_result(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()

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
        add_context_edge(session, conversation_id, f"library:{library_id}")

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=[f"library:{library_id}"],
            query="termthatdoesnotexist",
        )

        assert run is not None
        assert run.tool_call_id is not None
        assert run.citations == []
        assert run.empty_status == "no_results"
        assert run.retrieval_result_event()["results"] == []
        assert 'status="no_results"' in run.context_text
        assert 'status="no_indexed_evidence"' not in run.context_text
        assert 'filters="{}"' in run.context_text

        tool_row = session.execute(
            text(
                """
                SELECT result_refs, selected_context_refs
                FROM message_tool_calls
                WHERE id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert tool_row[0] == []
        assert tool_row[1] == []
        retrieval_count = session.execute(
            text(
                """
                SELECT
                    (SELECT count(*) FROM message_retrievals WHERE tool_call_id = :tool_call_id),
                    (
                        SELECT count(*)
                        FROM message_retrieval_candidate_ledgers
                        WHERE tool_call_id = :tool_call_id
                    )
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert tuple(retrieval_count) == (0, 0)

    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_execute_app_search_accepts_referenced_media_scope(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Media Scoped Search Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="Find media scoped evidence",
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
            title="Media Scope Needle",
        )
        add_context_edge(session, conversation_id, f"media:{media_id}")

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=[f"media:{media_id}"],
            query="Media Scope Needle",
        )

        assert run is not None
    assert run.status == "complete"
    assert run.empty_status is None
    assert run.citations
    assert all(citation.media_id == str(media_id) for citation in run.citations)
    assert "Media Scope Needle" in run.context_text

    direct_db.register_cleanup("resource_edges", "source_id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_execute_app_search_selects_highlight_result_as_prompt_evidence(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Highlight App Search Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="Find the saved highlight",
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
            title="Highlight Search Needle",
        )
        highlight_id, _note_block_id = create_test_highlight_note(
            session,
            user_id,
            media_id,
            body="Linked note for highlight search.",
        )

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=[],
            query="test exact",
        )

        assert run is not None
        assert run.status == "complete"
        assert run.selected_citations
        assert any(citation.result_type == "highlight" for citation in run.selected_citations)
        assert '<app_search_result type="highlight">' in run.context_text
        assert "<exact>test exact</exact>" in run.context_text

        retrieval_row = session.execute(
            text(
                """
                SELECT result_type, result_ref, exact_snippet, selected
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND result_type = 'highlight'
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert retrieval_row[0] == "highlight"
        assert retrieval_row[1]["type"] == "highlight"
        assert retrieval_row[1]["id"] == str(highlight_id)
        assert retrieval_row[1]["result_type"] == "highlight"
        assert retrieval_row[2]
        assert retrieval_row[3] is True

    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("highlights", "id", highlight_id)
    direct_db.register_cleanup("highlight_fragment_anchors", "highlight_id", highlight_id)
    direct_db.register_cleanup("pages", "user_id", user_id)
    direct_db.register_cleanup("note_blocks", "user_id", user_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)


def test_execute_app_search_cites_note_block_as_prompt_evidence(
    direct_db: DirectSessionManager,
) -> None:
    """AC-5: the AI cites your notes.

    A note-owned body matching the query is retrieved as a note_block result,
    selected into the prompt, rendered via _render_note_block_block, and persisted
    with a /notes/{block_id} deep link.
    """
    user_id = create_test_user_id()
    note_needle = f"noteneedle{uuid4().hex}"

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Note Citation App Search Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="What did my note say?",
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
            title="Note Citation Source",
        )
        highlight_id, note_block_id = create_test_highlight_note(
            session,
            user_id,
            media_id,
            body=f"{note_needle} the answer lives in this saved note body",
        )

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=[],
            query=note_needle,
        )

        assert run is not None
        assert run.status == "complete"

        note_citation = next(
            (c for c in run.selected_citations if c.result_type == "note_block"),
            None,
        )
        assert note_citation is not None, (
            f"Expected a selected note_block citation for note {note_block_id}; got "
            f"{[(c.result_type, c.source_id) for c in run.selected_citations]}"
        )
        assert note_citation.source_id == str(note_block_id)
        assert note_citation.context_ref == {
            "type": "note_block",
            "id": str(note_block_id),
        }
        assert note_citation.deep_link == f"/notes/{note_block_id}"
        assert note_citation.result_ref["type"] == "note_block"
        assert note_citation.result_ref["id"] == str(note_block_id)

        assert '<app_search_result type="note_block">' in run.context_text, (
            f"Expected the note_block render block in context_text; got {run.context_text}"
        )

        retrieval_row = session.execute(
            text(
                """
                SELECT result_type, result_ref, deep_link, selected
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND result_type = 'note_block'
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert retrieval_row[0] == "note_block"
        assert retrieval_row[1]["type"] == "note_block"
        assert retrieval_row[1]["id"] == str(note_block_id)
        assert retrieval_row[2] == f"/notes/{note_block_id}"
        assert retrieval_row[3] is True

    # Cleanup is LIFO (db.py: deleted in reverse of registration), so register parents
    # before children — users FIRST (deleted LAST) and the highlight_fragment_anchors LAST
    # (deleted FIRST). Note cleanup owns note bodies and note-owned content.
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("pages", "user_id", user_id)
    direct_db.register_cleanup("highlights", "user_id", user_id)
    direct_db.register_cleanup("highlight_fragment_anchors", "highlight_id", highlight_id)


def test_scoped_app_search_with_only_indexed_notes_is_no_results(
    direct_db: DirectSessionManager,
) -> None:
    """A scope that holds ONLY note-owned ready evidence — no indexed media — and a
    query that matches nothing is no_results, not no_indexed_evidence. Proves the
    note-owner union in _scoped_content_chunk_empty_status: a note in scope makes the scope
    'indexed'. The note is put in scope for a media: URI via a note_block->media
    resource_edge (the §4.6 note_block scope cell).
    """
    user_id = create_test_user_id()
    media_id = uuid4()
    page_id = uuid4()
    note_block_id = uuid4()

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Note Only Scope Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="Find note-only scoped evidence",
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
        )
        # An UNINDEXED media (no fragment, no media-owned content chunks) made visible via a
        # non-default library entry so it is a valid, in-scope reference.
        session.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES (:media_id, 'web_article', 'Unindexed Note Anchor', 'ready_for_reading',
                        :user_id)
                """
            ),
            {"media_id": media_id, "user_id": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO library_entries (library_id, media_id)
                VALUES (:library_id, :media_id)
                """
            ),
            {"library_id": library_id, "media_id": media_id},
        )
        # A note block indexed into the unified content pipeline.
        session.execute(
            text("INSERT INTO pages (id, user_id, title) VALUES (:page_id, :user_id, 'Notes')"),
            {"page_id": page_id, "user_id": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO note_blocks (
                    id, user_id, body_pm_json, body_text
                )
                VALUES (
                    :note_block_id, :user_id,
                    jsonb_build_object(
                        'type', 'paragraph',
                        'content', jsonb_build_array(
                            jsonb_build_object('type', 'text', 'text', CAST(:body_text AS text))
                        )
                    ),
                    :body_text
                )
                """
            ),
            {
                "note_block_id": note_block_id,
                "user_id": user_id,
                "body_text": "scoped note body about gardening tools and trellises",
            },
        )
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id, target_scheme,
                    target_id, source_order_key
                )
                VALUES (
                    :user_id, 'context', 'user', 'page', :page_id,
                    'note_block', :note_block_id, '0000000001'
                )
                """
            ),
            {"user_id": user_id, "page_id": page_id, "note_block_id": note_block_id},
        )
        highlight_id = uuid4()
        session.execute(
            text(
                """
                INSERT INTO highlights (
                    id, user_id, anchor_kind, anchor_media_id, color, exact, prefix, suffix
                )
                VALUES (
                    :highlight_id, :user_id, 'fragment_offsets', :media_id,
                    'yellow', 'exact', 'prefix', 'suffix'
                )
                """
            ),
            {"highlight_id": highlight_id, "user_id": user_id, "media_id": media_id},
        )
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id, target_scheme, target_id
                )
                VALUES (
                    :user_id, 'context', 'highlight_note', 'highlight', :highlight_id,
                    'note_block', :note_block_id
                )
                """
            ),
            {"user_id": user_id, "highlight_id": highlight_id, "note_block_id": note_block_id},
        )
        rebuild_note_content_index(session, note_block_id=note_block_id, reason="test")
        add_context_edge(session, conversation_id, f"media:{media_id}")

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=[f"media:{media_id}"],
            query="termthatmatchesnoindexednote",
        )

        assert run is not None
        assert run.citations == []
        assert run.empty_status == "no_results", (
            "scope holds ready-indexed note evidence, so an unmatched query must be "
            f"no_results; got {run.empty_status}"
        )
        assert 'status="no_results"' in run.context_text
        assert 'status="no_indexed_evidence"' not in run.context_text

    # Cleanup is LIFO (db.py: deleted in reverse of registration), so register parents
    # before children — users FIRST (deleted LAST). Note cleanup owns note content and
    # resource_edges owns the note_block->media edge.
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("resource_edges", "source_id", conversation_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("highlights", "user_id", user_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    direct_db.register_cleanup("note_blocks", "id", note_block_id)
    direct_db.register_cleanup("pages", "id", page_id)


def test_scoped_app_search_with_no_indexed_media_or_notes_is_no_indexed_evidence(
    direct_db: DirectSessionManager,
) -> None:
    """A scope with neither indexed media nor any in-scope indexed note is
    no_indexed_evidence (the negative side of the page-owner union: an unrelated note that
    is NOT linked into the scope does not make the scope 'indexed').
    """
    user_id = create_test_user_id()
    media_id = uuid4()
    page_id = uuid4()
    note_block_id = uuid4()

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "No Indexed Evidence Scope Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="Find scoped evidence",
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
        )
        # An UNINDEXED media (no media-owned content chunks), visible via a library entry.
        session.execute(
            text(
                """
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES (:media_id, 'web_article', 'Unindexed Empty Scope', 'ready_for_reading',
                        :user_id)
                """
            ),
            {"media_id": media_id, "user_id": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO library_entries (library_id, media_id)
                VALUES (:library_id, :media_id)
                """
            ),
            {"library_id": library_id, "media_id": media_id},
        )
        # An indexed note that exists but is NOT linked into this media scope, so
        # the note_block scope cell does not match it.
        session.execute(
            text("INSERT INTO pages (id, user_id, title) VALUES (:page_id, :user_id, 'Notes')"),
            {"page_id": page_id, "user_id": user_id},
        )
        session.execute(
            text(
                """
                INSERT INTO note_blocks (
                    id, user_id, body_pm_json, body_text
                )
                VALUES (
                    :note_block_id, :user_id,
                    jsonb_build_object(
                        'type', 'paragraph',
                        'content', jsonb_build_array(
                            jsonb_build_object('type', 'text', 'text', CAST(:body_text AS text))
                        )
                    ),
                    :body_text
                )
                """
            ),
            {
                "note_block_id": note_block_id,
                "user_id": user_id,
                "body_text": "unlinked note body not in any media scope",
            },
        )
        session.execute(
            text(
                """
                INSERT INTO resource_edges (
                    user_id, kind, origin, source_scheme, source_id, target_scheme,
                    target_id, source_order_key
                )
                VALUES (
                    :user_id, 'context', 'user', 'page', :page_id,
                    'note_block', :note_block_id, '0000000001'
                )
                """
            ),
            {"user_id": user_id, "page_id": page_id, "note_block_id": note_block_id},
        )
        rebuild_note_content_index(session, note_block_id=note_block_id, reason="test")
        add_context_edge(session, conversation_id, f"media:{media_id}")

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            scopes=[f"media:{media_id}"],
            query="anything",
        )

        assert run is not None
        assert run.citations == []
        assert run.empty_status == "no_indexed_evidence", (
            "scope has no indexed media and no in-scope note, so it must be "
            f"no_indexed_evidence; got {run.empty_status}"
        )
        assert 'status="no_indexed_evidence"' in run.context_text

    # Cleanup is LIFO (db.py: deleted in reverse of registration), so register parents
    # before children — users FIRST (deleted LAST). Note cleanup owns note content.
    direct_db.register_cleanup("users", "id", user_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("resource_edges", "source_id", conversation_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("note_blocks", "id", note_block_id)
    direct_db.register_cleanup("pages", "id", page_id)


def test_render_retrieved_context_requires_matching_current_evidence(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Agent Search Evidence Guard Library")
        media_id = create_searchable_media_in_library(
            session,
            user_id,
            library_id,
            title="Evidence Guard Needle",
        )
        row = session.execute(
            text(
                """
                SELECT cc.id,
                       cc.owner_id,
                       ccp.block_id
                FROM content_chunks cc
                JOIN content_chunk_parts ccp ON ccp.chunk_id = cc.id
                WHERE cc.owner_kind = 'media' AND cc.owner_id = :media_id
                ORDER BY cc.chunk_idx ASC, ccp.part_idx ASC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        ).one()
        span_text = "wrong current evidence"
        mismatch_span_id = session.execute(
            text(
                """
                INSERT INTO evidence_spans (
                    owner_kind,
                    owner_id,
                    start_block_id,
                    end_block_id,
                    start_block_offset,
                    end_block_offset,
                    span_text,
                    selector,
                    citation_label,
                    resolver_kind
                )
                VALUES (
                    'media',
                    :media_id,
                    :block_id,
                    :block_id,
                    0,
                    10,
                    :span_text,
                    '{}'::jsonb,
                    'Wrong Evidence',
                    'web'
                )
                RETURNING id
                """
            ),
            {
                "media_id": media_id,
                "block_id": row[2],
                "span_text": span_text,
            },
        ).scalar_one()
        citation = RetrievalCitation(
            result_type="content_chunk",
            source_id=str(row[0]),
            title="Evidence Guard Needle",
            source_label=None,
            snippet=span_text,
            deep_link="/media/test",
            citation_target=f"content_chunk:{row[0]}",
            citation_label="Wrong Evidence",
            locator=None,
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

        context_text, context_chars, selected, selection_reasons = render_retrieved_context_blocks(
            session,
            viewer_id=user_id,
            citations=[citation],
        )

        assert context_text == ""
        assert context_chars == 0
        assert selected == []
        assert selection_reasons == ["skipped_empty_render"]

    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)


def test_render_retrieved_context_skips_oversized_and_empty_candidates(
    db_session: Session,
    bootstrapped_user,
) -> None:
    library_id = create_test_library(db_session, bootstrapped_user, "Oversized Packer Library")
    oversized = _media_citation(
        str(
            _create_media_with_ready_summary(
                db_session,
                bootstrapped_user,
                library_id,
                title="Oversized render media",
                summary_md="x" * APP_SEARCH_CONTEXT_CHARS,
            )
        )
    )
    oversized.selected = True
    empty = _page_citation(uuid4())
    empty.selected = True
    fitting = _page_citation(_create_page(db_session, bootstrapped_user, "Fitting render page"))

    context_text, context_chars, selected, selection_reasons = render_retrieved_context_blocks(
        db_session,
        viewer_id=bootstrapped_user,
        citations=[oversized, empty, fitting],
    )

    assert "Fitting render page" in context_text
    assert context_chars == len(context_text)
    assert selected == [fitting]
    assert fitting.selected is True
    assert oversized.selected is False
    assert empty.selected is False
    assert selection_reasons == [
        "skipped_over_budget",
        "skipped_empty_render",
        "selected_within_budget",
    ]


def test_render_retrieved_context_counts_join_separators_against_budget(
    db_session: Session,
    bootstrapped_user,
) -> None:
    note_wrapper_chars = len(
        '<app_search_result type="note_block">\n<content></content>\n</app_search_result>'
    )
    first = _note_block_citation(
        _create_note_block(
            db_session,
            bootstrapped_user,
            "x" * (APP_SEARCH_CONTEXT_CHARS - note_wrapper_chars - 1),
        )
    )
    second = _page_citation(_create_page(db_session, bootstrapped_user, "Separator page"))

    context_text, context_chars, selected, selection_reasons = render_retrieved_context_blocks(
        db_session,
        viewer_id=bootstrapped_user,
        citations=[first, second],
    )

    assert context_chars == len(context_text)
    assert context_chars == APP_SEARCH_CONTEXT_CHARS - 1
    assert len(context_text) <= APP_SEARCH_CONTEXT_CHARS
    assert selected == [first]
    assert selection_reasons == ["selected_within_budget", "skipped_over_budget"]


def test_render_retrieved_context_ledgers_selected_limit(
    db_session: Session,
    bootstrapped_user,
) -> None:
    citations = [
        _page_citation(_create_page(db_session, bootstrapped_user, f"Limit page {index}"))
        for index in range(APP_SEARCH_SELECTED_LIMIT + 1)
    ]

    context_text, context_chars, selected, selection_reasons = render_retrieved_context_blocks(
        db_session,
        viewer_id=bootstrapped_user,
        citations=citations,
    )

    assert context_chars == len(context_text)
    assert len(selected) == APP_SEARCH_SELECTED_LIMIT
    assert selected == citations[:APP_SEARCH_SELECTED_LIMIT]
    assert citations[-1].selected is False
    assert selection_reasons == ["selected_within_budget"] * APP_SEARCH_SELECTED_LIMIT + [
        "skipped_selected_limit"
    ]
