"""DB-backed tests for the server-built chat citation read-model (S7).

``build_citation_outs_for_message`` / ``_for_messages`` map an assistant message's
selected, cited ``message_retrievals`` into the shared ``CitationOut`` shape (the
same render contract the frontend used to build). ``MessageOut.citations`` is then
populated on every read path (single message, list, chat-run response, branch).

These run on the ``db_session`` savepoint fixture: the producer only reads, and
``_ready_unit_media`` already drives a real per-media unit build (so
``get_ready_summaries`` finds a fresh ready ``media_summaries`` head).
"""

from __future__ import annotations

import json
from collections.abc import Generator
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import clear_settings_cache
from nexus.services.agent_tools.web_search import WebSearchCitation
from nexus.services.conversation_branches import _message_outs_by_id
from nexus.services.conversations import list_messages, message_to_out
from nexus.services.retrieval_citation import (
    build_citation_outs_for_message,
    build_citation_outs_for_messages,
)
from tests.factories import (
    create_searchable_media_in_library,
    create_test_conversation,
    create_test_message,
    get_user_default_library,
)
from tests.test_library_intelligence import _create_owner, _ready_unit_media

pytestmark = pytest.mark.integration


@pytest.fixture
def anthropic_platform_key(monkeypatch: pytest.MonkeyPatch) -> Generator[None, None, None]:
    """``run_media_unit_build`` resolves a platform key for the pinned provider.

    Mirrors the precondition the per-media unit build asserts in
    ``test_library_intelligence``; requested only by the one test that builds a
    real ready unit.
    """
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-platform-anthropic")
    clear_settings_cache()
    yield
    clear_settings_cache()


@pytest.fixture
def fake_unit_rate_limiter(monkeypatch: pytest.MonkeyPatch) -> None:
    """Swap the worker rate limiter for a no-op so the unit build's budget
    envelope never blocks (the ledger calls are immaterial here)."""

    class _NoopRateLimiter:
        def acquire_inflight_slot(self, _user_id: UUID) -> None: ...
        def release_inflight_slot(self, _user_id: UUID) -> None: ...
        def reserve_token_budget(
            self, _user_id: UUID, _reservation_id: UUID, _est: int, ttl: int = 300
        ) -> None: ...
        def commit_token_budget(
            self, _user_id: UUID, _reservation_id: UUID, _actual: int
        ) -> None: ...

        def release_token_budget(self, _user_id: UUID, _reservation_id: UUID) -> None: ...

    monkeypatch.setattr(
        "nexus.services.media_intelligence.get_rate_limiter", lambda: _NoopRateLimiter()
    )


def _seed_tool_call(
    db: Session, *, conversation_id: UUID, user_mid: UUID, assistant_mid: UUID
) -> UUID:
    tool_call_id = uuid4()
    db.execute(
        text(
            """
            INSERT INTO message_tool_calls (
                id, conversation_id, user_message_id, assistant_message_id,
                tool_name, tool_call_index, query_hash, scope, requested_types, status
            )
            VALUES (
                :id, :cid, :umid, :amid, 'app_search', 1, 'sha-msg-cit', 'all',
                '["content_chunk"]'::jsonb, 'complete'
            )
            """
        ),
        {"id": tool_call_id, "cid": conversation_id, "umid": user_mid, "amid": assistant_mid},
    )
    return tool_call_id


def _seed_retrieval(
    db: Session,
    *,
    tool_call_id: UUID,
    ordinal: int,
    citation_ordinal: int | None,
    result_type: str,
    source_id: str,
    media_id: UUID | None = None,
    evidence_span_id: UUID | None = None,
    locator: dict | None = None,
    selected: bool = True,
    source_title: str = "Title",
    exact_snippet: str = "snippet",
    section_label: str | None = "Section 1",
    deep_link: str | None = "/media/x",
) -> None:
    db.execute(
        text(
            """
            INSERT INTO message_retrievals (
                tool_call_id, ordinal, result_type, source_id, media_id, evidence_span_id,
                scope, context_ref, result_ref, deep_link, selected, source_title,
                section_label, exact_snippet, locator, retrieval_status, citation_ordinal
            )
            VALUES (
                :tool_call_id, :ordinal, :result_type, :source_id, :media_id, :evidence_span_id,
                'all', CAST(:context_ref AS jsonb), CAST(:result_ref AS jsonb), :deep_link,
                :selected, :source_title, :section_label, :exact_snippet,
                CAST(:locator AS jsonb), 'retrieved', :citation_ordinal
            )
            """
        ),
        {
            "tool_call_id": tool_call_id,
            "ordinal": ordinal,
            "result_type": result_type,
            "source_id": source_id,
            "media_id": media_id,
            "evidence_span_id": evidence_span_id,
            "context_ref": json.dumps({"type": result_type, "id": source_id}),
            "result_ref": json.dumps({"id": source_id}),
            "deep_link": deep_link,
            "selected": selected,
            "source_title": source_title,
            "section_label": section_label,
            "exact_snippet": exact_snippet,
            "locator": json.dumps(locator) if locator is not None else None,
            "citation_ordinal": citation_ordinal,
        },
    )


def _seed_evidence_span(db: Session, *, span_id: UUID, media_id: UUID) -> None:
    """Create a real ``evidence_spans`` row so the FK on ``message_retrievals`` holds.

    Anchors to the first content block of ``media_id`` (created by
    ``create_searchable_media_in_library``); minimal columns mirror
    ``tests/test_migrations.py``'s minimal-span insert.
    """
    block_id = db.execute(
        text(
            """
            SELECT id FROM content_blocks
            WHERE owner_kind = 'media' AND owner_id = :media_id
            ORDER BY block_idx ASC
            LIMIT 1
            """
        ),
        {"media_id": media_id},
    ).scalar_one()
    db.execute(
        text(
            """
            INSERT INTO evidence_spans (
                id, owner_kind, owner_id, start_block_id, end_block_id,
                start_block_offset, end_block_offset, span_text, selector,
                citation_label, resolver_kind
            )
            VALUES (
                :span_id, 'media', :media_id, :block_id, :block_id,
                0, 10, 'span text', '{}'::jsonb, 'Section 1', 'web'
            )
            """
        ),
        {"span_id": span_id, "media_id": media_id, "block_id": block_id},
    )


def _conversation_with_assistant(db: Session, user_id: UUID) -> tuple[UUID, UUID, UUID]:
    conversation_id = create_test_conversation(db, user_id)
    user_mid = create_test_message(db, conversation_id, 1, "user", "Ask")
    assistant_mid = create_test_message(
        db, conversation_id, 2, "assistant", "Answer [1].", parent_message_id=user_mid
    )
    return conversation_id, user_mid, assistant_mid


class TestBuildCitationOutsForMessage:
    def test_empty_when_no_cited_retrievals(self, db_session: Session) -> None:
        user_id = _create_owner(db_session)
        _cid, _umid, assistant_mid = _conversation_with_assistant(db_session, user_id)
        assert build_citation_outs_for_message(db_session, assistant_message_id=assistant_mid) == []

    def test_maps_target_refs_and_orders_by_ordinal(self, db_session: Session) -> None:
        user_id = _create_owner(db_session)
        library_id = get_user_default_library(db_session, user_id)
        assert library_id is not None
        media_id = create_searchable_media_in_library(
            db_session, user_id, library_id, title="Target media"
        )
        cid, umid, assistant_mid = _conversation_with_assistant(db_session, user_id)
        tool_call_id = _seed_tool_call(
            db_session, conversation_id=cid, user_mid=umid, assistant_mid=assistant_mid
        )
        span_id = uuid4()
        fragment_id = uuid4()
        chunk_id = uuid4()
        # The evidence_span_id FK is real: create the span over the media's content
        # before the retrieval row references it.
        _seed_evidence_span(db_session, span_id=span_id, media_id=media_id)
        # Out of citation-ordinal order on purpose to prove ORDER BY.
        _seed_retrieval(
            db_session,
            tool_call_id=tool_call_id,
            ordinal=0,
            citation_ordinal=2,
            result_type="content_chunk",
            source_id=str(chunk_id),
        )
        _seed_retrieval(
            db_session,
            tool_call_id=tool_call_id,
            ordinal=1,
            citation_ordinal=1,
            result_type="evidence_span",
            source_id=str(span_id),
            media_id=media_id,
            evidence_span_id=span_id,
            locator={
                "type": "web_text_offsets",
                "media_id": str(media_id),
                "fragment_id": str(fragment_id),
                "start_offset": 0,
                "end_offset": 10,
            },
        )
        # Retrieved-but-uncited row must NOT appear.
        _seed_retrieval(
            db_session,
            tool_call_id=tool_call_id,
            ordinal=2,
            citation_ordinal=None,
            result_type="content_chunk",
            source_id=str(uuid4()),
        )

        outs = build_citation_outs_for_message(db_session, assistant_message_id=assistant_mid)

        assert [c.ordinal for c in outs] == [1, 2]
        evidence, chunk = outs
        assert evidence.target_ref.type == "evidence_span"
        assert evidence.target_ref.id == span_id
        assert evidence.media_id == media_id  # row media_id wins
        assert evidence.locator is not None and evidence.locator.type == "web_text_offsets"
        assert evidence.snapshot is not None and evidence.snapshot.section_label == "Section 1"
        assert chunk.target_ref.type == "content_chunk"
        assert chunk.target_ref.id == chunk_id
        assert chunk.snapshot is not None and chunk.snapshot.summary_md is None

    def test_media_target_hoists_media_id_from_locator_when_row_null(
        self, db_session: Session
    ) -> None:
        user_id = _create_owner(db_session)
        library_id = get_user_default_library(db_session, user_id)
        assert library_id is not None
        media_id = create_searchable_media_in_library(
            db_session, user_id, library_id, title="Loc media"
        )
        cid, umid, assistant_mid = _conversation_with_assistant(db_session, user_id)
        tool_call_id = _seed_tool_call(
            db_session, conversation_id=cid, user_mid=umid, assistant_mid=assistant_mid
        )
        _seed_retrieval(
            db_session,
            tool_call_id=tool_call_id,
            ordinal=0,
            citation_ordinal=1,
            result_type="content_chunk",
            source_id=str(uuid4()),
            media_id=None,
            locator={
                "type": "web_text_offsets",
                "media_id": str(media_id),
                "fragment_id": str(uuid4()),
                "start_offset": 1,
                "end_offset": 5,
            },
        )
        (out,) = build_citation_outs_for_message(db_session, assistant_message_id=assistant_mid)
        assert out.media_id == media_id

    @pytest.mark.usefixtures("anthropic_platform_key", "fake_unit_rate_limiter")
    def test_summary_md_populated_for_media_targets_only(self, db_session: Session) -> None:
        owner_id = _create_owner(db_session)
        library_id = get_user_default_library(db_session, owner_id)
        assert library_id is not None
        # A media whose per-media unit is built + ready, so get_ready_summaries returns it.
        media_id = _ready_unit_media(db_session, owner_id, library_id, title="Summarized")
        cid, umid, assistant_mid = _conversation_with_assistant(db_session, owner_id)
        tool_call_id = _seed_tool_call(
            db_session, conversation_id=cid, user_mid=umid, assistant_mid=assistant_mid
        )
        _seed_retrieval(
            db_session,
            tool_call_id=tool_call_id,
            ordinal=0,
            citation_ordinal=1,
            result_type="media",
            source_id=str(media_id),
            media_id=media_id,
        )
        # A content_chunk on the same media: still no summary_md (non-media target).
        _seed_retrieval(
            db_session,
            tool_call_id=tool_call_id,
            ordinal=1,
            citation_ordinal=2,
            result_type="content_chunk",
            source_id=str(uuid4()),
            media_id=media_id,
        )

        media_out, chunk_out = build_citation_outs_for_message(
            db_session, assistant_message_id=assistant_mid
        )
        assert media_out.target_ref.type == "media"
        assert media_out.snapshot is not None
        assert media_out.snapshot.summary_md == "Abstract of Summarized."
        assert chunk_out.snapshot is not None and chunk_out.snapshot.summary_md is None

    def test_batched_groups_by_message_and_isolates(self, db_session: Session) -> None:
        user_id = _create_owner(db_session)
        cid_a, umid_a, amid_a = _conversation_with_assistant(db_session, user_id)
        # second assistant turn in the same conversation
        umid_b = create_test_message(
            db_session, cid_a, 3, "user", "Again", parent_message_id=amid_a
        )
        amid_b = create_test_message(
            db_session, cid_a, 4, "assistant", "Answer [1].", parent_message_id=umid_b
        )
        tc_a = _seed_tool_call(
            db_session, conversation_id=cid_a, user_mid=umid_a, assistant_mid=amid_a
        )
        tc_b = _seed_tool_call(
            db_session, conversation_id=cid_a, user_mid=umid_b, assistant_mid=amid_b
        )
        _seed_retrieval(
            db_session,
            tool_call_id=tc_a,
            ordinal=0,
            citation_ordinal=1,
            result_type="content_chunk",
            source_id=str(uuid4()),
        )
        _seed_retrieval(
            db_session,
            tool_call_id=tc_b,
            ordinal=0,
            citation_ordinal=1,
            result_type="content_chunk",
            source_id=str(uuid4()),
        )
        _seed_retrieval(
            db_session,
            tool_call_id=tc_b,
            ordinal=1,
            citation_ordinal=2,
            result_type="content_chunk",
            source_id=str(uuid4()),
        )

        result = build_citation_outs_for_messages(
            db_session, assistant_message_ids=[amid_a, amid_b]
        )
        assert {k: len(v) for k, v in result.items()} == {amid_a: 1, amid_b: 2}

    def test_batched_empty_for_no_ids(self, db_session: Session) -> None:
        assert build_citation_outs_for_messages(db_session, assistant_message_ids=[]) == {}


class TestMessageOutCitationsOnReadPaths:
    def _seed_one_cited_chunk(self, db_session: Session, user_id: UUID) -> tuple[UUID, UUID, UUID]:
        cid, umid, amid = _conversation_with_assistant(db_session, user_id)
        tool_call_id = _seed_tool_call(
            db_session, conversation_id=cid, user_mid=umid, assistant_mid=amid
        )
        _seed_retrieval(
            db_session,
            tool_call_id=tool_call_id,
            ordinal=0,
            citation_ordinal=1,
            result_type="content_chunk",
            source_id=str(uuid4()),
        )
        return cid, umid, amid

    def test_message_to_out_is_pure_and_threads_citations(self, db_session: Session) -> None:
        from nexus.db.models import Message

        user_id = _create_owner(db_session)
        _cid, umid, amid = self._seed_one_cited_chunk(db_session, user_id)
        assistant = db_session.get(Message, amid)
        assert assistant is not None
        outs = build_citation_outs_for_message(db_session, assistant_message_id=amid)
        # Pure mapper: same ORM row, citations only present when the caller passes them.
        assert message_to_out(assistant).citations == []
        assert [c.ordinal for c in message_to_out(assistant, citations=outs).citations] == [1]

    def test_list_path_populates_assistant_only(self, db_session: Session) -> None:
        user_id = _create_owner(db_session)
        cid, umid, amid = self._seed_one_cited_chunk(db_session, user_id)

        messages, _info = list_messages(db_session, user_id, cid)
        by_id = {m.id: m for m in messages}
        assert [c.ordinal for c in by_id[amid].citations] == [1]
        assert by_id[umid].citations == []  # user message carries none

    def test_branch_path_populates_assistant_only(self, db_session: Session) -> None:
        from nexus.db.models import Message

        user_id = _create_owner(db_session)
        _cid, umid, amid = self._seed_one_cited_chunk(db_session, user_id)
        messages = [db_session.get(Message, umid), db_session.get(Message, amid)]
        outs_by_id = _message_outs_by_id(
            db_session, user_id, [m for m in messages if m is not None]
        )
        assert [c.ordinal for c in outs_by_id[amid].citations] == [1]
        assert outs_by_id[umid].citations == []


def test_chat_run_response_populates_assistant_citations(db_session: Session) -> None:
    from nexus.db.models import ChatRun
    from nexus.services.chat_run_response import build_chat_run_response
    from tests.factories import create_test_model

    user_id = _create_owner(db_session)
    cid = create_test_conversation(db_session, user_id)
    umid = create_test_message(db_session, cid, 1, "user", "Ask")
    amid = create_test_message(
        db_session, cid, 2, "assistant", "Answer [1].", parent_message_id=umid
    )
    tool_call_id = _seed_tool_call(
        db_session, conversation_id=cid, user_mid=umid, assistant_mid=amid
    )
    _seed_retrieval(
        db_session,
        tool_call_id=tool_call_id,
        ordinal=0,
        citation_ordinal=1,
        result_type="content_chunk",
        source_id=str(uuid4()),
    )
    model_id = create_test_model(db_session)
    run = ChatRun(
        id=uuid4(),
        owner_user_id=user_id,
        conversation_id=cid,
        user_message_id=umid,
        assistant_message_id=amid,
        idempotency_key=f"resp-{uuid4()}",
        payload_hash="hash",
        status="complete",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
    )
    db_session.add(run)
    db_session.flush()

    response = build_chat_run_response(db_session, user_id, run)
    assert [c.ordinal for c in response.assistant_message.citations] == [1]
    assert response.user_message.citations == []


def _web_search_citation(rank: int) -> WebSearchCitation:
    return WebSearchCitation(
        result_ref=f"web:r{rank}",
        title=f"Result {rank}",
        url=f"https://example.test/{rank}",
        display_url=f"example.test/{rank}",
        snippet=f"snippet {rank}",
        extra_snippets=(),
        published_at=None,
        source_name="Example",
        rank=rank,
        provider="brave",
        provider_request_id="req-x",
    )


def test_web_search_fold_routes_through_insert_retrieval_row(db_session: Session) -> None:
    """The web_search fold persists rows via ``insert_retrieval_row`` (the sole writer).

    Pinned deltas vs. the deleted hand-rolled SQL: ``scope='public_web'`` (was the
    'all' column default) and rows pass the strict ``WebRetrievalResultRef`` validator.
    """
    from nexus.services.agent_tools.web_search import WebSearchRun, persist_web_search_run

    user_id = _create_owner(db_session)
    cid = create_test_conversation(db_session, user_id)
    umid = create_test_message(db_session, cid, 1, "user", "Ask the web")
    amid = create_test_message(
        db_session, cid, 2, "assistant", "", status="pending", parent_message_id=umid
    )

    selected = _web_search_citation(1)
    other = _web_search_citation(2)
    run = WebSearchRun(
        conversation_id=cid,
        user_message_id=umid,
        assistant_message_id=amid,
        query_hash="qh",
        result_type="web",
        requested_freshness_days=None,
        requested_domains={},
        citations=[selected, other],
        selected_citations=[selected],
        context_text="ctx",
        context_chars=3,
        latency_ms=5,
        status="complete",
        provider_request_ids=["req-x"],
    )
    persist_web_search_run(db_session, run)

    rows = (
        db_session.execute(
            text(
                """
            SELECT mr.ordinal, mr.scope, mr.retrieval_status, mr.result_type,
                   mr.source_id, mr.selected, mr.result_ref, mr.media_id
            FROM message_retrievals mr
            JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
            WHERE mtc.assistant_message_id = :amid
            ORDER BY mr.ordinal
            """
            ),
            {"amid": amid},
        )
        .mappings()
        .all()
    )

    assert [r["source_id"] for r in rows] == ["web:r1", "web:r2"]
    assert {r["scope"] for r in rows} == {"public_web"}
    assert {r["retrieval_status"] for r in rows} == {"web_result"}
    assert [r["selected"] for r in rows] == [True, False]
    assert all(r["media_id"] is None for r in rows)
    # The full validated WebRetrievalResultRef shape is what insert_retrieval_row wrote.
    assert rows[0]["result_ref"]["type"] == "web_result"
    assert rows[0]["result_ref"]["url"] == "https://example.test/1"
    assert rows[0]["result_ref"]["context_ref"] == {"type": "web_result", "id": "web:r1"}
